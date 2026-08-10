import { useLiveStatus } from "./use-live-status";

// useCorpusEmpty — the single source of truth for the first-launch empty-state
// signal (Task 6.5, predicate fixed by ADR-0047/T4). The engine's event store
// is range-independent: when it holds zero events every report is empty. But
// `hasData: false` alone is NOT the corpus-empty fact — the sidecar's first
// status frame carries it while the cold-start scan is still running, which
// painted the "No Claude usage data yet" card at every boot for users WITH
// data. Only after `ready` (the local scan + replica load settled) does
// `hasData: false` provably mean "scanned, genuinely empty". The four pages
// (Live / Sessions / Projects / Blocks) call this and render `<EmptyState />`
// when it is true.

// `=== true` / `=== false`, NOT truthiness: both fields are `null` until the
// first `status:changed` SSE frame, and an unknown-yet status must keep the
// normal page layout, never flash the card. (Post-gate the pages only mount
// once `ready` is true, so the `ready` guard is mostly belt-and-suspenders —
// it keeps the predicate honest where the gate isn't in front, e.g. tests.)
export function corpusIsEmpty(ready: boolean | null, hasData: boolean | null): boolean {
  return ready === true && hasData === false;
}

export function useCorpusEmpty(): boolean {
  return useLiveStatus((s) => corpusIsEmpty(s.ready, s.hasData));
}
