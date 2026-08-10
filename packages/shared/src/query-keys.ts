import type { CostMode } from "./cost-mode";
import type { Span } from "./intraday";

// Centralized TanStack Query key builders. Part 1's `dailyQueryKey` was an
// ad-hoc shape inside the hook module; Parts 2–5 grow more hooks and need
// one place to invalidate from outside React (Part 3's SSE channel and the
// cost-mode dropdown in Part 2 both reach in via predicate). The first tuple
// element is always the report family — `DATA_QUERY_KEYS` enumerates them,
// so `queryClient.invalidateQueries({ predicate: q =>
// DATA_QUERY_KEYS.has(String(q.queryKey[0])) })` invalidates everything the
// cost-mode change affects without per-key plumbing.

export type DateWindow = { since?: string; until?: string };
// Multi-value as of Part 4: the filter rail's project / model multi-selects
// pass their full arrays through (Part 2 truncated to the first selection). An
// absent or empty array means "no filter". `machines` joins as the third axis
// (ADR-0041 M6) — exact machineId match engine-side; the RENDERER expands
// merge-alias closures before building keys/URLs, so these are raw ids.
export type FilterSubset = { projects?: string[]; models?: string[]; machines?: string[] };
// `tz` (Part 6, ADR-0015) — the IANA zone reports bucket local days into,
// carried alongside `mode`. Optional: an omitted `tz` defaults to the host
// zone sidecar-side, preserving the pre-Part-6 behaviour.
export type QueryInput = DateWindow & FilterSubset & { mode: CostMode; tz?: string };

// Drop empty arrays to `undefined` and sort the surviving ones so the TanStack
// cache key is identical regardless of the order the user picked filters in.
function normalizeList(list: string[] | undefined): string[] | undefined {
  if (!list || list.length === 0) return undefined;
  return [...list].sort();
}

function normalize(input: QueryInput): QueryInput {
  return {
    since: input.since,
    until: input.until,
    mode: input.mode,
    tz: input.tz,
    projects: normalizeList(input.projects),
    models: normalizeList(input.models),
    machines: normalizeList(input.machines),
  };
}

export function dailyKey(input: QueryInput): ["daily", QueryInput] {
  return ["daily", normalize(input)];
}

export function sessionsKey(input: QueryInput): ["sessions", QueryInput] {
  return ["sessions", normalize(input)];
}

export function projectsKey(input: QueryInput): ["projects", QueryInput] {
  return ["projects", normalize(input)];
}

export function blocksKey(input: QueryInput): ["blocks", QueryInput] {
  return ["blocks", normalize(input)];
}

export function dailyByProjectKey(input: QueryInput): ["daily-by-project", QueryInput] {
  return ["daily-by-project", normalize(input)];
}

// The /api/daily-by-machine key (ADR-0041 M6). `byProject` switches the nested
// per-machine project sub-maps (machine + project both selected); it changes
// the body, so it re-keys.
export type DailyByMachineQueryInput = QueryInput & { byProject?: boolean };

export function dailyByMachineKey(
  input: DailyByMachineQueryInput,
): ["daily-by-machine", DailyByMachineQueryInput] {
  return ["daily-by-machine", { ...normalize(input), byProject: input.byProject }];
}

// The `/api/intraday` query input. Unlike the daily-family keys it is NOT keyed
// on a `since`/`until` date window — the intraday endpoint windows itself on a
// fixed `span` (any of the six, ADR-0018), so `span` replaces `since`/`until`
// here. `mode` + the project/model multi-selects are carried the same way as
// the daily keys so a cost-mode change or a filter edit re-keys and refetches.
export type IntradayQueryInput = {
  span: Span;
  mode: CostMode;
  // `tz` (Part 6, ADR-0015) — the `today` span buckets by the local calendar
  // day in this zone (ADR-0020), so `tz` is load-bearing there; the now-relative
  // spans (`15m`/`1h`/`7d`/`30d`) and the server-resolved `block` window ignore
  // it. Kept in the key for every span so a Timezone-setting change re-keys.
  tz?: string;
  // The bucket duration in ms (ADR-0018). Omitted → the endpoint's per-span
  // default (the bars granularity, `INTRADAY_SPANS[span].bucketMs`). The line
  // path passes `lineGranularityFor(span)` (a 15-min floor), so bars and lines
  // for the same span produce DISTINCT keys / payloads.
  bucketMs?: number;
  // Lean-payload flags (ADR-0018). They change the response body, so they must
  // re-key: `includePrevious` controls the ghost `previousBuckets`,
  // `includeByProject` the per-project map. Omitted → the endpoint default
  // (both true, preserving pre-ADR-0018 callers).
  includePrevious?: boolean;
  includeByProject?: boolean;
  // ADR-0041 (M6): the machine group-by's per-machine map. Changes the response
  // body, so it must re-key. Omitted/false → the byMachine-free (pre-M6,
  // byte-identical) payload.
  includeByMachine?: boolean;
} & FilterSubset;

