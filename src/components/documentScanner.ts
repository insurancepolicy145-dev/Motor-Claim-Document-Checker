/**
 * Document scanner.
 *
 *   IDLE → OPEN CAMERA → LIVE DOCUMENT DETECTION → DOCUMENT DETECTED → CAPTURE
 *   → ORIGINAL IMAGE → DETECT FOUR CORNERS → PERSPECTIVE CORRECTION
 *   → PROCESSED IMAGE → PREVIEW → Retake (back to camera) | Use Photo
 *
 * One scanner instance is created per open and discarded on close, so no image
 * ever outlives its session or leaks into another document. The original
 * capture is kept untouched; the processed image is always regenerated from it
 * and the current corners, which is what makes corner adjustment, finishing
 * modes and Original/Scanned comparison lossless.
 *
 * Scanning never judges the document. Failing to find the edges only means the
 * user places the corners by hand; it has no bearing on claim validation.
 */

import { t } from '../i18n';
import { backIcon, cameraIcon, checkIcon, flashIcon, retakeIcon } from './icons';
import {
  LIVE_DETECTION_SIDE,
  SCAN_MODES,
  STILL_DETECTION_SIDE,
  type ScanMode,
  type ScanOutput,
  applyScanMode,
  canvasToBlob,
  detectDocument,
  downscale,
  flattenDocument,
  makeCanvas,
} from '../services/documentScanner';
import { type OpenCvHandle, loadOpenCv } from '../services/opencvLoader';
import {
  type Point,
  type Quad,
  type ScanGuidance,
  StabilityTracker,
  clampQuad,
  GUIDANCE_THRESHOLDS,
  guidanceFor,
  insetQuad,
  scaleQuad,
} from '../services/scanGeometry';

export type ScanSource = 'camera' | 'upload';

export interface ScanOutcome {
  /**
   * The image to attach: the full photo (default) or, if the user chose it,
   * the cropped and perspective-corrected document. Finishing mode applied.
   */
  file: File;
  /** The untouched capture or upload the processed image was made from. */
  original: File;
  /** Corners used, in the original image's pixel coordinates. */
  quad: Quad;
  mode: ScanMode;
  output: ScanOutput;
  /** Whether the edges were found automatically. Informational only. */
  detected: boolean;
  source: ScanSource;
}

export interface ScanRequest {
  /** Display name of the document being scanned, e.g. "Policy Copy". */
  documentName: string;
  /** Lower-case file stem, e.g. "policy" → policy_scan.jpg. */
  fileStem: string;
  source: ScanSource;
  /** Start from this image rather than the camera (an upload, or re-adjusting a scan). */
  image?: File;
  /** Corners to start from when re-adjusting an existing scan. */
  quad?: Quad;
  mode?: ScanMode;
  /** Output to start with; defaults to the full, uncropped photo. */
  output?: ScanOutput;
  /** Open straight into corner adjustment (implies the cropped output). */
  startInAdjust?: boolean;
  /** Called, inside the click, when the user chooses to upload instead of using the camera. */
  onUploadInstead?: () => void;
}

type Stage = 'starting' | 'live' | 'processing' | 'review' | 'error';
/** 'result' shows the image that will be saved; 'adjust' edits the crop corners on the original. */
type ReviewView = 'result' | 'adjust';
type FlashState = 'checking' | 'auto' | 'unavailable';
type Quality = 'clear' | 'edges' | 'blurry' | 'dark' | null;

/** Largest canvas the scanner will process; beyond this, phones run out of memory. */
const MAX_PROCESS_PIXELS = 16_000_000;
const LIVE_INTERVAL_MS = 140;
const CORNER_LABELS = ['scan.corner.tl', 'scan.corner.tr', 'scan.corner.br', 'scan.corner.bl'];
const SVG_NS = 'http://www.w3.org/2000/svg';

function escapeHtml(value: unknown): string {
  return String(value).replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string
  );
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

