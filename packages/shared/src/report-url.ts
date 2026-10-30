import type { CostMode } from "./cost-mode";
import type { Span } from "./intraday";
import type { DailyByMachineQueryInput, IntradayQueryInput, QueryInput } from "./query-keys";

// The pure pieces of the ADR-0004 report hooks (ADR-0118 §7): each report's
// loose input, its normalization into the canonical query input, and its URL
// builder. The renderer's hooks (`apps/desktop/src/state/`) keep the key
// wrappers, the fetches and the `useQuery` wrappers, and import these.

// The uniform query-input shape accepted by every /api/<report> hook. `mode`
// is optional here and defaults to "auto" in `normalize`; `projects` /
// `models` are the filter rail's multi-select passthroughs (Part 4).
export type ReportQueryInput = {
  since?: string;
  until?: string;
  mode?: CostMode;
  // `tz` (Part 6, ADR-0015) — the IANA zone reports bucket local days into.
  // Optional; an omitted `tz` defaults to the host zone sidecar-side.
  tz?: string;
  projects?: string[];
  models?: string[];
  // The machine filter axis (ADR-0041 M6) — raw machine ids post-alias-expansion
  // (the renderer expands merge-alias closures before calling). Serialized as
  // repeated `machine=` params, mirroring `models`.
  machines?: string[];
  // The resolved Organization scope (#278) — a tracked uuid or "all"; absent =
  // the Home organization. Serialized as one `organization=` param.
  organization?: string;
};

// Collapse a hook's loose input into the canonical QueryInput used for both
// the cache key and the URL params, defaulting `mode` to "auto". One copy —
// the key, the URL, and the fetch all normalize identically so TanStack's
// cache keying stays stable (ADR-0004).
export function normalize(opts: ReportQueryInput): QueryInput {
  return {
    since: opts.since,
    until: opts.until,
    mode: opts.mode ?? "auto",
    tz: opts.tz,
    projects: opts.projects,
    models: opts.models,
    machines: opts.machines,
    organization: opts.organization,
  };
}

// Shared serializer for the filter params common to every report URL — `mode`,
// the optional `tz`, the repeated `project` / `model` / `machine` multi-selects,
// and the optional `organization` scope (#278). Called
// by `buildReportUrl` and `buildIntradayUrl` (below) AFTER each has
// set its own window param (since/until vs span), so the produced query strings
// stay byte-identical to the two hand-rolled copies this replaced (f21).
export function appendFilterParams(
  params: URLSearchParams,
  input: {
    mode: string;
    tz?: string;
    projects?: string[];
    models?: string[];
    machines?: string[];
    organization?: string;
  },
): void {
  params.set("mode", input.mode);
  if (input.tz) params.set("tz", input.tz);
  // Multi-value filters serialize as repeated params: ?project=a&project=b.
  // The sidecar reads them back with Hono's c.req.queries(key).
  for (const p of input.projects ?? []) params.append("project", p);
  for (const m of input.models ?? []) params.append("model", m);
  // ADR-0041 (M6): the machine filter axis, repeated `machine=` params — absent
  // when unset, so non-machine URLs stay byte-identical to pre-M6.
  for (const m of input.machines ?? []) params.append("machine", m);
  // #278: the Organization scope. Absent = Home, so a single-Organization
  // machine's URLs stay byte-identical to before the scope existed.
  if (input.organization) params.set("organization", input.organization);
}

// Shared URL composer for every /api/<report> endpoint. The param shape is
// uniform; reports vary only the path. Part 5's NDJSON reader composes against
// a report's `build<Name>Url` re-export without going through useQuery.
export function buildReportUrl(path: string, input: QueryInput): string {
  const params = new URLSearchParams();
  if (input.since) params.set("since", input.since);
  if (input.until) params.set("until", input.until);
  appendFilterParams(params, input);
  return `${path}?${params.toString()}`;
}

// --- /api/intraday (the renderer's `use-intraday.ts`) ------------------------