// Normalize the intraday input the same way `normalize` does for the daily
// keys — drop empty filter arrays to `undefined` and sort the survivors so the
// TanStack cache key is order-independent.
function normalizeIntraday(input: IntradayQueryInput): IntradayQueryInput {
  return {
    span: input.span,
    mode: input.mode,
    tz: input.tz,
    bucketMs: input.bucketMs,
    includePrevious: input.includePrevious,
    includeByProject: input.includeByProject,
    includeByMachine: input.includeByMachine,
    projects: normalizeList(input.projects),
    models: normalizeList(input.models),
    machines: normalizeList(input.machines),
  };
}

export function intradayKey(input: IntradayQueryInput): ["intraday", IntradayQueryInput] {
  return ["intraday", normalizeIntraday(input)];
}

// Predicate matching an intraday query key whose `span` is `block` — the one
// intraday family `block:tick` invalidates (the block frame is block-shaped
// data; every other span is now-relative, ADR-0031). Owns the key-shape
// knowledge so `live-stream.ts` invalidates through this helper instead of
// re-inlining the tuple positions + cast, mirroring how the blocks invalidation
// reaches for `BLOCKS_KEY_ROOT` rather than rebuilding the prefix.
export function isBlockSpanIntradayKey(queryKey: readonly unknown[]): boolean {
  return (
    queryKey[0] === "intraday" &&
    (queryKey[1] as Partial<IntradayQueryInput> | undefined)?.span === "block"
  );
}

// Family-root key for the blocks report. `block:tick` events invalidate the
// whole blocks family regardless of filters, so they target this root rather
// than a fully-built `blocksKey` — it prefix-matches every ["blocks", input].
export const BLOCKS_KEY_ROOT = ["blocks"] as const;

// Per-session detail key — keyed by session id alone, not the report filters.
// Part 3 creates the stub so the SSE channel can invalidate ['session', id]
// on a `usage:new` event; Part 5 adds the hook and the data behind it.
//
// Part 5's `useSessionEvents` hook (`apps/desktop/src/state/use-session-events.ts`)
// appends the cost mode as a THIRD element — `["session", id, mode]` — so a
// cost-mode change re-keys and auto-refetches. This two-element form remains
// the *invalidation prefix*: `invalidateQueries({ queryKey: ["session", id] })`
// prefix-matches the three-element streamed key. Keep the return value at two
// elements; the hook composes the third on top of it.
export function sessionKey(id: string): ["session", string] {
  return ["session", id];
}

// Family-root key for the per-session detail report — mirrors BLOCKS_KEY_ROOT.
// A manual rescan (ADR-0019) doesn't know which session ids changed, so it
// invalidates the whole session family by this prefix rather than per-id;
// it prefix-matches every ["session", id] and ["session", id, mode].
export const SESSION_KEY_ROOT = ["session"] as const;

// Predicate target for cost-mode invalidation. Every renderer hook whose data
// depends on `--mode` should use a key whose first element is in this set.
// Including "intraday" here makes both the cost-mode dropdown's invalidation
// predicate AND the Part 3 SSE `usage:new` invalidation (`invalidateDataFamilies`
// in `live-stream.ts`) refresh the intraday chart for free — a live JSONL write
// updates the in-progress bucket, and a cost-mode switch refetches it.
export const DATA_QUERY_KEYS = new Set<string>([
  "daily",
  "daily-by-project",
  "daily-by-machine",
  "intraday",
  "sessions",
  "projects",
  "blocks",
]);
