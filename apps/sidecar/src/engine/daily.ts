import type {
  CostMode,
  DailyByMachineResponse,
  DailyByProjectResponse,
  DailyResponse,
  DailyRow,
} from "@maxprice/shared";
import { computeCostBreakdown } from "@maxprice/shared";
import { localDate } from "./local-date";
import type { ModelRollup } from "./model-rollup";
import { byTimestamp, emptyModelRollup, flushRollup, foldModelUsage } from "./model-rollup";
import {
  capturePath,
  emptyPathCapture,
  resolveProjectPath,
  type PathCapture,
} from "./project-path";
import type { StoredEvent } from "./store";

// Part 4.5 — E5: the daily aggregator.
//
// Two pure functions over a store query result, each reproducing one report's
// wire shape byte-for-byte against the E1 golden:
//   - `aggregateDaily`           → `/api/daily`            ({ daily, totals? })
//   - `aggregateDailyByProject`  → `/api/daily-by-project` (per-slug instances)
//
// They take a `StoredEvent[]` (already date-/project-/model-filtered by the
// store's `query`) plus the cost `mode`, and do no I/O. E5 establishes the
// aggregator pattern E6/E7/E8 mirror — the shape is deliberately small and
// reusable: a per-event fold into a date-keyed accumulator, then a
// deterministic flush into sorted wire rows.
//
// The two halves of the pattern are ALSO exported individually —
// `foldDailyEvent` (step 2) and `flushDailyRows` (steps 4-5), over a plain
// date-keyed `ModelRollup` map — so the report cache (#113) can refold a single
// dirty date bucket from its own events and re-flush the rows without
// re-walking the whole store; `sumDailyTotals` is `aggregateDaily`'s `totals`
// fold split out beside them. `rowsByDate` is exactly those two pieces driven
// over an event list, so both paths are byte-identical.
//
// The two SPLIT aggregators export their accumulators the same way —
// `SlugAcc` / `emptySlugAcc` / `foldSlugEvent` / `assembleSlugRows` and
// `MachineAcc` / `emptyMachineAcc` / `foldMachineEvent` / `assembleMachineRows`
// — and are themselves nothing but a fold loop over those pieces, exactly like
// `aggregateSessions` / `aggregateProjects` are over theirs. So the report
// cache's per-slug / per-machine buckets refold and assemble through the SAME
// code the pure path runs: one implementation of each wire tail, not two.
//
// THE AGGREGATOR PATTERN (sessions/projects reuse this):
//   1. Sort events by timestamp ascending (`byTimestamp`, `./model-rollup`).
//      The per-day `modelsUsed` / `modelBreakdowns` ordering is
//      *first-seen* order; iterating timestamp-sorted events makes that
//      ordering deterministic and matches the golden (the midnight-straddle
//      case is the proof — see below).
//   2. Fold each event into a `ModelRollup` (`./model-rollup`) keyed by its
//      grouping axis (here: the event's local-timezone calendar date).
//   3. Cost is `computeCost(model, tokenCounts, mode, costUSD)` — per event,
//      per model. Per-day / per-model totals are plain float sums of those
//      per-event costs (the golden carries the float-arithmetic artifacts,
//      e.g. `0.06540499999999999`, so DO NOT round).
//   4. Flush buckets into wire rows in a deterministic order (rows by date
//      ascending; `modelBreakdowns` / `modelsUsed` in first-seen order).
//   5. The model filter is a STORE-QUERY axis (ADR-0017) — `store.query`
//      hands this aggregator already-model-filtered events, so every row
//      total, breakdown, and the `totals` block is model-scoped. (Through
//      Part 6 this was a post-aggregation filter reproducing a golden
//      capture quirk; ADR-0017 retired it.)

// Day grouping uses the shared `localDate` helper (`./local-date`) — the
// single source of truth the store's `--since`/`--until` filter also derives
// from. The aggregator reads its `dashed` (`YYYY-MM-DD`) form, the wire
// `date` field. An unparseable timestamp (`localDate` → `null`) is *dropped*
// — see `rowsByDate` — so an "invalid-date" string can never reach the wire.

