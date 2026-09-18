/**
 * Loads OpenCV.js on demand.
 *
 * OpenCV is bundled with the app as a static asset (no CDN, no API key) and
 * only fetched the first time a scanner opens. Every caller shares one load.
 *
 * Two details matter here:
 *
 * 1. It is loaded as a classic <script>, not through the module bundler. The
 *    file is a 10 MB Emscripten build; bundler interop copies its module
 *    object, including a `then` method, which makes `await` chase it forever
 *    and freezes the page.
 * 2. For the same reason the module is never passed straight to a promise's
 *    resolve. It is always wrapped as `{ cv }`.
 */

import opencvUrl from '@techstark/opencv-js/dist/opencv.js?url';

// OpenCV.js ships very broad generated typings; the scanner uses a small,
// well-defined subset, so it is typed loosely at this boundary.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type OpenCv = any;

export interface OpenCvHandle {
  cv: OpenCv;
}

const LOAD_TIMEOUT_MS = 60_000;

let pending: Promise<OpenCvHandle> | null = null;

function injectScript(): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>('script[data-opencv]');
    if (existing?.dataset.loaded === 'true') {
      resolve();
      return;
    }
    const script = existing ?? document.createElement('script');
    script.addEventListener('load', () => {
      script.dataset.loaded = 'true';
      resolve();
    });
    script.addEventListener('error', () => reject(new Error('OpenCV script failed to load')));
    if (!existing) {
      script.src = opencvUrl;
      script.async = true;
      script.dataset.opencv = 'true';
      document.head.appendChild(script);
    }
  });
}

/** Resolves once the WebAssembly runtime is ready, without ever resolving *with* the module. */
function whenReady(module: OpenCv): Promise<OpenCvHandle> {
  return new Promise((resolve) => {
    const done = () => resolve({ cv: module });
    if (module.Mat) {
      done();
      return;
    }
    const previous = module.onRuntimeInitialized;
    module.onRuntimeInitialized = () => {
      if (typeof previous === 'function') previous();
      done();
    };
    // Belt and braces: if the runtime finished between the check and the
    // hook being installed, notice it anyway.
    const poll = setInterval(() => {
      if (module.Mat) {
        clearInterval(poll);
        done();
      }
    }, 100);
  });
}

async function load(): Promise<OpenCvHandle> {
  await injectScript();
  const global: OpenCv = (window as unknown as { cv?: OpenCv }).cv;
  if (!global) throw new Error('OpenCV did not initialise');

  if (global instanceof Promise) {
    // Some builds expose a promise for the module. Take the value through a
    // plain wrapper so it is not adopted as a thenable.
    const module = await new Promise<OpenCvHandle>((resolve, reject) => {
      global.then((value: OpenCv) => resolve({ cv: value }), reject);
    });
    return whenReady(module.cv);
  }
  return whenReady(global);
}

export function loadOpenCv(): Promise<OpenCvHandle> {
  if (!pending) {
    pending = new Promise<OpenCvHandle>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('OpenCV load timed out')), LOAD_TIMEOUT_MS);
      load().then(
        (handle) => {
          clearTimeout(timer);
          resolve(handle);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        }
      );
    });
    // Allow a later attempt (e.g. after a flaky network on first fetch).
    pending.catch(() => {
      pending = null;
    });
  }
  return pending;
}

/** Starts loading in the background without waiting, e.g. when a scanner opens. */
export function preloadOpenCv(): void {
  void loadOpenCv().catch(() => undefined);
}
