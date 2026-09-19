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

// ---------------------------------------------------------------------------
// Document-type icons
//
// Simple line icons drawn for this app (24×24 grid, 1.8 px stroke). They mark
// which document a card is for, so they are decorative: the card heading next
// to them carries the name for screen readers.
// ---------------------------------------------------------------------------

function line(body: string): string {
  return `<svg class="icon docicon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" focusable="false" aria-hidden="true">${body}</svg>`;
}

const PAGE = '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/>';

const DOCUMENT_ICONS: Record<string, string> = {
  // Registration certificate: a document.
  RC: line(`${PAGE}<path d="M9 12h6M9 16h6"/>`),
  // Driving licence: an ID card.
  DL: line(
    '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="11" r="2"/>' +
      '<path d="M6.3 16.2c.6-1.5 1.6-2.2 2.7-2.2s2.1.7 2.7 2.2"/><path d="M14 10h4M14 13.5h4"/>'
  ),
  // Permit: a clipboard.
  PERMIT: line(
    '<rect x="5.5" y="4.5" width="13" height="16.5" rx="2"/><path d="M9 4.5V3h6v1.5"/>' +
      '<path d="M8.5 10.5h7M8.5 14.5h4.5"/>'
  ),
  // Policy: a shield with a tick.
  POLICY: line('<path d="M12 3l7 3v5c0 4.6-3 8.1-7 10-4-1.9-7-5.4-7-10V6z"/><path d="M9 12l2 2 4-4"/>'),
  // Fitness certificate: a certificate with a seal.
  FITNESS: line(
    '<path d="M11 17H4.5A1.5 1.5 0 0 1 3 15.5v-10A1.5 1.5 0 0 1 4.5 4h15A1.5 1.5 0 0 1 21 5.5V10"/>' +
      '<path d="M7 8h10M7 11.5h5"/><circle cx="17" cy="14.5" r="3"/><path d="M15.4 17l-.6 4 2.2-1.2 2.2 1.2-.6-4"/>'
  ),
  // FC validity: a calendar with a tick.
  FC_VALIDITY: line(
    '<rect x="4" y="5" width="16" height="16" rx="2"/><path d="M4 9.5h16M8.5 3v4M15.5 3v4"/><path d="M9 15l2 2 4-4"/>'
  ),
  // Photographs: a picture frame (kept distinct from the capture button's camera).
  PHOTOGRAPHS: line(
    '<rect x="3" y="4.5" width="18" height="15" rx="2"/><circle cx="8.5" cy="9.5" r="1.8"/>' +
      '<path d="M21 16l-5-5-8.5 8.5"/>'
  ),
  // Pollution certificate: a leaf.
  PUC: line('<path d="M5 19C5 11 10.5 5.5 19 5c0 8.5-5 14-13 14z"/><path d="M5 19l7.5-7.5"/>'),
  // Police report / FIR: a document with an alert mark.
  POLICE_REPORT: line(`${PAGE}<path d="M12 10v3.5M12 17h.01"/>`),
  // Invoice: a receipt.
  INVOICE: line('<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6M9 16h3"/>'),
  // Load / lorry challan: a truck.
  CHALLAN: line(
    '<path d="M2.5 6h11v10h-11z"/><path d="M13.5 9.5h4l3 3.5v3h-7"/>' +
      '<circle cx="6.5" cy="17.5" r="1.8"/><circle cx="17" cy="17.5" r="1.8"/>'
  ),
  // Weighment bill: a balance scale.
  WEIGHMENT: line(
    '<path d="M12 4v16M8 20h8M5 7h14"/><path d="M5 7l-2.5 6a2.5 2.5 0 0 0 5 0z"/>' +
      '<path d="M19 7l-2.5 6a2.5 2.5 0 0 0 5 0z"/>'
  ),
  // Quarterly tax: a rupee sign.
  QUARTERLY_TAX: line('<path d="M7 4.5h10M7 9h10"/><path d="M9.5 4.5c3.2 0 5 1.6 5 4.5s-1.8 4.5-5 4.5H7l7.5 7"/>'),
  // National permit with authorization: a globe (national reach).
  NATIONAL_PERMIT_AUTH: line(
    '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/>' +
      '<path d="M12 3c2.4 2.5 3.6 5.5 3.6 9s-1.2 6.5-3.6 9c-2.4-2.5-3.6-5.5-3.6-9S9.6 5.5 12 3z"/>'
  ),
  // Passenger list: people.
  PASSENGER_LIST: line(
    '<circle cx="9" cy="8" r="3"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/>' +
      '<path d="M16 5a3 3 0 0 1 0 6"/><path d="M18 14.3c1.8.8 3 2.7 3 5.2"/>'
  ),
  // AITC (tourist permit): a coach.
  AITC: line(
    '<rect x="4" y="3.5" width="16" height="14" rx="2.5"/><path d="M4 11h16"/>' +
      '<path d="M7.5 17.5v2.5M16.5 17.5v2.5"/><path d="M8 14.3h.01M16 14.3h.01"/>'
  ),
};

/** Line icon for a document type; a plain document for anything unlisted. */
export function documentIcon(key: string): string {
  return DOCUMENT_ICONS[key] ?? line(`${PAGE}<path d="M9 12h6M9 16h6"/>`);
}