// The hook's loose input. `mode` is optional and defaults to "auto" in
// `normalizeIntradayInput` below; `projects` / `models` are the filter rail's
// multi-select passthroughs, serialized as repeated query params.
export type IntradayHookInput = {
  span: Span;
  mode?: CostMode;
  // `tz` (Part 6, ADR-0015) — the `today` span anchors its calendar-day window
  // to local midnight in this zone (ADR-0020), so it is load-bearing there; the
  // now-relative spans (`15m`/`1h`/`week`/`30d`) and the server-resolved `block`
  // window ignore it. Carried for every span so a Timezone-setting change re-keys.
  tz?: string;
  // ADR-0083: the `span=week` anchor, an ISO instant — REQUIRED by the sidecar
  // for that span (400 otherwise), absent on every other. Re-keys: the window
  // is `weekStart → now`.
  weekStart?: string;
  // The bucket duration in ms (ADR-0018). Omitted → the endpoint's per-span
  // bars default; the line path passes `lineGranularityFor(span)`.
  bucketMs?: number;
  // Lean-payload flags (ADR-0018). Default true (the endpoint's default); a
  // caller sets `includePrevious: false` when the ghost is off and
  // `includeByProject: false` outside the by-project group-by, so the dense
  // line spans don't ship series they won't draw.
  includePrevious?: boolean;
  includeByProject?: boolean;
  // ADR-0041 (M6): the per-machine map, mirroring `includeByProject`. Changes
  // the response body, so it re-keys; a caller sets it true only for the machine
  // group-by. Emitted as `byMachine=1` ONLY when true — its absent form is the
  // endpoint's false default, keeping every non-machine URL byte-identical.
  includeByMachine?: boolean;
  projects?: string[];
  models?: string[];
  // The machine filter axis (ADR-0041 M6) — raw machine ids, serialized as
  // repeated `machine=` params (same passthrough as `models`).
  machines?: string[];
  // The resolved Organization scope (#278) — a tracked uuid or "all"; absent =
  // the Home organization, and no `organization=` param is emitted.
  organization?: string;
};

// Collapse the loose hook input into the canonical `IntradayQueryInput` used
// for both the cache key and the URL params, defaulting `mode` to "auto". One
// copy — key, URL, and fetch all normalize identically so TanStack's cache
// keying stays stable (ADR-0004).
export function normalizeIntradayInput(opts: IntradayHookInput): IntradayQueryInput {
  return {
    span: opts.span,
    mode: opts.mode ?? "auto",
    tz: opts.tz,
    weekStart: opts.weekStart,
    bucketMs: opts.bucketMs,
    includePrevious: opts.includePrevious,
    includeByProject: opts.includeByProject,
    includeByMachine: opts.includeByMachine,
    projects: opts.projects,
    models: opts.models,
    machines: opts.machines,
    organization: opts.organization,
  };
}

// Piece 2 — the URL builder. Sets the `span` window param, then defers to the
// shared `appendFilterParams` (above) for `mode` / `tz` / repeated
// `project` / `model` — the same serialization `buildReportUrl` uses, so the
// query strings stay byte-identical across the two builders (f21).
export function buildIntradayUrl(opts: IntradayHookInput): string {
  const input = normalizeIntradayInput(opts);
  const params = new URLSearchParams();
  params.set("span", input.span);
  appendFilterParams(params, input);
  // ADR-0083: the week anchor, emitted only when set (every non-week URL stays
  // byte-identical).
  if (input.weekStart !== undefined) params.set("weekStart", input.weekStart);
  // ADR-0018: an explicit bucket size for the line path. `prev` / `byProject`
  // are only emitted when FALSE — their absent form is the endpoint's `true`
  // default, so the bars/short-span URLs stay byte-identical to before.
  if (input.bucketMs !== undefined) params.set("bucketMs", String(input.bucketMs));
  if (input.includePrevious === false) params.set("prev", "0");
  if (input.includeByProject === false) params.set("byProject", "0");
  // ADR-0041 (M6): the machine map is emitted only when TRUE — its absent form
  // is the endpoint's false default, so every non-machine URL stays
  // byte-identical to pre-M6 (the two-bit sourcing rule).
  if (input.includeByMachine === true) params.set("byMachine", "1");
  return `/api/intraday?${params.toString()}`;
}

// --- /api/daily-by-machine (the renderer's `use-daily-by-machine.ts`) --------

export type DailyByMachineHookInput = ReportQueryInput & { byProject?: boolean };

export function normalizeDailyByMachineInput(
  opts: DailyByMachineHookInput,
): DailyByMachineQueryInput {
  return { ...normalize(opts), byProject: opts.byProject };
}

// Piece 2 — the URL builder. `byProject=1` is emitted only when TRUE (its
// absent form is the endpoint's false default).
export function buildDailyByMachineUrl(opts: DailyByMachineHookInput): string {
  const input = normalizeDailyByMachineInput(opts);
  const params = new URLSearchParams();
  if (input.since) params.set("since", input.since);
  if (input.until) params.set("until", input.until);
  appendFilterParams(params, input);
  if (input.byProject === true) params.set("byProject", "1");
  return `/api/daily-by-machine?${params.toString()}`;
}

// --- /api/usage/current (the renderer's `use-usage-current.ts`) --------------

export function buildUsageCurrentUrl(base: string, organization?: string): string {
  const url = `${base}/api/usage/current`;
  return organization === undefined
    ? url
    : `${url}?organization=${encodeURIComponent(organization)}`;
}