// The per-bucket accumulator (`ModelRollup`), its constructor
// (`emptyModelRollup`), and the per-event fold (`foldModelUsage`) are the
// shared engine primitives — see `./model-rollup`. `daily` keys one rollup per
// local-timezone calendar date.

// Flush a finished rollup into a wire `DailyRow` — the shared `flushRollup`
// (`./model-rollup`) for the eight token/cost/model fields, plus the `date`
// time-key. `intraday`'s `flushWindow` is the same shape with a
// `bucketStart` key instead.
function flushRow(date: string, rollup: ModelRollup): DailyRow {
  return { date, ...flushRollup(rollup) };
}

// Fold ONE event into the date-keyed rollup map — the exact per-event body of
// `rowsByDate`'s loop, exported so the report cache (#113) can refold a single
// dirty date bucket from its own events with byte-identical arithmetic. Callers
// must present events in store sort order (ascending timestamp, ties by store
// insertion order), which is what makes the per-day first-seen `modelsUsed` /
// `modelBreakdowns` ordering deterministic (module header, step 1).
//
// An event whose timestamp doesn't parse is *dropped* — `localDate` → `null`.
// This keeps "an unparseable timestamp never reaches the wire" a single
// invariant: the store already excludes such events from any date-filtered
// query, and this drops them from the unfiltered (`all`-window) path too, so
// no `DailyRow` is ever emitted with a non-date `date`. Schema-possible but
// not exercised by the corpus or real Claude Code JSONL.
export function foldDailyEvent(
  rollups: Map<string, ModelRollup>,
  event: StoredEvent,
  mode: CostMode,
  timeZone: string,
): void {
  const date = localDate(event.timestamp, timeZone);
  if (date === null) return;
  let rollup = rollups.get(date.dashed);
  if (!rollup) {
    rollup = emptyModelRollup();
    rollups.set(date.dashed, rollup);
  }
  const cost = computeCostBreakdown(
    event.model,
    {
      inputTokens: event.inputTokens,
      outputTokens: event.outputTokens,
      cacheCreationTokens: event.cacheCreationTokens,
      cacheReadTokens: event.cacheReadTokens,
    },
    mode,
    event.costUSD,
  );
  foldModelUsage(rollup, event, cost);
}

