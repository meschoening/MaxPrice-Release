// The corpus-empty fact (predicate fixed by ADR-0047/T4): the engine's event
// store is range-independent, so when it holds zero events every report is
// empty. But `hasData: false` alone is NOT that fact — the sidecar's first
// status frame carries it while the cold-start scan is still running, which
// painted the "No Claude usage data yet" card at every boot for users WITH
// data. Only after `ready` (the local scan + replica load settled) does
// `hasData: false` provably mean "scanned, genuinely empty".
//
// `=== true` / `=== false`, NOT truthiness: both fields are `null` until the
// first `status:changed` SSE frame, and an unknown-yet status must keep the
// normal page layout, never flash the card. (Post-gate the pages only mount
// once `ready` is true, so the `ready` guard is mostly belt-and-suspenders —
// it keeps the predicate honest where the gate isn't in front, e.g. tests.)
export function corpusIsEmpty(ready: boolean | null, hasData: boolean | null): boolean {
  return ready === true && hasData === false;
}
