/**
 * Message types.
 *
 * The application is English-only, but user-facing text still goes through a
 * single string table rather than being scattered through the components. That
 * keeps wording consistent and reviewable in one place, and it is what lets the
 * validator return message keys instead of finished sentences.
 */

/** Values substituted into a message, e.g. {count} or {name}. */
export type MessageParams = Record<string, string | number>;

/**
 * A message the application can render.
 *
 * The validator and the readers emit these rather than finished sentences, so
 * wording lives in the string table and the logic stays free of prose.
 */
export interface Message {
  key: string;
  params?: MessageParams;
}

export function msg(key: string, params?: MessageParams): Message {
  return params ? { key, params } : { key };
}
