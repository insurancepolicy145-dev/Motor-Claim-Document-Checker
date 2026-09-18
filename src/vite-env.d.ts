/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_AI_API_KEY?: string;
  /** Optional override, e.g. the URL of a server-side proxy. */
  readonly VITE_AI_API_URL?: string;
  /** 'anthropic' or 'gemini'. Auto-detected from the key when unset. */
  readonly VITE_AI_PROVIDER?: string;
  /** Overrides the default model for the active provider. */
  readonly VITE_AI_MODEL?: string;
  /** Vite built-ins, declared here because this file augments ImportMetaEnv. */
  readonly DEV: boolean;
  readonly PROD: boolean;
  readonly MODE: string;
}

/**
 * mammoth ships a browser bundle without its own types. Only extractRawText is
 * used, so it is declared narrowly rather than pulled in as `any`.
 */
declare module 'mammoth/mammoth.browser' {
  interface RawTextResult {
    value: string;
    messages: Array<{ message: string }>;
  }
  const mammoth: {
    extractRawText(input: { arrayBuffer: ArrayBuffer }): Promise<RawTextResult>;
  };
  export default mammoth;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/**
 * Vite handles CSS imports. Declared explicitly because augmenting
 * ImportMetaEnv above stops the ambient vite/client CSS module declarations
 * from being picked up.
 */
declare module '*.css';
