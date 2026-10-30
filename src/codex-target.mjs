// A Codex chat target is bound only when a caller names it explicitly. Nothing here reads
// metadata, environment variables or the current conversation, so an agent can never inherit
// a callback destination it was not given.
export const CODEX_THREAD_ID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;

/** @returns {boolean} True when the value is a Codex task UUID. */
export function isCodexThreadId(value) {
  return typeof value === 'string' && CODEX_THREAD_ID.test(value);
}
