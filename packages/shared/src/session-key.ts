// The `(projectSlug, sessionId)` pair key, joined on NUL.
//
// The joiner is not cosmetic: a project slug is a path with every
// non-alphanumeric mapped to `-`, and a session id is a filename, so any
// PRINTABLE joiner is a character one of them could contain. `\u0000` cannot
// occur in either, so the encoding is unambiguous — `^@`, a printable
// two-character stand-in for NUL, is not: `{slug:"a", sessionId:"b^@c"}` and
// `{slug:"a^@b", sessionId:"c"}` produce the same key under it, and
// `projectSlug` on the wire is only `z.string().min(1)`.
//
// M6 shipped exactly this class of bug in the machine x project grid — keys
// stored under NUL, looked up under a space — and the fix was to have ONE
// helper rather than a convention. This is that helper: every producer and
// every consumer of a session pair key goes through it, across the sidecar's
// unbacked-storage classifier, the hub's forget route, and the renderer, so no
// two sides can drift.
// Named `sessionPairKey`, not `sessionKey`: the barrel already exports a
// `sessionKey(id)` TanStack query-key builder from `query-keys.ts`, and a
// re-export collision there is a typecheck error across every workspace.
export function sessionPairKey(projectSlug: string, sessionId: string): string {
  return `${projectSlug}\u0000${sessionId}`;
}