interface ImageCaptureLike {
  takePhoto: (settings?: object) => Promise<Blob>;
  getPhotoCapabilities: () => Promise<{ fillLightMode?: string[] }>;
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/** Decodes an image file to a canvas, honouring EXIF orientation and capping memory. */
async function fileToCanvas(file: Blob): Promise<HTMLCanvasElement> {
  let source: CanvasImageSource;
  let width: number;
  let height: number;
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    source = bitmap;
    width = bitmap.width;
    height = bitmap.height;
  } catch {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      source = img;
      width = img.naturalWidth;
      height = img.naturalHeight;
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  const scale = Math.min(1, Math.sqrt(MAX_PROCESS_PIXELS / (width * height)));
  const canvas = makeCanvas(width * scale, height * scale);
  canvas.getContext('2d')!.drawImage(source, 0, 0, canvas.width, canvas.height);
  if ('close' in source && typeof source.close === 'function') source.close();
  return canvas;
}

/** Draws a quad outline into an SVG using the image's own coordinate space. */
function buildOutlineSvg(width: number, height: number, imageUrl: string): {
  svg: SVGSVGElement;
  polygon: SVGPolygonElement;
  handles: SVGCircleElement[];
} {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  svg.classList.add('scansvg');

  const image = document.createElementNS(SVG_NS, 'image');
  image.setAttribute('href', imageUrl);
  image.setAttribute('width', String(width));
  image.setAttribute('height', String(height));
  svg.appendChild(image);

  const polygon = document.createElementNS(SVG_NS, 'polygon');
  polygon.classList.add('scanpoly');
  polygon.setAttribute('stroke-width', String(Math.max(width, height) * 0.004));
  svg.appendChild(polygon);

  const radius = Math.max(width, height) * 0.02;
  const handles = CORNER_LABELS.map((labelKey, index) => {
    const handle = document.createElementNS(SVG_NS, 'circle');
    handle.classList.add('scanhandle');
    handle.setAttribute('r', String(radius));
    handle.setAttribute('stroke-width', String(radius * 0.25));
    handle.setAttribute('tabindex', '0');
    handle.setAttribute('role', 'slider');
    handle.setAttribute('aria-label', t(labelKey));
    handle.dataset.corner = String(index);
    svg.appendChild(handle);
    return handle;
  });

  return { svg, polygon, handles };
}

function placeOutline(polygon: SVGPolygonElement, handles: SVGCircleElement[], quad: Quad): void {
  polygon.setAttribute('points', quad.map((p) => `${p.x},${p.y}`).join(' '));
  handles.forEach((handle, i) => {
    handle.setAttribute('cx', String(quad[i].x));
    handle.setAttribute('cy', String(quad[i].y));
  });
}

// ===========================================================================
// Scanner
// ===========================================================================

export function openDocumentScanner(request: ScanRequest): Promise<ScanOutcome | null> {
  return new Promise((resolve) => {
    let stage: Stage = request.image ? 'processing' : 'starting';
    // Nothing is cropped away unless the user asks for it.
    let output: ScanOutput = request.startInAdjust ? 'cropped' : request.output ?? 'full';
    let view: ReviewView = 'result';
    let mode: ScanMode = request.mode ?? 'original';
    let quality: Quality = null;
    let flash: FlashState = 'checking';
    let imageCapture: ImageCaptureLike | null = null;
    let settled = false;

    let stream: MediaStream | null = null;
    let facing: 'environment' | 'user' = 'environment';
    let canSwitch = false;
    let loopHandle = 0;
    let lastDetectAt = 0;
    const tracker = new StabilityTracker();
    let live: { quad: Quad | null; at: number; guidance: ScanGuidance } = {
      quad: null,
      at: 0,
      guidance: 'preparing',
    };
    const detectCanvas = document.createElement('canvas');

    // Per-session image state. Never shared, never global.
    let originalCanvas: HTMLCanvasElement | null = null;
    let originalFile: File | null = null;
    let quad: Quad | null = null;
    let detected = false;
    let processedBlob: Blob | null = null;
    let processedUrl: string | null = null;
    let originalUrl: string | null = null;
    /** Bumped whenever the current image is discarded; stale async work checks it. */
    let session = 0;
    /** Bumped for every preview render; only the latest render may update the preview. */
    let renderRun = 0;
    let note = '';

    let cvHandle: OpenCvHandle | null = null;
    let cvFailed = false;
    const cvReady = loadOpenCv().then(
      (handle) => {
        cvHandle = handle;
        return handle;
      },
      () => {
        cvFailed = true;
        return null;
      }
    );

    // ---- markup ----------------------------------------------------------

    const overlay = document.createElement('div');
    overlay.className = 'cammodal scanner';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.innerHTML = `
      <div class="camsheet scansheet">
        <div class="camhead">
          <button type="button" class="camclose scanback">${backIcon()}<span></span></button>
          <h3></h3>
        </div>
        <div class="scanlive">
          <div class="camstage scanstage">
            <video playsinline muted autoplay></video>
            <canvas class="scanoverlay" aria-hidden="true"></canvas>
            <p class="scanguide" aria-live="polite"></p>
            <p class="cammsg"></p>
          </div>
          <p class="scanflash" aria-live="polite">${flashIcon()}<span></span></p>
          <div class="scanbar">
            <button type="button" class="act ghost scanswitch"></button>
            <div class="scanshutterwrap">
              <button type="button" class="scanshutter">${cameraIcon()}</button>
              <span class="scanshutterlabel" aria-hidden="true"></span>
            </div>
            <button type="button" class="act ghost scanupload"></button>
          </div>
        </div>
        <div class="scanreview" hidden>
          <p class="rptlabel scanreviewtitle"></p>
          <div class="scantabs" role="radiogroup">
            <button type="button" role="radio" data-output="full"></button>
            <button type="button" role="radio" data-output="cropped"></button>
          </div>
          <div class="camstage scanpreview">
            <img class="scanimg" alt="">
            <div class="scanorig" hidden></div>
            <p class="cammsg scanbusy" hidden></p>
          </div>
          <p class="scannote" aria-live="polite"></p>
          <div class="scanmodes" role="group"></div>
          <div class="camactions scanactions">
            <button type="button" class="act ghost scanadjust"></button>
            <button type="button" class="act ghost scanretake">${retakeIcon()}<span></span></button>
            <button type="button" class="act ghost scanremove"></button>
            <button type="button" class="act scanuse">${checkIcon()}<span></span></button>
          </div>
          <input type="file" class="scanpick" accept="image/jpeg,image/png,image/webp" hidden>
        </div>
      </div>`;

    const $ = <T extends Element>(selector: string) => overlay.querySelector<T>(selector)!;
    const title = $<HTMLHeadingElement>('.camhead h3');
    const closeBtn = $<HTMLButtonElement>('.camclose');
    const liveSection = $<HTMLDivElement>('.scanlive');
    const stageEl = $<HTMLDivElement>('.scanstage');
    const video = $<HTMLVideoElement>('video');
    const overlayCanvas = $<HTMLCanvasElement>('.scanoverlay');
    const guide = $<HTMLParagraphElement>('.scanguide');
    const liveMessage = $<HTMLParagraphElement>('.scanstage .cammsg');
    const switchBtn = $<HTMLButtonElement>('.scanswitch');
    const flashEl = $<HTMLParagraphElement>('.scanflash');
    const shutter = $<HTMLButtonElement>('.scanshutter');
    const shutterLabel = $<HTMLSpanElement>('.scanshutterlabel');
    const uploadBtn = $<HTMLButtonElement>('.scanupload');
    const reviewSection = $<HTMLDivElement>('.scanreview');
    const reviewTitle = $<HTMLParagraphElement>('.scanreviewtitle');
    const tabs = Array.from(overlay.querySelectorAll<HTMLButtonElement>('.scantabs button'));
    const previewImg = $<HTMLImageElement>('.scanimg');
    const origHolder = $<HTMLDivElement>('.scanorig');
    const busy = $<HTMLParagraphElement>('.scanbusy');
    const noteEl = $<HTMLParagraphElement>('.scannote');
    const modesEl = $<HTMLDivElement>('.scanmodes');
    const adjustBtn = $<HTMLButtonElement>('.scanadjust');
    const retakeBtn = $<HTMLButtonElement>('.scanretake');
    const removeBtn = $<HTMLButtonElement>('.scanremove');
    const useBtn = $<HTMLButtonElement>('.scanuse');
    const picker = $<HTMLInputElement>('.scanpick');

    const modeButtons = SCAN_MODES.map((m) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.mode = m;
      modesEl.appendChild(button);
      return button;
    });

    let outline: ReturnType<typeof buildOutlineSvg> | null = null;

    // ---- labels ------------------------------------------------------------

    function paintLabels(): void {
      overlay.setAttribute('aria-label', t('scan.title', { doc: request.documentName }));
      closeBtn.querySelector('span')!.textContent = t('scan.back');
      switchBtn.textContent = t('camera.switch');
      shutter.setAttribute('aria-label', t('scan.capture'));
      shutterLabel.textContent = t('scan.capture');
      uploadBtn.textContent = t('scan.uploadInstead');
      reviewTitle.textContent = request.documentName;
      tabs[0].textContent = t('scan.output.full');
      tabs[1].textContent = t('scan.output.cropped');
      overlay.querySelector('.scantabs')!.setAttribute('aria-label', t('scan.outputLabel'));
      previewImg.alt = t('scan.previewAlt', { doc: request.documentName });
      busy.textContent = t('scan.processing');
      modesEl.setAttribute('aria-label', t('scan.modeLabel'));
      modeButtons.forEach((b) => (b.textContent = t(`scan.mode.${b.dataset.mode}`)));
      retakeBtn.querySelector('span')!.textContent = t('scan.retake');
      removeBtn.textContent = t('scan.remove');
      useBtn.querySelector('span')!.textContent = t('scan.use');
    }

    // ---- rendering -----------------------------------------------------------

    function render(): void {
      overlay.dataset.stage = stage;
      overlay.dataset.output = output;
      const inLive = stage === 'starting' || stage === 'live' || (stage === 'error' && !originalCanvas);
      // Camera screen is titled with the document; afterwards it is the preview.
      title.textContent = inLive ? request.documentName : t('scan.previewHeading');
      flashEl.hidden = !inLive || stage === 'error';
      flashEl.dataset.flash = flash;
      flashEl.querySelector('span')!.textContent = t(`scan.flash.${flash}`);
      liveSection.hidden = !inLive;
      reviewSection.hidden = inLive;

      // Live controls
      video.hidden = stage !== 'live';
      overlayCanvas.hidden = stage !== 'live';
      guide.hidden = stage !== 'live';
      liveMessage.hidden = stage === 'live';
      shutter.hidden = stage === 'error';
      shutterLabel.hidden = stage === 'error';
      shutter.disabled = stage !== 'live';
      switchBtn.hidden = !(stage === 'live' && canSwitch);
      uploadBtn.hidden = !(stage === 'error' && request.onUploadInstead);

      // Review controls
      const reviewing = stage === 'review';
      const processing = stage === 'processing';
      busy.hidden = !processing;
      previewImg.hidden = !(reviewing && view === 'result');
      // While edges are being found, the photo itself is already on screen.
      origHolder.hidden = !((reviewing && view === 'adjust') || (processing && outline));
      origHolder.classList.toggle('adjusting', reviewing && view === 'adjust');
      tabs.forEach((tab) => {
        const selected = tab.dataset.output === output;
        tab.setAttribute('aria-checked', String(selected));
        tab.setAttribute('aria-selected', String(selected));
        // Cropping needs OpenCV; the full photo never does.
        tab.disabled = !reviewing || (tab.dataset.output === 'cropped' && !cvHandle);
      });
      modeButtons.forEach((b) => {
        b.setAttribute('aria-pressed', String(b.dataset.mode === mode));
        b.disabled = !reviewing || !cvHandle;
      });
      adjustBtn.textContent = view === 'adjust' ? t('scan.adjustDone') : t('scan.adjust');
      adjustBtn.hidden = output !== 'cropped';
      adjustBtn.disabled = !reviewing || !cvHandle;
      adjustBtn.setAttribute('aria-pressed', String(view === 'adjust'));
      retakeBtn.disabled = !reviewing && stage !== 'error';
      removeBtn.hidden = request.source !== 'upload';
      useBtn.disabled = !reviewing || !processedBlob;

      // In the corner editor, instructions; otherwise how the capture looks.
      if (view === 'adjust') {
        noteEl.textContent = note || t('scan.adjustHint');
        noteEl.className = 'scannote';
      } else if (note) {
        noteEl.textContent = note;
        noteEl.className = 'scannote';
      } else if (quality) {
        noteEl.textContent = `${quality === 'clear' ? '✅' : '⚠️'} ${t(`scan.quality.${quality}`)}`;
        noteEl.className = `scannote ${quality === 'clear' ? 'ok' : 'warn'}`;
      } else {
        noteEl.textContent = '';
      }
      noteEl.dataset.quality = quality ?? '';
      noteEl.hidden = !reviewing || !noteEl.textContent;
    }

    // ---- lifecycle -----------------------------------------------------------

    function stopStream(): void {
      stream?.getTracks().forEach((track) => track.stop());
      stream = null;
      video.srcObject = null;
    }

    function stopLoop(): void {
      if (loopHandle) cancelAnimationFrame(loopHandle);
      loopHandle = 0;
    }

    function clearImages(): void {
      session++;
      renderRun++;
      if (processedUrl) URL.revokeObjectURL(processedUrl);
      if (originalUrl) URL.revokeObjectURL(originalUrl);
      processedUrl = null;
      originalUrl = null;
      processedBlob = null;
      originalCanvas = null;
      originalFile = null;
      quad = null;
      detected = false;
      note = '';
      previewImg.removeAttribute('src');
      delete previewImg.dataset.ready;
      origHolder.innerHTML = '';
      outline = null;
    }

    function finish(result: ScanOutcome | null): void {
      if (settled) return;
      settled = true;
      stopLoop();
      stopStream();
      clearImages();
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', drawLive);
      overlay.remove();
      resolve(result);
    }

    function onKey(event: KeyboardEvent): void {
      if (event.key === 'Escape') finish(null);
    }

    closeBtn.addEventListener('click', () => finish(null));
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', drawLive);

    function fail(key: string): void {
      stopLoop();
      stopStream();
      clearImages();
      stage = 'error';
      liveMessage.textContent = t(key);
      liveMessage.className = 'cammsg bad';
      render();
    }

    // ---- camera --------------------------------------------------------------

    async function startCamera(): Promise<void> {
      if (!window.isSecureContext) {
        fail('camera.insecure');
        return;
      }
      if (!navigator.mediaDevices?.getUserMedia) {
        fail('camera.unavailable');
        return;
      }

      stopStream();
      stage = 'starting';
      liveMessage.className = 'cammsg';
      liveMessage.textContent = t('camera.requesting');
      render();

      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: facing },
            width: { ideal: 3840 },
            height: { ideal: 2160 },
          },
          audio: false,
        });
      } catch (error) {
        const name = error instanceof DOMException ? error.name : '';
        if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') {
          fail('scan.denied');
        } else {
          fail('camera.unavailable');
        }
        return;
      }
      if (settled) {
        stopStream();
        return;
      }

      video.srcObject = stream;
      try {
        await video.play();
      } catch {
        /* autoplay restrictions: the stream is attached and will render */
      }
      await new Promise<void>((done) => {
        if (video.videoWidth) done();
        else video.addEventListener('loadedmetadata', () => done(), { once: true });
      });

      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        canSwitch = devices.filter((d) => d.kind === 'videoinput').length > 1;
      } catch {
        canSwitch = false;
      }

      flash = 'checking';
      imageCapture = null;
      void detectFlash(stream);

      tracker.reset();
      live = { quad: null, at: 0, guidance: 'preparing' };
      stage = 'live';
      render();
      shutter.focus();
      loopHandle = requestAnimationFrame(tick);
    }

    /**
     * Automatic flash is only exposed to web pages on some devices (Android
     * Chrome through ImageCapture). Where it exists, captures use it; the
     * indicator reports what the device really supports rather than a promise
     * the browser cannot keep.
     */
    async function detectFlash(current: MediaStream): Promise<void> {
      const track = current.getVideoTracks()[0];
      const Ctor = (window as unknown as { ImageCapture?: new (t: MediaStreamTrack) => ImageCaptureLike })
        .ImageCapture;
      let capture: ImageCaptureLike | null = null;
      let supportsAuto = false;
      if (track && Ctor) {
        try {
          capture = new Ctor(track);
          const capabilities = await withTimeout(capture.getPhotoCapabilities(), 2500);
          supportsAuto = Array.isArray(capabilities.fillLightMode) && capabilities.fillLightMode.includes('auto');
        } catch {
          supportsAuto = false;
        }
      }
      if (settled || stream !== current) return;
      imageCapture = supportsAuto ? capture : null;
      flash = supportsAuto ? 'auto' : 'unavailable';
      render();
    }

    /** Live detection: a downscaled frame every ~140 ms, corners mapped back to the video. */
    function tick(now: number): void {
      if (stage !== 'live' || settled) return;
      loopHandle = requestAnimationFrame(tick);
      if (now - lastDetectAt < LIVE_INTERVAL_MS || !video.videoWidth) return;
      lastDetectAt = now;

      if (!cvHandle) {
        live = { quad: null, at: now, guidance: cvFailed ? 'notFound' : 'preparing' };
        drawLive();
        return;
      }

      try {
        const { canvas, toSource } = downscale(
          video,
          video.videoWidth,
          video.videoHeight,
          LIVE_DETECTION_SIDE,
          detectCanvas
        );
        const frame = detectDocument(cvHandle.cv, canvas);
        const stable = tracker.push(frame.quad, Math.hypot(canvas.width, canvas.height), now);
        live = {
          quad: frame.quad ? scaleQuad(frame.quad, toSource) : null,
          at: now,
          guidance: guidanceFor(frame, stable),
        };
      } catch {
        live = { quad: null, at: now, guidance: 'notFound' };
      }
      drawLive();
    }

    /** Draws the detected outline over the video, following the page's real perspective. */
    function drawLive(): void {
      if (stage !== 'live') return;
      const ratio = window.devicePixelRatio || 1;
      const box = stageEl.getBoundingClientRect();
      const vbox = video.getBoundingClientRect();
      overlayCanvas.width = Math.round(box.width * ratio);
      overlayCanvas.height = Math.round(box.height * ratio);
      const ctx = overlayCanvas.getContext('2d')!;
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.clearRect(0, 0, box.width, box.height);

      const detectedNow = live.guidance === 'detected';
      guide.textContent =
        live.guidance === 'preparing'
          ? t('scan.preparing')
          : cvFailed
          ? t('scan.detectionUnavailable')
          : t(`scan.guide.${live.guidance}`);
      guide.className = `scanguide ${detectedNow ? 'ok' : live.quad ? 'wait' : ''}`;
      overlayCanvas.dataset.state = live.guidance;

      // object-fit: contain — the video's content box inside the stage.
      const contentScale = Math.min(vbox.width / video.videoWidth, vbox.height / video.videoHeight);
      const contentX = vbox.left - box.left + (vbox.width - video.videoWidth * contentScale) / 2;
      const contentY = vbox.top - box.top + (vbox.height - video.videoHeight * contentScale) / 2;
      const contentW = video.videoWidth * contentScale;
      const contentH = video.videoHeight * contentScale;

      if (!live.quad || !video.videoWidth) {
        delete overlayCanvas.dataset.corners;
        // Until a document is found, show a frame to line it up with.
        if (video.videoWidth) {
          overlayCanvas.dataset.frame = 'guide';
          const left = contentX + contentW * 0.05;
          const right = contentX + contentW * 0.95;
          const top = contentY + contentH * 0.12;
          const bottom = contentY + contentH * 0.88;
          const arm = Math.min(right - left, bottom - top) * 0.12;
          ctx.strokeStyle = 'rgba(255,255,255,0.9)';
          ctx.lineWidth = 4;
          ctx.lineCap = 'round';
          for (const [x, y, dx, dy] of [
            [left, top, 1, 1],
            [right, top, -1, 1],
            [right, bottom, -1, -1],
            [left, bottom, 1, -1],
          ] as Array<[number, number, number, number]>) {
            ctx.beginPath();
            ctx.moveTo(x + dx * arm, y);
            ctx.lineTo(x, y);
            ctx.lineTo(x, y + dy * arm);
            ctx.stroke();
          }
        }
        return;
      }
      delete overlayCanvas.dataset.frame;
      overlayCanvas.dataset.corners = JSON.stringify(
        live.quad.map((p) => [Math.round(p.x), Math.round(p.y)])
      );

      const points = live.quad.map((p) => ({
        x: contentX + p.x * contentScale,
        y: contentY + p.y * contentScale,
      }));

      ctx.beginPath();
      points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
      ctx.closePath();
      ctx.fillStyle = detectedNow ? 'rgba(46,107,79,0.22)' : 'rgba(176,122,22,0.14)';
      ctx.fill();
      ctx.lineWidth = detectedNow ? 4 : 3;
      ctx.strokeStyle = detectedNow ? '#3FA26F' : '#E2A93B';
      ctx.stroke();
      ctx.fillStyle = '#FFFFFF';
      for (const p of points) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, detectedNow ? 6 : 4.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    /**
     * Trims a still photo to the aspect ratio the live preview showed, taking
     * the middle. Returns the canvas untouched when the shapes already agree.
     */
    function matchPreviewShape(photo: HTMLCanvasElement, previewAspect: number): HTMLCanvasElement {
      const photoAspect = photo.width / photo.height;
      if (!Number.isFinite(previewAspect) || Math.abs(photoAspect - previewAspect) < 0.02) return photo;

      let width = photo.width;
      let height = photo.height;
      if (photoAspect > previewAspect) width = Math.round(photo.height * previewAspect);
      else height = Math.round(photo.width / previewAspect);

      const out = makeCanvas(width, height);
      out
        .getContext('2d')!
        .drawImage(photo, Math.round((photo.width - width) / 2), Math.round((photo.height - height) / 2), width, height, 0, 0, width, height);
      return out;
    }

    async function capture(): Promise<void> {
      if (stage !== 'live' || !video.videoWidth) return;
      const videoWidth = video.videoWidth;
      const videoHeight = video.videoHeight;
      // Always grab the video frame at its native resolution first: instant,
      // and the fallback if a full photo cannot be taken.
      const videoFrame = makeCanvas(videoWidth, videoHeight);
      videoFrame.getContext('2d')!.drawImage(video, 0, 0, videoWidth, videoHeight);
      const recentQuad = live.quad && performance.now() - live.at < 600 ? live.quad : null;
      const photoCapture = flash === 'auto' ? imageCapture : null;

      stopLoop();
      clearImages();
      const mySession = session;
      stage = 'processing';
      render();

      // With automatic flash available, take a real photo (full sensor
      // resolution, flash fired if needed) while the stream is still live.
      let photoBlob: Blob | null = null;
      if (photoCapture) {
        try {
          photoBlob = await withTimeout(photoCapture.takePhoto({ fillLightMode: 'auto' }), 6000);
        } catch {
          photoBlob = null;
        }
      }
      stopStream(); // release the camera light while reviewing
      if (settled || mySession !== session) return;

      let frame = videoFrame;
      if (photoBlob) {
        try {
          frame = await fileToCanvas(photoBlob);
          // A still photo often comes back in the sensor's own shape (4:3)
          // while the preview showed 16:9, so it would cover a different area
          // than the user framed. Trim it back to the preview's shape: what
          // you saw is what gets saved, at the photo's higher resolution.
          frame = matchPreviewShape(frame, videoWidth / videoHeight);
        } catch {
          photoBlob = null;
          frame = videoFrame;
        }
      }
      if (settled || mySession !== session) return;
      originalCanvas = frame;

      // The outline can now be mapped across, the shapes being the same.
      const sameShape = Math.abs(frame.width / frame.height - videoWidth / videoHeight) < 0.02;
      const hint = recentQuad && sameShape ? scaleQuad(recentQuad, frame.width / videoWidth) : null;

      try {
        const blob = photoBlob ?? (await canvasToBlob(frame, 'image/jpeg', 0.95));
        originalFile = new File([blob], `${request.fileStem}_original_${stamp()}.jpg`, {
          type: 'image/jpeg',
        });
      } catch {
        fail('scan.imageLoadFailed');
        return;
      }
      if (settled || originalCanvas !== frame) return;
      showOriginal();
      await beginReview(hint);
    }

    // ---- review --------------------------------------------------------------

    /**
     * Puts the untouched original on screen as soon as it exists, before any
     * detection has run, so the user sees their photo rather than a blank
     * panel. The outline is added to this same image once corners are known.
     */
    function showOriginal(): void {
      if (!originalCanvas || !originalFile || outline) return;
      originalUrl = URL.createObjectURL(originalFile);
      outline = buildOutlineSvg(originalCanvas.width, originalCanvas.height, originalUrl);
      origHolder.innerHTML = '';
      origHolder.appendChild(outline.svg);
      wireHandles(outline);
      render();
    }

    async function beginReview(hint: Quad | null, preset?: Quad): Promise<void> {
      const mySession = session;
      const handle = await cvReady;
      if (settled || mySession !== session || !originalCanvas) return;
      const source = originalCanvas;

      note = '';
      quality = null;
      let brightness: number | null = null;
      let sharpness: number | null = null;
      if (preset) {
        quad = clampQuad(preset, source.width, source.height);
        detected = true;
      } else if (handle) {
        try {
          const { canvas, toSource } = downscale(source, source.width, source.height, STILL_DETECTION_SIDE);
          const frame = detectDocument(handle.cv, canvas);
          brightness = frame.brightness;
          sharpness = frame.sharpness;
          if (frame.quad) {
            quad = scaleQuad(frame.quad, toSource);
            detected = true;
          }
        } catch {
          /* fall through to the live hint or manual corners */
        }
        if (!quad && hint) {
          quad = hint;
          detected = true;
        }
      }

      if (!handle) {
        // Without OpenCV the full photo still works; only cropping is unavailable.
        quad = insetQuad(source.width, source.height, 0);
        if (output === 'cropped') note = t('scan.croppingUnavailable');
        output = 'full';
        view = 'result';
      } else {
        if (!quad) quad = insetQuad(source.width, source.height);
        // Report how the capture looks, most serious problem first. Nothing is
        // judged when re-opening an existing scan.
        if (!preset) {
          if (brightness !== null && brightness < GUIDANCE_THRESHOLDS.tooDark) quality = 'dark';
          else if (!detected) quality = 'edges';
          else if (sharpness !== null && sharpness < GUIDANCE_THRESHOLDS.blurryStill) quality = 'blurry';
          else quality = 'clear';
        }
        view = request.startInAdjust ? 'adjust' : 'result';
      }

      showOriginal();
      if (!outline) return;
      placeOutline(outline.polygon, outline.handles, quad);
      origHolder.dataset.corners = JSON.stringify(quad.map((p) => [Math.round(p.x), Math.round(p.y)]));

      await regenerate();
      if (settled || mySession !== session) return;
      stage = 'review';
      render();
      (view === 'adjust' ? outline.handles[0] : useBtn).focus({ preventScroll: true });
    }

    /** Rebuilds the processed image from the untouched original and the current corners. */
    async function regenerate(): Promise<void> {
      if (!originalCanvas || !quad) return;
      const run = ++renderRun;
      previewImg.dataset.ready = 'false';

      let processed: HTMLCanvasElement = originalCanvas;
      if (output === 'full') {
        // The complete photo, borders and all, in its original proportions.
        if (cvHandle && mode !== 'original') {
          try {
            processed = applyScanMode(cvHandle.cv, originalCanvas, mode);
          } catch {
            processed = originalCanvas;
          }
        }
      } else if (cvHandle) {
        try {
          const flat = flattenDocument(cvHandle.cv, originalCanvas, quad);
          processed = applyScanMode(cvHandle.cv, flat, mode);
        } catch {
          processed = originalCanvas;
          note = t('scan.croppingUnavailable');
        }
      }

      const blob = await canvasToBlob(processed, 'image/jpeg', 0.92);
      if (run !== renderRun || settled) return;

      if (processedUrl) URL.revokeObjectURL(processedUrl);
      processedBlob = blob;
      processedUrl = URL.createObjectURL(blob);
      previewImg.dataset.width = String(processed.width);
      previewImg.dataset.height = String(processed.height);
      await new Promise<void>((done) => {
        previewImg.onload = () => done();
        previewImg.onerror = () => done();
        previewImg.src = processedUrl!;
      });
      previewImg.dataset.ready = previewImg.naturalWidth > 0 ? 'true' : 'false';
      render();
    }

    function wireHandles(target: ReturnType<typeof buildOutlineSvg>): void {
      const { svg, polygon, handles } = target;
      let dragging = -1;

      const toImage = (event: PointerEvent): Point => {
        const matrix = svg.getScreenCTM();
        if (!matrix) return { x: 0, y: 0 };
        const pt = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
        return { x: pt.x, y: pt.y };
      };

      const commit = () => {
        if (!originalCanvas || !quad) return;
        origHolder.dataset.corners = JSON.stringify(quad.map((p) => [Math.round(p.x), Math.round(p.y)]));
        void regenerate();
      };

      handles.forEach((handle, index) => {
        handle.addEventListener('pointerdown', (event) => {
          if (view !== 'adjust') return;
          dragging = index;
          handle.setPointerCapture(event.pointerId);
          handle.classList.add('dragging');
          event.preventDefault();
        });
        handle.addEventListener('pointermove', (event) => {
          if (dragging !== index || !quad || !originalCanvas) return;
          const p = toImage(event);
          quad[index] = {
            x: Math.min(originalCanvas.width, Math.max(0, p.x)),
            y: Math.min(originalCanvas.height, Math.max(0, p.y)),
          };
          placeOutline(polygon, handles, quad);
        });
        const end = (event: PointerEvent) => {
          if (dragging !== index) return;
          dragging = -1;
          handle.classList.remove('dragging');
          if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
          // After moving a corner, regenerate the perspective-corrected preview.
          commit();
        };
        handle.addEventListener('pointerup', end);
        handle.addEventListener('pointercancel', end);

        // Keyboard: arrow keys nudge the focused corner.
        handle.addEventListener('keydown', (event) => {
          if (view !== 'adjust' || !quad || !originalCanvas) return;
          const step = Math.max(originalCanvas.width, originalCanvas.height) * (event.shiftKey ? 0.02 : 0.005);
          const delta: Record<string, Point> = {
            ArrowLeft: { x: -step, y: 0 },
            ArrowRight: { x: step, y: 0 },
            ArrowUp: { x: 0, y: -step },
            ArrowDown: { x: 0, y: step },
          };
          const move = delta[event.key];
          if (!move) return;
          event.preventDefault();
          quad[index] = {
            x: Math.min(originalCanvas.width, Math.max(0, quad[index].x + move.x)),
            y: Math.min(originalCanvas.height, Math.max(0, quad[index].y + move.y)),
          };
          placeOutline(polygon, handles, quad);
          commit();
        });
      });
    }

    async function loadImage(file: File, preset?: Quad): Promise<void> {
      clearImages();
      stage = 'processing';
      render();
      try {
        originalCanvas = await fileToCanvas(file);
      } catch {
        fail('scan.imageLoadFailed');
        return;
      }
      if (settled) return;
      // The uploaded file itself is the original; it is never modified.
      originalFile = file;
      // Display the uploaded photo immediately, while its edges are detected.
      showOriginal();
      await beginReview(null, preset);
    }

    // ---- controls ------------------------------------------------------------

    shutter.addEventListener('click', () => void capture());
    switchBtn.addEventListener('click', () => {
      facing = facing === 'environment' ? 'user' : 'environment';
      void startCamera();
    });
    uploadBtn.addEventListener('click', () => {
      const upload = request.onUploadInstead;
      finish(null);
      upload?.();
    });

    tabs.forEach((tab) =>
      tab.addEventListener('click', async () => {
        const next = tab.dataset.output as ScanOutput;
        if (stage !== 'review' || next === output) return;
        output = next;
        view = 'result';
        render();
        await regenerate();
      })
    );

    modeButtons.forEach((button) =>
      button.addEventListener('click', async () => {
        if (stage !== 'review' || button.dataset.mode === mode) return;
        mode = button.dataset.mode as ScanMode;
        render();
        await regenerate();
      })
    );

    adjustBtn.addEventListener('click', () => {
      if (stage !== 'review') return;
      view = view === 'adjust' ? 'result' : 'adjust';
      // Once the user has placed the corners, the "not found" note has done its job.
      note = '';
      render();
      if (view === 'adjust') outline?.handles[0].focus({ preventScroll: true });
    });

    retakeBtn.addEventListener('click', () => {
      if (request.source === 'camera') {
        // Discard this capture entirely and go back to live detection.
        clearImages();
        view = 'result';
        quality = null;
        void startCamera();
      } else {
        picker.click();
      }
    });

    picker.addEventListener('change', () => {
      const file = picker.files?.[0];
      picker.value = '';
      if (file) void loadImage(file);
    });

    removeBtn.addEventListener('click', () => finish(null));

    useBtn.addEventListener('click', () => {
      if (stage !== 'review' || !processedBlob || !originalFile || !quad) return;
      finish({
        file: new File([processedBlob], `${request.fileStem}_scan.jpg`, { type: 'image/jpeg' }),
        original: originalFile,
        quad: quad.map((p) => ({ ...p })) as Quad,
        mode,
        output,
        detected,
        source: request.source,
      });
    });

    // ---- start ---------------------------------------------------------------

    paintLabels();
    render();
    document.body.appendChild(overlay);
    if (request.image) void loadImage(request.image, request.quad);
    else void startCamera();
  });
}

