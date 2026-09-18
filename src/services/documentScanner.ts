/**
 * Document scanning with OpenCV.js, entirely in the browser.
 *
 * detectDocument  — finds the page outline (four corners) in a frame.
 * flattenDocument — crops and perspective-corrects the page from the
 *                   full-resolution original using those corners.
 * applyScanMode   — optional finish: original, enhanced, grayscale, B&W.
 *
 * Detection is meant to run on a downscaled frame for speed; callers map the
 * corners back to the original resolution before flattening, so the saved
 * document keeps every pixel the camera captured.
 */

import type { OpenCv } from './opencvLoader';
import {
  type FrameMeasurements,
  type Quad,
  isReasonableQuad,
  orderCorners,
  outputSize,
} from './scanGeometry';

export type ScanMode = 'original' | 'enhanced' | 'grayscale' | 'bw';
/** What gets saved: the whole photo (default, nothing cropped away) or the flattened page. */
export type ScanOutput = 'full' | 'cropped';
export const SCAN_MODES: ScanMode[] = ['original', 'enhanced', 'grayscale', 'bw'];

/** Long side, in pixels, of the frame used for live detection. */
export const LIVE_DETECTION_SIDE = 640;
/** Long side used when detecting on a captured or uploaded still. */
export const STILL_DETECTION_SIDE = 1000;

// ---------------------------------------------------------------------------
// Canvas helpers
// ---------------------------------------------------------------------------

export function makeCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  // OpenCV reads pixels back from every canvas it touches; creating the
  // context with this hint first keeps those reads fast on phones.
  canvas.getContext('2d', { willReadFrequently: true });
  return canvas;
}

/**
 * Draws `source` into a canvas no larger than `maxSide` on its long side.
 * Returns the canvas and the factor that maps its coordinates back to the
 * source (multiply by `toSource`).
 */
export function downscale(
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  maxSide: number,
  reuse?: HTMLCanvasElement
): { canvas: HTMLCanvasElement; toSource: number } {
  const scale = Math.min(1, maxSide / Math.max(sourceWidth, sourceHeight));
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));
  const canvas = reuse ?? makeCanvas(width, height);
  if (reuse && !reuse.dataset.readHint) {
    reuse.getContext('2d', { willReadFrequently: true });
    reuse.dataset.readHint = 'true';
  }
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(source, 0, 0, width, height);
  return { canvas, toSource: sourceWidth / width };
}

export function canvasToBlob(canvas: HTMLCanvasElement, type = 'image/jpeg', quality = 0.92): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Could not encode image'))), type, quality);
  });
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/** Frees OpenCV objects whatever happens; WebAssembly memory is not garbage-collected. */
function release(...mats: Array<{ delete: () => void } | null | undefined>): void {
  for (const mat of mats) {
    try {
      mat?.delete();
    } catch {
      /* already freed */
    }
  }
}

/** Median of an 8-bit single-channel buffer, via a histogram. */
function median(data: Uint8Array): number {
  const histogram = new Uint32Array(256);
  for (let i = 0; i < data.length; i++) histogram[data[i]]++;
  const half = data.length / 2;
  let seen = 0;
  for (let value = 0; value < 256; value++) {
    seen += histogram[value];
    if (seen >= half) return value;
  }
  return 127;
}

/**
 * Finds the largest contour that simplifies to a plausible four-cornered page.
 * Each candidate's convex hull is simplified at increasing tolerances, which
 * copes with slightly rounded corners and small bites taken out by fingers.
 */
function largestPageContour(cv: OpenCv, binary: OpenCv, width: number, height: number, mode: number): Quad | null {
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  try {
    cv.findContours(binary, contours, hierarchy, mode, cv.CHAIN_APPROX_SIMPLE);

    const minArea = width * height * 0.08;
    const candidates: Array<{ index: number; area: number }> = [];
    for (let i = 0; i < contours.size(); i++) {
      const contour = contours.get(i);
      const area = cv.contourArea(contour);
      contour.delete();
      if (area >= minArea) candidates.push({ index: i, area });
    }
    candidates.sort((a, b) => b.area - a.area);

    for (const { index } of candidates.slice(0, 8)) {
      const contour = contours.get(index);
      const hull = new cv.Mat();
      try {
        cv.convexHull(contour, hull, false, true);
        const perimeter = cv.arcLength(hull, true);
        for (const epsilon of [0.02, 0.03, 0.045, 0.06]) {
          const approx = new cv.Mat();
          try {
            cv.approxPolyDP(hull, approx, epsilon * perimeter, true);
            if (approx.rows !== 4) continue;
            const points = [];
            for (let p = 0; p < 4; p++) {
              points.push({ x: approx.data32S[p * 2], y: approx.data32S[p * 2 + 1] });
            }
            const quad = orderCorners(points);
            if (isReasonableQuad(quad, width, height)) return quad;
          } finally {
            approx.delete();
          }
        }
      } finally {
        release(contour, hull);
      }
    }
    return null;
  } finally {
    release(contours, hierarchy);
  }
}

/**
 * Detects the document in a (typically downscaled) canvas and measures the
 * frame for guidance. Corners are in that canvas's coordinates.
 *
 * Pipeline: grayscale → Gaussian blur → Canny → dilate → contours → largest
 * convex four-sided outline. If edges alone do not close into a page (low
 * contrast, busy background), a second pass separates the page by Otsu
 * threshold and morphological closing.
 */
