import { msg } from '../i18n/types';
import type { Message } from '../i18n/types';

/**
 * Model provider abstraction.
 *
 * The two supported APIs differ in endpoint, authentication, request shape and
 * response shape, but the application only ever needs "send some parts, get
 * text back". Keeping that difference in one file means the reader and the
 * translator stay provider-agnostic.
 */

export type Provider = 'anthropic' | 'gemini';

const API_KEY: string | undefined = import.meta.env.VITE_AI_API_KEY;
const CONFIGURED_PROVIDER = import.meta.env.VITE_AI_PROVIDER as Provider | undefined;
const CONFIGURED_MODEL = import.meta.env.VITE_AI_MODEL as string | undefined;
const CONFIGURED_URL = import.meta.env.VITE_AI_API_URL as string | undefined;

const DEFAULT_MODEL: Record<Provider, string> = {
  anthropic: 'claude-sonnet-4-6',
  gemini: 'gemini-2.5-flash',
};

/**
 * Models to try in order when the configured one is not available to the key.
 *
 * Which Gemini models a key can reach varies by project and by API version, and
 * an unavailable name comes back as a 404 rather than anything more helpful.
 * Rather than making the user guess, fall through a short list. An explicit
 * VITE_AI_MODEL disables this.
 */
const MODEL_FALLBACKS: Record<Provider, string[]> = {
  anthropic: ['claude-sonnet-4-6'],
  gemini: ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-flash-latest', 'gemini-2.5-pro'],
};

function modelsToTry(): string[] {
  if (CONFIGURED_MODEL) return [CONFIGURED_MODEL];
  return MODEL_FALLBACKS[detectProvider()];
}

/**
 * Works out which API the key belongs to.
 *
 * Anthropic keys start "sk-ant-". Google keys start "AIza" (classic) or "AQ."
 * (the newer AI Studio format). An explicit VITE_AI_PROVIDER always wins, so a
 * proxy with an unrecognizable key can still be pointed at the right protocol.
 */
export function detectProvider(): Provider {
  if (CONFIGURED_PROVIDER === 'anthropic' || CONFIGURED_PROVIDER === 'gemini') {
    return CONFIGURED_PROVIDER;
  }
  const key = API_KEY ?? '';
  if (key.startsWith('sk-ant-')) return 'anthropic';
  if (key.startsWith('AIza') || key.startsWith('AQ.')) return 'gemini';
  return 'anthropic';
}

export function hasReadingService(): boolean {
  return Boolean(API_KEY);
}

/**
 * Development-only report of what configuration was actually picked up.
 *
 * Environment variables are read at build time, so a missing key almost always
 * means the .env file was not found or the dev server was not restarted. This
 * says which of those it is instead of leaving a silently hidden button.
 */
export function logProviderStatus(): void {
  if (!import.meta.env.DEV) return;

  if (!API_KEY) {
    console.warn(
      '[provider] No VITE_AI_API_KEY found. Automatic reading is disabled and the ' +
        '"Read documents" button is hidden; use "Enter details by hand" instead.\n' +
        'Checklist: .env sits beside package.json, the line reads VITE_AI_API_KEY=... ' +
        'with no quotes, the file is not named .env.txt, and the dev server was ' +
        'restarted after creating it.'
    );
    return;
  }

  console.info(
    `[provider] key detected (${API_KEY.slice(0, 4)}…, ${API_KEY.length} chars) ` +
      `-> provider "${detectProvider()}", model "${activeModel()}".`
  );
}

export function activeModel(): string {
  return CONFIGURED_MODEL ?? DEFAULT_MODEL[detectProvider()];
}

/** One piece of a request: instruction text, an image, or a PDF. */
export type Part =
  | { kind: 'text'; text: string }
  | { kind: 'image'; mime: string; data: string }
  | { kind: 'pdf'; data: string };

export class ProviderError extends Error {
  readonly localized: Message;
  constructor(localized: Message, fallback: string) {
    super(fallback);
    this.name = 'ProviderError';
    this.localized = localized;
  }
}

// ---------------------------------------------------------------------------
// Request building
// ---------------------------------------------------------------------------

function anthropicBody(parts: Part[], maxTokens: number, model: string): unknown {
  const content = parts.map((part) => {
    if (part.kind === 'text') return { type: 'text', text: part.text };
    if (part.kind === 'pdf') {
      return {
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: part.data },
      };
    }
    return { type: 'image', source: { type: 'base64', media_type: part.mime, data: part.data } };
  });
  return { model, max_tokens: maxTokens, messages: [{ role: 'user', content }] };
}

function geminiBody(parts: Part[], maxTokens: number): unknown {
  const geminiParts = parts.map((part) => {
    if (part.kind === 'text') return { text: part.text };
    const mimeType = part.kind === 'pdf' ? 'application/pdf' : part.mime;
    return { inline_data: { mime_type: mimeType, data: part.data } };
  });
  return {
    contents: [{ role: 'user', parts: geminiParts }],
    generationConfig: {
      maxOutputTokens: maxTokens,
      temperature: 0,
      // Asking for JSON directly reduces the stray prose the parser has to
      // strip out of the reply.
      responseMimeType: 'application/json',
    },
  };
}

