import { msg } from '../i18n/types';
import type { Message } from '../i18n/types';

/**
 * DOCX handling.
 *
 * A .docx is a zip of XML, so its text can be pulled out directly in the
 * browser and sent to the reader as text rather than as an image. That is both
 * faster and more accurate than rendering the page and reading it back, and it
 * preserves the text exactly as written.
 *
 * Legacy .doc is a different, binary format with no dependable browser parser;
 * it is rejected during validation with a message telling the user to save as
 * .docx or photograph the page.
 */

export interface DocxExtraction {
  text: string;
  /** Warnings mammoth raised, e.g. unsupported styles. */
  warnings: string[];
}

export class DocxExtractionError extends Error {
  readonly message_: Message;
  constructor(message: Message, fallback: string) {
    super(fallback);
    this.name = 'DocxExtractionError';
    this.message_ = message;
  }
}

/** Collapses runs of blank lines so the prompt is not padded with whitespace. */
function tidy(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export async function extractDocxText(file: File): Promise<DocxExtraction> {
  let raw: { value: string; messages: Array<{ message: string }> };

  try {
    // Loaded on demand: mammoth is a large dependency and most claims never
    // include a Word document, so it should not sit in the initial bundle.
    const { default: mammoth } = await import('mammoth/mammoth.browser');
    const arrayBuffer = await file.arrayBuffer();
    raw = await mammoth.extractRawText({ arrayBuffer });
  } catch {
    throw new DocxExtractionError(msg('err.corrupt'), 'DOCX could not be parsed.');
  }

  const text = tidy(raw.value ?? '');
  if (text.length === 0) {
    throw new DocxExtractionError(msg('err.docEmpty'), 'DOCX contained no text.');
  }

  return {
    text,
    warnings: (raw.messages ?? []).map((m) => m.message).filter(Boolean),
  };
}
