/**
 * Inline SVG icons (Material Design icon paths, Apache License 2.0).
 *
 * The app has no icon library, so icons are inlined. They draw with
 * `currentColor`, which lets CSS set their colour per state (default, hover,
 * disabled, captured) without separate image files.
 */

function svg(path: string, extra = ''): string {
  return `<svg class="icon" viewBox="0 0 24 24" fill="currentColor" focusable="false" ${extra}>${path}</svg>`;
}

/** Material "photo_camera". */
export const CAMERA_PATH =
  '<circle cx="12" cy="12" r="3.2"/><path d="M9 2 7.17 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2h-3.17L15 2H9zm3 15c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5z"/>';

/**
 * Camera icon. The surrounding button carries the accessible name, so the
 * graphic itself is hidden from assistive technology; `alt` records what it
 * depicts for anyone inspecting the markup.
 */
export function cameraIcon(): string {
  return svg(CAMERA_PATH, 'aria-hidden="true" alt="Camera"');
}

export function backIcon(): string {
  return svg('<path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/>', 'aria-hidden="true"');
}

export function retakeIcon(): string {
  return svg(
    '<path d="M17.65 6.35A7.958 7.958 0 0 0 12 4a8 8 0 1 0 7.73 10h-2.08A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/>',
    'aria-hidden="true"'
  );
}

export function checkIcon(): string {
  return svg('<path d="M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>', 'aria-hidden="true"');
}

export function flashIcon(): string {
  return svg('<path d="M7 2v11h3v9l7-12h-4l4-8z"/>', 'aria-hidden="true"');
}
