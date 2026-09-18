/**
 * Geometry and guidance for the document scanner.
 *
 * Everything here is plain arithmetic with no OpenCV and no DOM, so it can be
 * unit-tested directly and reused by both the live camera loop and the
 * after-capture corner editor.
 */

export interface Point {
  x: number;
  y: number;
}

/** Four corners, always in the order top-left, top-right, bottom-right, bottom-left. */
export type Quad = [Point, Point, Point, Point];

/** Largest side, in pixels, of a scanned output image. Keeps memory bounded on phones. */
export const MAX_OUTPUT_SIDE = 4096;

export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * Orders four points as top-left, top-right, bottom-right, bottom-left.
 *
 * Points are first sorted by angle around their centroid, which gives a
 * consistent winding even for a strongly tilted page; the winding is then
 * rotated so it starts at the point nearest the image's top-left. This avoids
 * the classic x+y / x−y shortcut, which mis-orders pages held near 45°.
 */
export function orderCorners(points: Point[]): Quad {
  if (points.length !== 4) throw new Error('orderCorners needs exactly four points');

  const cx = points.reduce((sum, p) => sum + p.x, 0) / 4;
  const cy = points.reduce((sum, p) => sum + p.y, 0) / 4;

  // Screen coordinates (y down): increasing atan2 runs clockwise on screen,
  // i.e. TL → TR → BR → BL.
  const clockwise = [...points].sort(
    (a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx)
  );

  let start = 0;
  for (let i = 1; i < 4; i++) {
    if (clockwise[i].x + clockwise[i].y < clockwise[start].x + clockwise[start].y) start = i;
  }

  return [0, 1, 2, 3].map((i) => ({ ...clockwise[(start + i) % 4] })) as Quad;
}

