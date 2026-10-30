import { corpusIsEmpty } from "@maxprice/shared";
import { useLiveStatus } from "./use-live-status";

// useCorpusEmpty — the single source of truth for the first-launch empty-state
// signal (Task 6.5): `corpusIsEmpty` (packages/shared/src/corpus-empty.ts,
// ADR-0047) over the live status's `ready` + `hasData`, never `hasData` alone.
// The four pages (Live / Sessions / Projects / Blocks) call this and render
// `<EmptyState />` when it is true.
export function useCorpusEmpty(): boolean {
  return useLiveStatus((s) => corpusIsEmpty(s.ready, s.hasData));
}
