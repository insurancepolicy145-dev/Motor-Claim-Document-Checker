import { msg } from '../i18n/types';
import type { Message } from '../i18n/types';
import { formatBytes } from '../i18n';

/** Hard ceiling per file. Sending more than this to the reader is pointless. */
export const MAX_FILE_BYTES = 15 * 1024 * 1024;

export type FileKind = 'image' | 'pdf' | 'docx' | 'doc';

export const ACCEPT_ATTRIBUTE =
  'image/jpeg,image/png,image/webp,application/pdf,' +
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/msword';

const IMAGE_TYPES = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp']);
const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const DOC_TYPE = 'application/msword';

/**
 * Browsers report an empty or wrong MIME type often enough that the extension
 * has to be consulted as well.
 */
export function classify(file: File): FileKind | null {
  const mime = (file.type || '').toLowerCase();
  const name = file.name.toLowerCase();

  if (IMAGE_TYPES.has(mime)) return 'image';
  if (mime === 'application/pdf') return 'pdf';
  if (mime === DOCX_TYPE) return 'docx';
  if (mime === DOC_TYPE) return name.endsWith('.docx') ? 'docx' : 'doc';

  if (/\.(jpe?g|png|webp)$/.test(name)) return 'image';
  if (name.endsWith('.pdf')) return 'pdf';
  if (name.endsWith('.docx')) return 'docx';
  if (name.endsWith('.doc')) return 'doc';

  return null;
}

export interface ValidationOutcome {
  ok: boolean;
  kind?: FileKind;
  /** Localizable reason, rendered by the caller in the active locale. */
  error?: Message;
  /** Page count for PDFs, when it could be determined cheaply. */
  pages?: number;
}

function readHead(file: File, bytes: number): Promise<Uint8Array> {
  return file
    .slice(0, bytes)
    .arrayBuffer()
    .then((buffer) => new Uint8Array(buffer));
}

function startsWith(bytes: Uint8Array, signature: number[]): boolean {
  return signature.every((b, i) => bytes[i] === b);
}

function asLatin1(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += String.fromCharCode(b);
  return out;
}

/**
 * Checks a file before it is ever sent anywhere: type, size, emptiness, magic
 * bytes, and PDF encryption. Runs entirely in the browser, so a bad file never
 * leaves the device.
 */
export async function validateFile(file: File): Promise<ValidationOutcome> {
  const kind = classify(file);

  if (!kind) {
    const shown = file.type || file.name.split('.').pop() || 'unknown';
    return { ok: false, error: msg('err.unsupportedType', { type: shown }) };
  }

  if (kind === 'doc') {
    // The legacy binary Word format has no reliable browser-side parser.
    return { ok: false, kind, error: msg('err.docLegacy') };
  }

  if (file.size === 0) {
    return { ok: false, kind, error: msg('err.empty') };
  }

  if (file.size > MAX_FILE_BYTES) {
    return {
      ok: false,
      kind,
      error: msg('err.tooLarge', {
        size: formatBytes(file.size),
        limit: formatBytes(MAX_FILE_BYTES),
      }),
    };
  }

  // ---- magic-byte checks catch renamed and truncated files ----
  try {
    const head = await readHead(file, 1024);

    if (kind === 'pdf' && !startsWith(head, [0x25, 0x50, 0x44, 0x46])) {
      return { ok: false, kind, error: msg('err.corrupt') };
    }

    // DOCX is a zip; "PK\x03\x04" is the local file header.
    if (kind === 'docx' && !startsWith(head, [0x50, 0x4b, 0x03, 0x04])) {
      return { ok: false, kind, error: msg('err.corrupt') };
    }

    if (kind === 'image') {
      const jpeg = startsWith(head, [0xff, 0xd8, 0xff]);
      const png = startsWith(head, [0x89, 0x50, 0x4e, 0x47]);
      const webp = asLatin1(head.slice(0, 4)) === 'RIFF' && asLatin1(head.slice(8, 12)) === 'WEBP';
      if (!jpeg && !png && !webp) {
        return { ok: false, kind, error: msg('err.corrupt') };
      }
    }

    if (kind === 'pdf') {
      const encrypted = await isEncryptedPdf(file);
      if (encrypted) {
        return { ok: false, kind, error: msg('err.pdfPassword') };
      }
      return { ok: true, kind, pages: await countPdfPages(file) };
    }
  } catch {
    return { ok: false, kind, error: msg('err.corrupt') };
  }

  return { ok: true, kind };
}

/**
 * Looks for an /Encrypt entry in the trailer. Reading the tail is enough for
 * ordinary PDFs and avoids pulling a full parser into the bundle.
 */
async function isEncryptedPdf(file: File): Promise<boolean> {
  const tailSize = Math.min(file.size, 4096);
  const tail = new Uint8Array(await file.slice(file.size - tailSize).arrayBuffer());
  return asLatin1(tail).includes('/Encrypt');
}

/** Rough page count from /Type /Page occurrences. Best-effort only. */
async function countPdfPages(file: File): Promise<number | undefined> {
  try {
    const text = asLatin1(new Uint8Array(await file.arrayBuffer()));
    const matches = text.match(/\/Type\s*\/Page[^s]/g);
    return matches ? matches.length : undefined;
  } catch {
    return undefined;
  }
}