// ===========================================================================
// Viewer for an attached scan
// ===========================================================================

export interface ScanViewerRequest {
  title: string;
  /** Object URL of the attached (processed) image. */
  imageUrl: string;
  imageName: string;
  scan?: { original: File; quad: Quad; output: ScanOutput };
  /** Each action runs inside the click, so file pickers can open. */
  onAdjust?: () => void;
  onRetake: () => void;
  onRemove: () => void;
}

export function openScanViewer(request: ScanViewerRequest): void {
  let view: 'scanned' | 'original' = 'scanned';
  let originalUrl: string | null = null;

  const overlay = document.createElement('div');
  overlay.className = 'cammodal scanner scanviewer';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.innerHTML = `
    <div class="camsheet scansheet">
      <div class="camhead">
        <button type="button" class="camclose scanback">${backIcon()}<span>${escapeHtml(t('scan.back'))}</span></button>
        <h3>${escapeHtml(request.title)}</h3>
      </div>
      <p class="rptlabel scanreviewtitle">${escapeHtml(request.imageName)}</p>
      ${
        request.scan?.output === 'cropped'
          ? `<div class="scantabs" role="tablist">
              <button type="button" role="tab" data-view="scanned">${escapeHtml(t('scan.view.scanned'))}</button>
              <button type="button" role="tab" data-view="original">${escapeHtml(t('scan.view.original'))}</button>
            </div>`
          : ''
      }
      <div class="camstage scanpreview">
        <img class="scanimg" alt="${escapeHtml(t('scan.previewAlt', { doc: request.title }))}" src="${escapeHtml(request.imageUrl)}">
        <div class="scanorig" hidden></div>
      </div>
      <div class="camactions scanactions">
        ${request.scan?.output === 'cropped' && request.onAdjust ? `<button type="button" class="act ghost" data-act="adjust">${escapeHtml(t('scan.adjust'))}</button>` : ''}
        <button type="button" class="act ghost" data-act="retake">${escapeHtml(t('scan.retake'))}</button>
        <button type="button" class="act ghost" data-act="remove">${escapeHtml(t('scan.remove'))}</button>
        <button type="button" class="act" data-act="close">${escapeHtml(t('scan.close'))}</button>
      </div>
    </div>`;

  const img = overlay.querySelector<HTMLImageElement>('.scanimg')!;
  const origHolder = overlay.querySelector<HTMLDivElement>('.scanorig')!;
  const tabs = Array.from(overlay.querySelectorAll<HTMLButtonElement>('.scantabs button'));

  function render(): void {
    img.hidden = view !== 'scanned';
    origHolder.hidden = view !== 'original';
    tabs.forEach((tab) => tab.setAttribute('aria-selected', String(tab.dataset.view === view)));
  }

  async function showOriginal(): Promise<void> {
    if (!request.scan || originalUrl) return;
    originalUrl = URL.createObjectURL(request.scan.original);
    const size = await createImageBitmap(request.scan.original, { imageOrientation: 'from-image' })
      .then((bitmap) => {
        const dims = { width: bitmap.width, height: bitmap.height };
        bitmap.close();
        return dims;
      })
      .catch(() => null);
    if (!size) return;
    // Corners were stored against the processing canvas, which may be scaled
    // down from very large originals; draw the outline in that space.
    const scale = Math.min(1, Math.sqrt(MAX_PROCESS_PIXELS / (size.width * size.height)));
    const outline = buildOutlineSvg(size.width * scale, size.height * scale, originalUrl);
    outline.handles.forEach((h) => h.remove());
    placeOutline(outline.polygon, [], request.scan.quad);
    origHolder.appendChild(outline.svg);
  }

  function close(): void {
    if (originalUrl) URL.revokeObjectURL(originalUrl);
    document.removeEventListener('keydown', onKey);
    overlay.remove();
  }

  function onKey(event: KeyboardEvent): void {
    if (event.key === 'Escape') close();
  }

  tabs.forEach((tab) =>
    tab.addEventListener('click', async () => {
      view = tab.dataset.view as 'scanned' | 'original';
      if (view === 'original') await showOriginal();
      render();
    })
  );

  overlay.querySelector('.camclose')!.addEventListener('click', close);
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) close();
  });
  overlay.querySelectorAll<HTMLButtonElement>('[data-act]').forEach((button) =>
    button.addEventListener('click', () => {
      const act = button.dataset.act;
      close();
      if (act === 'adjust') request.onAdjust?.();
      if (act === 'retake') request.onRetake();
      if (act === 'remove') request.onRemove();
    })
  );
  document.addEventListener('keydown', onKey);

  render();
  document.body.appendChild(overlay);
  overlay.querySelector<HTMLButtonElement>('[data-act="close"]')!.focus();
}