export function detectDocument(cv: OpenCv, canvas: HTMLCanvasElement): FrameMeasurements {
  const { width, height } = canvas;
  const src = cv.imread(canvas);
  const gray = new cv.Mat();
  const blurred = new cv.Mat();
  const edges = new cv.Mat();
  const laplacian = new cv.Mat();
  const mean = new cv.Mat();
  const stddev = new cv.Mat();
  const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
  const thresholded = new cv.Mat();
  const closeKernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(9, 9));

  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);

    const brightness = cv.mean(gray)[0];
    cv.Laplacian(gray, laplacian, cv.CV_64F);
    cv.meanStdDev(laplacian, mean, stddev);
    const sharpness = stddev.data64F[0] ** 2;

    cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);

    // Canny thresholds relative to the frame's median, so detection adapts
    // to lighting instead of relying on fixed numbers.
    const med = median(blurred.data as Uint8Array);
    const lower = Math.max(15, 0.25 * med);
    const upper = Math.max(lower + 30, Math.min(200, 0.6 * med));
    cv.Canny(blurred, edges, lower, upper);
    cv.dilate(edges, edges, kernel, new cv.Point(-1, -1), 1);

    let quad = largestPageContour(cv, edges, width, height, cv.RETR_LIST);

    if (!quad) {
      cv.threshold(blurred, thresholded, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
      cv.morphologyEx(thresholded, thresholded, cv.MORPH_CLOSE, closeKernel);
      quad = largestPageContour(cv, thresholded, width, height, cv.RETR_EXTERNAL);
    }

    return { quad, frameWidth: width, frameHeight: height, brightness, sharpness };
  } finally {
    release(src, gray, blurred, edges, laplacian, mean, stddev, kernel, thresholded, closeKernel);
  }
}

// ---------------------------------------------------------------------------
// Perspective correction
// ---------------------------------------------------------------------------

/**
 * Crops the page out of `source` and maps it to a flat rectangle. `quad` must
 * be in `source` pixel coordinates. The output size comes from the corners, so
 * the page keeps its real proportions.
 */
export function flattenDocument(cv: OpenCv, source: HTMLCanvasElement, quad: Quad): HTMLCanvasElement {
  const ordered = orderCorners(quad);
  const { width, height } = outputSize(ordered, source.width, source.height);
  const [tl, tr, br, bl] = ordered;

  const src = cv.imread(source);
  const dst = new cv.Mat();
  const from = cv.matFromArray(4, 1, cv.CV_32FC2, [tl.x, tl.y, tr.x, tr.y, br.x, br.y, bl.x, bl.y]);
  const to = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, width - 1, 0, width - 1, height - 1, 0, height - 1]);
  const transform = cv.getPerspectiveTransform(from, to);

  try {
    cv.warpPerspective(
      src,
      dst,
      transform,
      new cv.Size(width, height),
      cv.INTER_LINEAR,
      cv.BORDER_REPLICATE,
      new cv.Scalar()
    );
    const out = makeCanvas(width, height);
    cv.imshow(out, dst);
    return out;
  } finally {
    release(src, dst, from, to, transform);
  }
}

// ---------------------------------------------------------------------------
// Finishing modes
// ---------------------------------------------------------------------------

/**
 * Applies a finishing mode to a flattened page and returns a new canvas; the
 * input is never modified. "Enhanced" is deliberately mild — local contrast
 * and a light sharpen — so the page still looks like the original document.
 */
export function applyScanMode(cv: OpenCv, canvas: HTMLCanvasElement, mode: ScanMode): HTMLCanvasElement {
  if (mode === 'original') return canvas;

  const src = cv.imread(canvas);
  const out = makeCanvas(canvas.width, canvas.height);
  const mats: Array<{ delete: () => void }> = [src];
  const track = <T extends { delete: () => void }>(mat: T): T => {
    mats.push(mat);
    return mat;
  };

  try {
    if (mode === 'grayscale') {
      const gray = track(new cv.Mat());
      const rgba = track(new cv.Mat());
      cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
      cv.cvtColor(gray, rgba, cv.COLOR_GRAY2RGBA);
      cv.imshow(out, rgba);
      return out;
    }

    if (mode === 'bw') {
      const gray = track(new cv.Mat());
      const smooth = track(new cv.Mat());
      const binary = track(new cv.Mat());
      const rgba = track(new cv.Mat());
      cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
      cv.medianBlur(gray, smooth, 3);
      // Block size scales with the page so strokes survive on any resolution.
      let block = Math.round(Math.min(canvas.width, canvas.height) / 40);
      block = Math.max(15, block % 2 === 0 ? block + 1 : block);
      cv.adaptiveThreshold(smooth, binary, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, block, 12);
      cv.cvtColor(binary, rgba, cv.COLOR_GRAY2RGBA);
      cv.imshow(out, rgba);
      return out;
    }

    // enhanced
    const rgb = track(new cv.Mat());
    const lab = track(new cv.Mat());
    const channels = track(new cv.MatVector());
    const merged = track(new cv.Mat());
    const back = track(new cv.Mat());
    const blurred = track(new cv.Mat());
    const sharpened = track(new cv.Mat());
    const rgba = track(new cv.Mat());

    cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);
    cv.cvtColor(rgb, lab, cv.COLOR_RGB2Lab);
    cv.split(lab, channels);
    const lightness = track(channels.get(0));
    const equalised = track(new cv.Mat());
    const clahe = track(new cv.CLAHE(2.0, new cv.Size(8, 8)));
    clahe.apply(lightness, equalised);
    channels.set(0, equalised);
    cv.merge(channels, merged);
    cv.cvtColor(merged, back, cv.COLOR_Lab2RGB);
    cv.GaussianBlur(back, blurred, new cv.Size(0, 0), 1.2);
    cv.addWeighted(back, 1.35, blurred, -0.35, 0, sharpened);
    cv.cvtColor(sharpened, rgba, cv.COLOR_RGB2RGBA);
    cv.imshow(out, rgba);
    return out;
  } finally {
    release(...mats);
  }
}
