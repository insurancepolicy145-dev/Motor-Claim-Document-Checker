import { en } from './locales/en';
import type { TranslationKey } from './locales/en';
import type { Message, MessageParams } from './types';

export * from './types';
export type { TranslationKey } from './locales/en';

/** Locale used for date formatting. */
const LOCALE_TAG = 'en-IN';

function interpolate(template: string, params?: MessageParams): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match
  );
}

/** Keys already reported, so a missing label warns once rather than every repaint. */
const reportedGaps = new Set<string>();

/**
 * Looks up a key in the string table. A missing key is reported to the console
 * in development and rendered as the key itself, so a gap is visible rather
 * than silently blank. These checks are dropped from production builds.
 */
export function t(key: TranslationKey | string, params?: MessageParams): string {
  const template = (en as Record<string, string>)[key];

  if (template === undefined || template === '') {
    if (import.meta.env.DEV && !reportedGaps.has(String(key))) {
      reportedGaps.add(String(key));
      console.warn(`[strings] missing key "${key}"`);
    }
    return String(key);
  }

  return interpolate(template, params);
}

/** Renders a Message emitted by the validator or the readers. */
export function tm(message: Message | null | undefined): string {
  if (!message) return '';
  return t(message.key, message.params);
}

/** Sets <html lang> for screen readers and font fallback. */
export function applyDocumentLanguage(): void {
  document.documentElement.lang = LOCALE_TAG;
}

/** Date formatted as DD/MM/YYYY. */
export function formatDateLocalized(date: Date | null): string {
  if (!date) return '—';
  return date.toLocaleDateString(LOCALE_TAG, {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
}

/** Date and time, e.g. "17/09/2026, 02:45 pm". */
export function formatDateTimeLocalized(date: Date): string {
  return date.toLocaleString(LOCALE_TAG, {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Human file size, e.g. "2.4 MB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Development helper: reports any string-table entry that is present but
 * blank. A no-op in production builds.
 */
export function auditStrings(): void {
  if (!import.meta.env.DEV) return;
  const keys = Object.keys(en);
  const blank = keys.filter((k) => !String((en as Record<string, string>)[k]).trim());
  if (blank.length) {
    console.error(`[strings] ${blank.length} blank entries: ${blank.slice(0, 5).join(', ')}`);
  } else {
    console.info(`[strings] string table complete — ${keys.length} entries.`);
  }
}

applyDocumentLanguage();