// Flush finished rollups into date-ascending wire rows — the exact flush tail
// of `rowsByDate`, exported for the report cache (#113). Rollup insertion order
// never affects the output: the sort is total (the date IS the map key, so it
// is unique).
//
// The comparator is plain `<` / `>` on the key — `byTimestamp`'s rule
// (`./model-rollup`) — not `localeCompare`. Every key here has ONE provenance:
// `localDate().dashed`, reached through `foldDailyEvent` and the report cache's
// `bucketOf`. Every real Claude Code / fleet timestamp carries a 4-digit year,
// so every real key is exactly 10 pure-ASCII `[0-9-]` characters with hyphens
// at the same positions 4 and 7. Digit primary weights are monotonic in
// code-unit order, and identically-positioned punctuation contributes equally
// under either variable-weighting strategy, so lexical and ICU impose an
// IDENTICAL total order on these keys (confirmed empirically: 0 divergences
// over the real corpus' key pairs, and 0 over a pathological variable-width
// set). Note the width is a property of real data, not of the formatter:
// `localDate` renders the year with `year: "numeric"`, which does NOT zero-pad
// — a year 500 would give `"500-03-04"` and a year 10000 `"10000-01-01"`.
//
// This is not a speed fix; the two comparators measure within ~1.1× of each
// other on this key shape. What it buys is that a report's wire row order —
// and with it `sumDailyTotals`' float summation order, artifacts and all — no
// longer depends on the host's default locale.
//
// The sibling slug and machineId sorts below deliberately STAY on
// `localeCompare`: those keys are user-derived (project slugs, machine names),
// where lexical and ICU genuinely disagree (ICU is case-insensitive at the
// primary level and weights `-` specially), and their ICU order is pinned by
// the goldens.
export function flushDailyRows(rollups: Map<string, ModelRollup>): DailyRow[] {
  return Array.from(rollups.entries())
    .map(([date, rollup]) => flushRow(date, rollup))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

// Group a (timestamp-sorted) event list into date-keyed buckets, then flush to
// date-ascending `DailyRow[]` — i.e. exactly `foldDailyEvent` over every event,
// then `flushDailyRows`. `aggregateDaily`'s body; the two split aggregators
// drive the same two pieces through their own accumulators instead (`SlugAcc` /
// `MachineAcc` below), since each of theirs carries a `cwd` capture / nested
// sub-accs alongside the date-keyed rollups.
function rowsByDate(events: StoredEvent[], mode: CostMode, timeZone: string): DailyRow[] {
  const rollups = new Map<string, ModelRollup>();
  for (const event of events) foldDailyEvent(rollups, event, mode, timeZone);
  return flushDailyRows(rollups);
}

// ---------------------------------------------------------------------------
// /api/daily
// ---------------------------------------------------------------------------

// Controls beyond the cost mode that shape the `/api/daily` body.
export type AggregateDailyOptions = {
  // How many `project=` params the request carried ON THE WIRE — after
  // ADR-0062's renderer-side Repo-identity expansion, NOT how many projects the
  // user selected. `/api/daily` OMITS the `totals` block on the 2+-project path
  // and includes it on the 0/1-project path — a rule the golden cells pin: every
  // `daily__*__projmulti.json` lacks `totals`; every other cell has it. (It
  // originates in the pre-engine handler's two response paths — see the
  // HISTORICAL note in `projects.ts`.)
  //
  // So ONE selected project whose repo has two local checkouts sends 2 and
  // therefore omits `totals`. Accepted per ADR-0062 §5 rather than worked
  // around: no renderer reads daily `totals` (verified), and the alternative —
  // passing the pre-expansion selection count — would make the field mean
  // something the response body cannot see. ADR-0061's worktree widening stays
  // out of the count by construction, because it is a sidecar-side predicate
  // rather than an expanded list.
  projectFilterCount: number;
  // The IANA zone the daily rows are bucketed into (ADR-0015) — the request's
  // `tz`. The store's date filter and this aggregator must share a zone.
  timeZone: string;
};

// Aggregate a store query result into the `/api/daily` response body.
//
// `events` must be date-/project-/model-filtered by the store's query
// (ADR-0017). This function groups, costs, and sums. `totals` is the
// window-wide sum of every row, included per the `projectFilterCount` rule
// above.
export function aggregateDaily(
  events: StoredEvent[],
  mode: CostMode,
  options: AggregateDailyOptions,
): DailyResponse {
  const daily = rowsByDate(byTimestamp(events), mode, options.timeZone);

  if (options.projectFilterCount >= 2) {
    return { daily };
  }

  return { daily, totals: sumDailyTotals(daily) };
}

// `totals` — a window-wide sum across every row. Events arrive already
// model-filtered (ADR-0017), so this is the model-scoped window total.
// Plain float sums, matching the golden's float-arithmetic artifacts.
//
// The exact accumulation tail of `aggregateDaily`, exported for the report
// cache (#113). It folds over the rows in their date-ascending wire order, so
// the float summation order — artifacts and all — is exactly `aggregateDaily`'s.
export function sumDailyTotals(daily: DailyRow[]): DailyResponse["totals"] {
  const totals = {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    totalCost: 0,
    totalTokens: 0,
  };
  for (const row of daily) {
    totals.inputTokens += row.inputTokens;
    totals.outputTokens += row.outputTokens;
    totals.cacheCreationTokens += row.cacheCreationTokens;
    totals.cacheReadTokens += row.cacheReadTokens;
    totals.totalCost += row.totalCost;
    totals.totalTokens += row.totalTokens;
  }
  return totals;
}

// ---------------------------------------------------------------------------
// /api/daily-by-project
// ---------------------------------------------------------------------------

// One project slug's fold state: the date-keyed rollups plus the running
// capture of the slug's real directory — the scalar `resolveProjectPath` reads
// at assembly (`project-path.ts`, which documents why the first `cwd` alone is
// the wrong answer for a worktree). This aggregator's per-slug accumulator,
// `aggregateDailyByMachine`'s nested per-slug sub-accumulator, and the report
// cache's by-project bucket acc (#113) are all this one type, so the three
// share the resolution.
export type SlugAcc = {
  rollups: Map<string, ModelRollup>;
  cwd: PathCapture;
};

export function emptySlugAcc(): SlugAcc {
  return { rollups: new Map(), cwd: emptyPathCapture() };
}

// Fold ONE event into a slug acc: capture its `cwd`, then the shared daily
// fold. The capture happens BEFORE `foldDailyEvent`'s unparseable-timestamp
// drop, so such an event still feeds the slug's path capture even though it
// contributes no row — which is why the report cache's by-project bucket
// carries no `localDate` gate.
export function foldSlugEvent(
  acc: SlugAcc,
  event: StoredEvent,
  mode: CostMode,
  timeZone: string,
): void {
  capturePath(acc.cwd, event.projectSlug, event.cwd);
  foldDailyEvent(acc.rollups, event, mode, timeZone);
}

// Assemble slug→acc into the wire `projects` map — the `/api/daily-by-project`
// tail, shared with the by-machine aggregator's nested maps and the report
// cache. Slug-ascending key order (the golden's alphabetical project map); a
// slug that flushed no rows (every member event's timestamp unparseable) is
// skipped entirely; `path` resolves from the captured `cwd`.
export function assembleSlugRows(accs: Map<string, SlugAcc>): DailyByProjectResponse["projects"] {
  const projects: DailyByProjectResponse["projects"] = {};
  const entries = Array.from(accs.entries()).sort(([a], [b]) => a.localeCompare(b));
  for (const [slug, acc] of entries) {
    const rows = flushDailyRows(acc.rollups);
    if (rows.length === 0) continue;
    projects[slug] = { path: resolveProjectPath(slug, acc.cwd.path), rows };
  }
  return projects;
}

// Aggregate a store query result into the `/api/daily-by-project` response
// body — the per-slug instances map behind the cost chart's `by project`
// group-by.
//
// `events` must be date-/project-/model-filtered by the store's `query`
// (ADR-0017). A project with no matching events simply never appears in the
// map (so a model-filtered cell can have fewer projects than the unfiltered
// one).
//
// Each project entry carries its real working-directory `path`, derived from
// the project's events' `cwd` (ADR-0009 — the slug key is a lossy encoding).
// Project keys are emitted slug-ascending, matching the golden.
//
// `timeZone` is the request's `tz` — the IANA zone each project's daily rows
// are bucketed into (ADR-0015).
export function aggregateDailyByProject(
  events: StoredEvent[],
  mode: CostMode,
  timeZone: string,
): DailyByProjectResponse {
  // One accumulator per slug, fed by ONE timestamp-ordered walk. Interleaving
  // independent accumulators changes no accumulator's own fold sequence — each
  // slug still sees exactly its own events in timestamp order — so float
  // artifacts and first-seen `modelsUsed` ordering are identical to the
  // group-into-arrays-then-fold form this replaces.
  const accs = new Map<string, SlugAcc>();
  for (const event of byTimestamp(events)) {
    let acc = accs.get(event.projectSlug);
    if (acc === undefined) {
      acc = emptySlugAcc();
      accs.set(event.projectSlug, acc);
    }
    foldSlugEvent(acc, event, mode, timeZone);
  }

  return { projects: assembleSlugRows(accs) };
}

// ---------------------------------------------------------------------------
// /api/daily-by-machine
// ---------------------------------------------------------------------------

// One machine's fold state: the machine's own date-keyed rollups plus — only
// when `includeProjects` is on — its nested per-slug sub-accs. `projects ===
// null` IS "includeProjects off": the two variants fold different shapes, which
// is why the report cache keys on the flag rather than deciding at assembly.
export type MachineAcc = {
  rollups: Map<string, ModelRollup>;
  projects: Map<string, SlugAcc> | null;
};

export function emptyMachineAcc(includeProjects: boolean): MachineAcc {
  return { rollups: new Map(), projects: includeProjects ? new Map() : null };
}

// Fold ONE event into a machine acc: the machine's own rollups, plus its slug
// sub-acc when nesting is on. The machine rollups and each sub-acc are
// independent accumulators fed by the same walk, which is exactly what the two
// separate passes this replaces (`rowsByDate`, then `aggregateDailyByProject`)
// computed over one sorted per-machine event array.
export function foldMachineEvent(
  acc: MachineAcc,
  event: StoredEvent,
  mode: CostMode,
  timeZone: string,
): void {
  foldDailyEvent(acc.rollups, event, mode, timeZone);
  if (acc.projects !== null) {
    let sub = acc.projects.get(event.projectSlug);
    if (sub === undefined) {
      sub = emptySlugAcc();
      acc.projects.set(event.projectSlug, sub);
    }
    foldSlugEvent(sub, event, mode, timeZone);
  }
}

// Assemble machine→acc into the wire `machines` map — the
// `/api/daily-by-machine` tail, shared with the report cache. machineId-
// ascending key order; a machine that flushed no rows is skipped; field order
// is `rows` then the optional `projects` (the stringify-parity tests pin it).
export function assembleMachineRows(
  accs: Map<string, MachineAcc>,
): DailyByMachineResponse["machines"] {
  const machines: DailyByMachineResponse["machines"] = {};
  const entries = Array.from(accs.entries()).sort(([a], [b]) => a.localeCompare(b));
  for (const [machineId, acc] of entries) {
    const rows = flushDailyRows(acc.rollups);
    if (rows.length === 0) continue;
    const out: DailyByMachineResponse["machines"][string] = { rows };
    if (acc.projects !== null) out.projects = assembleSlugRows(acc.projects);
    machines[machineId] = out;
  }
  return machines;
}

// Aggregate a store query result into the /api/daily-by-machine response body
// (ADR-0041 M6) — the per-machine daily series behind the cost chart's machine
// group-by on the daily spans; the byProject aggregator transposed to the
// machine axis. `events` must be date-/project-/model-/machine-filtered by the
// store's `query` (ADR-0017's flow). A machine with no in-window rows never
// appears. Keys are machineId-ascending. When `includeProjects` (machine +
// project group-bys both selected) each machine nests its OWN per-project map —
// literally `aggregateDailyByProject` over that machine's events, so the nested
// entries carry the same slug-ascending order and resolved `path`.
export function aggregateDailyByMachine(
  events: StoredEvent[],
  mode: CostMode,
  timeZone: string,
  includeProjects: boolean,
): DailyByMachineResponse {
  // One accumulator per machine, fed by ONE timestamp-ordered walk — the
  // by-project transposition, with the same byte-identity argument (see
  // `aggregateDailyByProject`): every accumulator, machine rollups and nested
  // slug sub-accs alike, still folds exactly its own events in timestamp order.
  const accs = new Map<string, MachineAcc>();
  for (const event of byTimestamp(events)) {
    let acc = accs.get(event.machineId);
    if (acc === undefined) {
      acc = emptyMachineAcc(includeProjects);
      accs.set(event.machineId, acc);
    }
    foldMachineEvent(acc, event, mode, timeZone);
  }

  return { machines: assembleMachineRows(accs) };
}