function endpointAndHeaders(model: string): { url: string; headers: Record<string, string> } {
  const provider = detectProvider();

  if (provider === 'gemini') {
    const base =
      CONFIGURED_URL ??
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
    // The key goes in the query string rather than an x-goog-api-key header.
    // A custom header makes the CORS preflight stricter, and a rejected
    // preflight surfaces in JavaScript as an indistinguishable network
    // failure. Google's own browser clients pass the key this way.
    const url = CONFIGURED_URL ? base : `${base}?key=${encodeURIComponent(API_KEY ?? '')}`;
    return { url, headers: { 'Content-Type': 'application/json' } };
  }

  return {
    url: CONFIGURED_URL ?? 'https://api.anthropic.com/v1/messages',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY ?? '',
      'anthropic-version': '2023-06-01',
      // Required for Anthropic to accept a call made straight from a browser.
      // Fine for local use; in production the key must sit behind a proxy
      // (see README → Security), and this header should come out with it.
      'anthropic-dangerous-direct-browser-access': 'true',
    },
  };
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

interface AnthropicBlock {
  type: string;
  text?: string;
}

interface GeminiCandidate {
  content?: { parts?: Array<{ text?: string }> };
  finishReason?: string;
}

function readReply(data: unknown): string {
  if (detectProvider() === 'gemini') {
    const candidates = (data as { candidates?: GeminiCandidate[] }).candidates ?? [];
    return candidates
      .flatMap((candidate) => candidate.content?.parts ?? [])
      .map((part) => part.text ?? '')
      .join('');
  }

  const blocks = ((data as { content?: AnthropicBlock[] }).content ?? []).filter(
    (block) => block.type === 'text'
  );
  return blocks.map((block) => block.text ?? '').join('');
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Sends the parts to whichever provider is configured and returns the reply as
 * plain text. Errors are localizable so the interface can show them in the
 * user's language.
 */
export async function callModel(
  parts: Part[],
  maxTokens: number,
  signal?: AbortSignal
): Promise<string> {
  if (!API_KEY) {
    throw new ProviderError(msg('err.noApiKey'), 'No API key configured.');
  }

  const provider = detectProvider();
  const candidates = modelsToTry();
  let lastError: ProviderError | null = null;

  for (const model of candidates) {
    const { url, headers } = endpointAndHeaders(model);
    const body =
      provider === 'gemini' ? geminiBody(parts, maxTokens) : anthropicBody(parts, maxTokens, model);

    let response: Response;
    try {
      response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new ProviderError(msg('err.cancelled'), 'Cancelled by user.');
      }
      // A CORS rejection, a blocked preflight and a genuine connection failure
      // are indistinguishable to JavaScript, so log everything useful rather
      // than leaving the user with "check your connection".
      console.error('[provider] request failed before any HTTP status was returned.', {
        provider,
        model,
        url: url.replace(/key=[^&]*/, 'key=***'),
        cause: error,
        likelyCauses: [
          'The API key is invalid, or the Generative Language API is not enabled on the project.',
          'The key has HTTP-referrer or IP restrictions that exclude localhost.',
          'A browser extension, firewall or proxy is blocking the request.',
          'For Anthropic keys: the API sends no CORS headers, so a proxy is required.',
        ],
      });
      throw new ProviderError(msg('err.network'), 'Network request failed (see console).');
    }

    if (response.ok) {
      const data = await response.json();
      const text = readReply(data);
      if (!text.trim()) {
        // A blocked or truncated reply returns 200 with no text, so surface the
        // whole payload rather than a bare "could not understand".
        console.error('[provider] empty reply.', { provider, model, data });
        throw new ProviderError(msg('err.parse'), 'Provider returned an empty reply.');
      }
      return text;
    }

    let detail = '';
    try {
      detail = (await response.text()).slice(0, 500);
    } catch {
      // Body unreadable; the status alone will have to do.
    }
    console.error(`[provider] HTTP ${response.status} from ${provider} model "${model}".`, detail);

    if (response.status === 401 || response.status === 403) {
      throw new ProviderError(msg('err.badKey'), `Auth failed (${response.status}). ${detail}`);
    }

    lastError = new ProviderError(
      msg('err.readFailed'),
      `Request failed (${response.status}) on model "${model}". ${detail}`
    );

    // Only an unavailable model is worth retrying; anything else would fail
    // identically on the next name.
    if (response.status !== 404) break;
    console.warn(`[provider] model "${model}" unavailable, trying the next one.`);
  }

  throw lastError ?? new ProviderError(msg('err.readFailed'), 'Request failed.');
}
