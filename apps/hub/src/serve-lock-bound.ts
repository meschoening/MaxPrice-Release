// How long serve's take of serve.lock waits out another holder before it
// calls the lock lost, exit 5, and how often it asks again (ADR-0127 §2,
// §3; serve-lock.ts's takeServeLock). A module of its own, importing
// nothing, so cli.ts's help can name the bound without an import cycle
// through serve-lock.ts, which imports cli.ts.
export const SERVE_LOCK_RETRY_MS = 500;
export const SERVE_LOCK_POLL_MS = 25;
