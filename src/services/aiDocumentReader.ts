import { t } from '../i18n';
import { msg } from '../i18n/types';
import type { Message } from '../i18n/types';
import { ProviderError, callModel, hasReadingService } from './aiProvider';
import type { Part } from './aiProvider';
import type { AttachedFile, DocumentDefinition, ExtractedDocument } from '../types';

export { hasReadingService, detectProvider, activeModel } from './aiProvider';

// ---------------------------------------------------------------------------
// API configuration
//
// The key comes from an environment variable at build time and is never
// hard-coded. See .env.example and the security note in the README.
// ---------------------------------------------------------------------------

/** At most this many files per document are sent in one request. */
const MAX_FILES_PER_DOCUMENT = 4;

/** Below this confidence, a document is reported as needing review. */
export const LOW_CONFIDENCE = 0.4;

/** Carries a localizable reason alongside the technical message. */
export class ReaderError extends Error {
  readonly localized: Message;
  constructor(localized: Message, fallback: string) {
    super(fallback);
    this.name = 'ReaderError';
    this.localized = localized;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
    reader.readAsDataURL(file);
  });
}

/**
 * Builds the extraction prompt.
 *
 * Two things make this multilingual rather than English-only:
 *   1. Each field carries its regional label variants, so the reader matches
 *      the concept ("पंजीकरण संख्या") rather than the English words.
 *   2. Values are required back in the script they were printed in. Nothing is
 *      translated here — translation is a separate, explicit step.
 */
function buildPrompt(def: DocumentDefinition): string {
  const documentName = t(def.nameKey);

  const fieldList = def.fields
    .map((field) => `- ${field}  (${t(`field.${field}`)})`)
    .join('\n');

  return `You are reading a scanned or photographed Indian motor insurance claim document of type "${documentName}".

Extract these fields, using exactly these key names:
${fieldList}

Return ONLY a single JSON object, no markdown fences and no commentary, in exactly this shape:
{
  "documentType": string,
  "confidence": number,
  "originalText": string,
  "fields": { "<key>": string },
  "warnings": string[]
}

Rules:
- "confidence" is 0 to 1: how sure you are this is a genuine, legible "${documentName}".
- "originalText" is the document's text transcribed verbatim, preserving the original wording. Do not summarise it.
- Field VALUES must be given exactly as printed. Copy alphanumerics exactly, with no spaces inside registration, chassis or engine numbers.
- Give every date as DD/MM/YYYY.
- Join a list of values with " / ".
- Use "" for any field that is absent or not legible.
- Put anything doubtful in "warnings", for example "image is blurry", "document appears expired", "registration number not legible".
- If the file is not a "${documentName}" at all, still return the JSON: set "documentType" to what you think it actually is, set a low "confidence", and add a warning explaining the mismatch.`;
}

/** Pulls the JSON object out of a reply that may carry stray text or fences. */
function extractJson(text: string): unknown {
  const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('No JSON object in the reply.');
  }
  return JSON.parse(cleaned.slice(start, end + 1));
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface ReadOptions {
  /** Lets the user cancel a read in progress. */
  signal?: AbortSignal;
}

/**
 * Sends the attached files for one document to the API and returns the
 * structured extraction.
 *
 * Images and PDFs go as documents for the model to read. DOCX files were
 * already turned into text in the browser, so their text is passed through
 * directly, which is both faster and exact for Unicode scripts.
 */
export async function readDocument(
  files: AttachedFile[],
  def: DocumentDefinition,
  options: ReadOptions = {}
): Promise<ExtractedDocument> {
  if (!hasReadingService()) {
    throw new ReaderError(msg('err.noApiKey'), 'No API key configured.');
  }
  if (files.length === 0) {
    throw new ReaderError(msg('err.readFailed'), 'Nothing attached to read.');
  }

  const parts: Part[] = [];

  for (const attached of files.slice(0, MAX_FILES_PER_DOCUMENT)) {
    if (attached.status === 'ERROR') continue;

    if (attached.kind === 'docx') {
      // Text was extracted client-side; send it verbatim.
      parts.push({
        kind: 'text',
        text: `--- Text of attached Word document "${attached.name}" ---\n${attached.extractedText ?? ''}`,
      });
      continue;
    }

    const data = await fileToBase64(attached.file);
    if (attached.kind === 'pdf') {
      parts.push({ kind: 'pdf', data });
    } else {
      parts.push({ kind: 'image', mime: attached.file.type || 'image/jpeg', data });
    }
  }

  if (parts.length === 0) {
    throw new ReaderError(msg('err.readFailed'), 'All attachments failed validation.');
  }

  parts.push({ kind: 'text', text: buildPrompt(def) });

  let text: string;
  try {
    text = await callModel(parts, 2000, options.signal);
  } catch (error) {
    if (error instanceof ProviderError) {
      throw new ReaderError(error.localized, error.message);
    }
    throw new ReaderError(msg('err.readFailed'), 'Read failed.');
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = extractJson(text) as Record<string, unknown>;
  } catch {
    throw new ReaderError(msg('err.parse'), 'Reply was not valid JSON.');
  }

  // Normalize: every declared field present, every value a string.
  const raw = (parsed.fields ?? {}) as Record<string, unknown>;
  const fields: Record<string, string> = {};
  for (const field of def.fields) {
    const value = raw[field];
    fields[field] = value === null || value === undefined ? '' : String(value);
  }

  return {
    documentType: typeof parsed.documentType === 'string' ? parsed.documentType : 'UNKNOWN',
    confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0,
    fields,
    warnings: Array.isArray(parsed.warnings) ? parsed.warnings.map(String) : [],
    originalText: typeof parsed.originalText === 'string' ? parsed.originalText : '',
  };
}