/** Area of a quadrilateral by the shoelace formula. */
export function quadArea(quad: Quad): number {
  let sum = 0;
  for (let i = 0; i < 4; i++) {
    const a = quad[i];
    const b = quad[(i + 1) % 4];
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

/** True when every turn around the quad has the same direction. */
export function isConvex(quad: Quad): boolean {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = quad[i];
    const b = quad[(i + 1) % 4];
    const c = quad[(i + 2) % 4];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cross) < 1e-9) return false;
    const s = Math.sign(cross);
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

/** Interior angle at corner `i`, in degrees. */
function cornerAngle(quad: Quad, i: number): number {
  const prev = quad[(i + 3) % 4];
  const here = quad[i];
  const next = quad[(i + 1) % 4];
  const v1 = { x: prev.x - here.x, y: prev.y - here.y };
  const v2 = { x: next.x - here.x, y: next.y - here.y };
  const cos = (v1.x * v2.x + v1.y * v2.y) / (Math.hypot(v1.x, v1.y) * Math.hypot(v2.x, v2.y));
  return (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
}

/**
 * Whether four corners plausibly outline a photographed page: convex, large
 * enough to be the subject of the photo, no collapsed side, and no corner so
 * sharp that it must be a background shape rather than paper in perspective.
 */
export function isReasonableQuad(
  quad: Quad,
  frameWidth: number,
  frameHeight: number,
  minAreaRatio = 0.1
): boolean {
  if (!isConvex(quad)) return false;
  if (isFrameBorder(quad, frameWidth, frameHeight)) return false;
  if (quadArea(quad) < frameWidth * frameHeight * minAreaRatio) return false;

  const minSide = Math.min(frameWidth, frameHeight) * 0.12;
  for (let i = 0; i < 4; i++) {
    if (distance(quad[i], quad[(i + 1) % 4]) < minSide) return false;
    const angle = cornerAngle(quad, i);
    if (angle < 45 || angle > 135) return false;
  }
  return true;
}

/** Typical focal length as a fraction of the frame's long side (≈26 mm-equivalent phone or webcam lens). */
export const DEFAULT_FOCAL_RATIO = 0.8;

/**
 * Homography mapping the unit square (0,0)-(1,0)-(1,1)-(0,1) onto the quad
 * TL-TR-BR-BL (Heckbert's closed form). Rows of the 3×3 matrix.
 */
function squareToQuad(quad: Quad): number[][] {
  const [p0, p1, p2, p3] = quad;
  const sx = p0.x - p1.x + p2.x - p3.x;
  const sy = p0.y - p1.y + p2.y - p3.y;

  if (Math.abs(sx) < 1e-9 && Math.abs(sy) < 1e-9) {
    // Parallelogram: affine.
    return [
      [p1.x - p0.x, p3.x - p0.x, p0.x],
      [p1.y - p0.y, p3.y - p0.y, p0.y],
      [0, 0, 1],
    ];
  }

  const dx1 = p1.x - p2.x;
  const dx2 = p3.x - p2.x;
  const dy1 = p1.y - p2.y;
  const dy2 = p3.y - p2.y;
  const det = dx1 * dy2 - dx2 * dy1;
  const g = (sx * dy2 - dx2 * sy) / det;
  const h = (dx1 * sy - sx * dy1) / det;
  return [
    [p1.x - p0.x + g * p1.x, p3.x - p0.x + h * p3.x, p0.x],
    [p1.y - p0.y + g * p1.y, p3.y - p0.y + h * p3.y, p0.y],
    [g, h, 1],
  ];
}

/**
 * Focal length (in pixels) from the two vanishing points of the page's
 * sides, following Zhang & He, "Whiteboard scanning and image enhancement"
 * (2007). Null when a pair of sides is (nearly) parallel in the photo, in
 * which case the focal length cannot be measured from this image.
 */
function measuredFocalLength(quad: Quad, u0: number, v0: number): number | null {
  const [tl, tr, br, bl] = quad;
  const m1 = [tl.x, tl.y, 1];
  const m2 = [tr.x, tr.y, 1];
  const m3 = [bl.x, bl.y, 1];
  const m4 = [br.x, br.y, 1];
  const cross = (a: number[], b: number[]) => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
  const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

  const k2 = dot(cross(m1, m4), m3) / dot(cross(m2, m4), m3);
  const k3 = dot(cross(m1, m4), m2) / dot(cross(m3, m4), m2);
  const n2 = [k2 * m2[0] - m1[0], k2 * m2[1] - m1[1], k2 * m2[2] - m1[2]];
  const n3 = [k3 * m3[0] - m1[0], k3 * m3[1] - m1[1], k3 * m3[2] - m1[2]];

  const zz = n2[2] * n3[2];
  // Relative to the page's size in pixels, so the test is scale-independent.
  const scale = Math.hypot(n2[0], n2[1]) * Math.hypot(n3[0], n3[1]);
  if (!Number.isFinite(zz) || scale === 0 || Math.abs(zz) / scale < 1e-4) return null;

  const f2 =
    -(
      n2[0] * n3[0] -
      (n2[0] * n3[2] + n2[2] * n3[0]) * u0 +
      zz * u0 * u0 +
      (n2[1] * n3[1] - (n2[1] * n3[2] + n2[2] * n3[1]) * v0 + zz * v0 * v0)
    ) / zz;
  return Number.isFinite(f2) && f2 > 0 ? Math.sqrt(f2) : null;
}

/**
 * Typical focal length for phone and webcam main cameras (≈75° diagonal field
 * of view), used when the photo itself cannot reveal it.
 */
export const ASSUMED_FOCAL_FACTOR = 0.7;

/**
 * Estimates the page's true width ÷ height from its corners in the photo.
 *
 * Longest-edge estimates squash or stretch a page photographed at an angle.
 * Here the page is modelled as a flat rectangle seen by a pinhole camera
 * (square pixels, principal point at the image centre — true for phone and
 * webcam frames). The homography from a unit square to the photographed quad
 * is taken back through the camera, and its two columns give the real lengths
 * of the page's sides.
 *
 * The focal length is measured from the perspective when the page is tilted
 * about both axes. When it is tilted about only one (a single vanishing
 * point) or not at all, a typical camera focal length is assumed instead;
 * the result is then very close, and exact when there is no perspective.
 *
 * Returns null only when the estimate is implausible, so callers can fall
 * back to edge lengths rather than distort the page.
 */
export function estimateAspectRatio(quad: Quad, imageWidth: number, imageHeight: number): number | null {
  const u0 = imageWidth / 2;
  const v0 = imageHeight / 2;
  const diagonal = Math.hypot(imageWidth, imageHeight);

  let f = measuredFocalLength(quad, u0, v0);
  // A measured value far outside real lenses means the corners are noisy.
  if (f === null || f < diagonal * 0.3 || f > diagonal * 6) f = diagonal * ASSUMED_FOCAL_FACTOR;

  const H = squareToQuad(quad);
  if (H.flat().some((v) => !Number.isFinite(v))) return null;

  // |K⁻¹ c| for a homography column c, with K = [[f,0,u0],[0,f,v0],[0,0,1]].
  const lengthThroughCamera = (col: number) => {
    const x = H[0][col];
    const y = H[1][col];
    const w = H[2][col];
    return Math.hypot((x - u0 * w) / f!, (y - v0 * w) / f!, w);
  };

  const ratio = lengthThroughCamera(0) / lengthThroughCamera(1);
  if (!Number.isFinite(ratio) || ratio < 0.2 || ratio > 5) return null;
  return ratio;
}

/**
 * Size of the flattened document.
 *
 * When the photo's dimensions are known, the page's real proportions are
 * recovered from the perspective (see estimateAspectRatio), and the output is
 * given roughly the pixel count the page occupied in the photo. Otherwise each
 * dimension takes the longer of its two opposite edges. Either way the result
 * is capped at MAX_OUTPUT_SIDE with the aspect ratio preserved, so the page is
 * never stretched to fit.
 */
export function outputSize(
  quad: Quad,
  imageWidth?: number,
  imageHeight?: number
): { width: number; height: number } {
  const [tl, tr, br, bl] = quad;
  let width = Math.max(distance(tl, tr), distance(bl, br));
  let height = Math.max(distance(tl, bl), distance(tr, br));

  if (imageWidth && imageHeight) {
    const ratio = estimateAspectRatio(quad, imageWidth, imageHeight);
    if (ratio) {
      const pixels = width * height;
      width = Math.sqrt(pixels * ratio);
      height = Math.sqrt(pixels / ratio);
    }
  }

  const longest = Math.max(width, height);
  if (longest > MAX_OUTPUT_SIDE) {
    const scale = MAX_OUTPUT_SIDE / longest;
    width *= scale;
    height *= scale;
  }
  return { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) };
}

/**
 * True when the outline is really the photo's own border rather than a page:
 * three or more corners sit in the frame's corners.
 */
export function isFrameBorder(quad: Quad, width: number, height: number, margin = 0.02): boolean {
  const mx = width * margin;
  const my = height * margin;
  const frameCorners = [
    { x: 0, y: 0 },
    { x: width, y: 0 },
    { x: width, y: height },
    { x: 0, y: height },
  ];
  const hits = quad.filter((p) =>
    frameCorners.some((c) => Math.abs(p.x - c.x) <= mx && Math.abs(p.y - c.y) <= my)
  ).length;
  return hits >= 3;
}

export function scaleQuad(quad: Quad, sx: number, sy: number = sx): Quad {
  return quad.map((p) => ({ x: p.x * sx, y: p.y * sy })) as Quad;
}

export function clampQuad(quad: Quad, width: number, height: number): Quad {
  return quad.map((p) => ({
    x: Math.min(width, Math.max(0, p.x)),
    y: Math.min(height, Math.max(0, p.y)),
  })) as Quad;
}

/** A rectangle slightly inside the frame, used when no document is detected. */
export function insetQuad(width: number, height: number, inset = 0.06): Quad {
  const dx = width * inset;
  const dy = height * inset;
  return [
    { x: dx, y: dy },
    { x: width - dx, y: dy },
    { x: width - dx, y: height - dy },
    { x: dx, y: height - dy },
  ];
}

/** Largest corner movement between two quads, as a fraction of the frame diagonal. */
export function quadDeviation(a: Quad, b: Quad, diagonal: number): number {
  let worst = 0;
  for (let i = 0; i < 4; i++) worst = Math.max(worst, distance(a[i], b[i]));
  return worst / diagonal;
}

/** True when any corner sits within `margin` (fraction of the short side) of the frame edge. */
export function touchesEdge(quad: Quad, width: number, height: number, margin = 0.015): boolean {
  const m = Math.min(width, height) * margin;
  return quad.some((p) => p.x <= m || p.y <= m || p.x >= width - m || p.y >= height - m);
}

// ---------------------------------------------------------------------------
// Live guidance
// ---------------------------------------------------------------------------

export type ScanGuidance =
  | 'preparing'
  | 'notFound'
  | 'tooDark'
  | 'partial'
  | 'closer'
  | 'farther'
  | 'blurry'
  | 'holdSteady'
  | 'detected';

export interface FrameMeasurements {
  /** Detected page outline in detection-frame coordinates, or null. */
  quad: Quad | null;
  frameWidth: number;
  frameHeight: number;
  /** Mean luminance, 0–255. */
  brightness: number;
  /** Variance of the Laplacian; higher is sharper. */
  sharpness: number;
}

export const GUIDANCE_THRESHOLDS = {
  tooDark: 50,
  blurry: 18,
  /** Sharpness below which a captured still (measured at 1000 px) looks blurry. */
  blurryStill: 18,
  closerAreaRatio: 0.2,
  fartherAreaRatio: 0.9,
};

/**
 * Picks the single most useful instruction for the current frame. Order
 * matters: there is no point asking the user to hold steady in the dark.
 */
export function guidanceFor(frame: FrameMeasurements, stable: boolean): ScanGuidance {
  if (frame.brightness < GUIDANCE_THRESHOLDS.tooDark) return 'tooDark';
  if (!frame.quad) return 'notFound';

  const areaRatio = quadArea(frame.quad) / (frame.frameWidth * frame.frameHeight);
  if (areaRatio > GUIDANCE_THRESHOLDS.fartherAreaRatio) return 'farther';
  if (touchesEdge(frame.quad, frame.frameWidth, frame.frameHeight)) return 'partial';
  if (areaRatio < GUIDANCE_THRESHOLDS.closerAreaRatio) return 'closer';
  if (frame.sharpness < GUIDANCE_THRESHOLDS.blurry) return 'blurry';
  if (!stable) return 'holdSteady';
  return 'detected';
}

/**
 * Decides when a detected outline has stopped moving. A document is "stable"
 * once recent detections span at least `minDurationMs` and no corner has moved
 * more than `maxDeviation` of the frame diagonal across them.
 */
export class StabilityTracker {
  private history: Array<{ quad: Quad; at: number }> = [];

  constructor(
    private readonly maxDeviation = 0.02,
    private readonly minDurationMs = 600,
    private readonly windowMs = 1200
  ) {}

  push(quad: Quad | null, diagonal: number, now: number): boolean {
    if (!quad) {
      this.history = [];
      return false;
    }
    const last = this.history[this.history.length - 1];
    if (last && quadDeviation(last.quad, quad, diagonal) > this.maxDeviation) {
      // The page moved: start measuring stillness again from here.
      this.history = [];
    }
    this.history.push({ quad, at: now });
    this.history = this.history.filter((entry) => now - entry.at <= this.windowMs);

    const first = this.history[0];
    if (this.history.length < 3 || now - first.at < this.minDurationMs) return false;
    return this.history.every((entry) => quadDeviation(first.quad, entry.quad, diagonal) <= this.maxDeviation);
  }

  reset(): void {
    this.history = [];
  }
}
