import type { BlockRow, ModelBreakdown, ProjectRow, SessionRow } from "@maxprice/shared";

// Client-side reducers behind the detail strip's no-selection state (ADR-0016):
// "filter totals" computed over the rows currently in the table — i.e. already
// scoped by the active date range + project/model filters. No endpoint serves
// these; they are a useMemo away from data the pages already hold.

// Merge per-row model breakdowns into one list, summing token counts, cost,
// and the per-model cache-cost slices (ADR-0033) per modelName. Ordered by
// descending cost so the dominant model leads.
export function mergeModelBreakdowns(rows: ModelBreakdown[][]): ModelBreakdown[] {
  const byModel = new Map<string, ModelBreakdown>();
  for (const breakdowns of rows) {
    for (const bd of breakdowns) {
      const agg = byModel.get(bd.modelName);
      if (agg) {
        agg.inputTokens += bd.inputTokens;
        agg.outputTokens += bd.outputTokens;
        agg.cacheCreationTokens += bd.cacheCreationTokens;
        agg.cacheReadTokens += bd.cacheReadTokens;
        agg.cost += bd.cost;
        // The slices are wire-optional (ADR-0033, ADR-0040) — accumulate with
        // the same `?? 0` idiom as the engine's foldModelUsage, never carry the
        // first-seen row's slice as if it were the merged one.
        agg.cacheCreationCost = (agg.cacheCreationCost ?? 0) + (bd.cacheCreationCost ?? 0);
        agg.cacheReadCost = (agg.cacheReadCost ?? 0) + (bd.cacheReadCost ?? 0);
        agg.outputCost = (agg.outputCost ?? 0) + (bd.outputCost ?? 0);
      } else {
        // Copy so accumulation never mutates a row owned by the query cache.
        byModel.set(bd.modelName, { ...bd });
      }
    }
  }
  return Array.from(byModel.values()).sort((a, b) => b.cost - a.cost);
}

export type SessionsAggregate = {
  count: number;
  totalCost: number;
  totalTokens: number;
  avgCost: number;
  cacheHitPct: number;
  breakdowns: ModelBreakdown[];
};

export function aggregateSessions(rows: SessionRow[]): SessionsAggregate {
  let totalCost = 0;
  let totalTokens = 0;
  let cacheRead = 0;
  let inputSide = 0;
  for (const s of rows) {
    totalCost += s.totalCost;
    totalTokens += s.totalTokens;
    cacheRead += s.cacheReadTokens;
    inputSide += s.inputTokens + s.cacheCreationTokens + s.cacheReadTokens;
  }
  return {
    count: rows.length,
    totalCost,
    totalTokens,
    avgCost: rows.length === 0 ? 0 : totalCost / rows.length,
    // Weighted, not a mean of per-session percentages — a giant session
    // counts proportionally to its size.
    cacheHitPct: inputSide === 0 ? 0 : (cacheRead / inputSide) * 100,
    breakdowns: mergeModelBreakdowns(rows.map((s) => s.modelBreakdowns)),
  };
}

// The projects strip is wholly range-scoped since ADR-0068: every stat sums
// the windowed table rows, which is correct because a project absent from the
// windowed response has zero in-window everything. Until then `sessions` was
// an all-time count and needed its own UNWINDOWED query with its own aggregate
// type, because summing the windowed rows would have shrunk the figure as the
// range narrowed. Both are gone — one query, one aggregate.

export type ProjectsRangeAggregate = {
  count: number;
  costRange: number;
  sessions: number;
  breakdowns: ModelBreakdown[];
};

// Range-scoped filter totals over the rows currently in the table.
//
// `sessions` sums rather than dedupes: a session belongs to exactly one project
// directory, so the per-project counts are over disjoint sets (the same reason
// `lib/projects.ts::absorb` may add them across a worktree fold).
export function aggregateProjectsRange(rows: ProjectRow[]): ProjectsRangeAggregate {
  let costRange = 0;
  let sessions = 0;
  for (const p of rows) {
    costRange += p.costRange;
    sessions += p.sessions;
  }
  return {
    count: rows.length,
    costRange,
    sessions,
    breakdowns: mergeModelBreakdowns(rows.map((p) => p.modelBreakdowns)),
  };
}

export type BlocksAggregate = {
  count: number;
  totalCost: number;
  totalTokens: number;
  entries: number;
  models: string[];
};

// Gap blocks carry no real usage — exclude them so "N blocks" means N activity
// windows (matches the table's own gap styling, which de-emphasizes them).
export function aggregateBlocks(rows: BlockRow[]): BlocksAggregate {
  let totalCost = 0;
  let totalTokens = 0;
  let entries = 0;
  const models = new Set<string>();
  let count = 0;
  for (const b of rows) {
    if (b.isGap) continue;
    count += 1;
    totalCost += b.costUSD;
    totalTokens += b.totalTokens;
    entries += b.entries;
    for (const m of b.models) models.add(m);
  }
  return { count, totalCost, totalTokens, entries, models: Array.from(models) };
}

// The "typical" block — the MEDIAN `totalTokens` across the completed
// (non-gap, non-active) blocks currently loaded for the active Date range.
// Backs the Blocks strip's "Tokens vs typical" bar and the Active block tile's
// "typical" row. Median, not mean, so one outlier block doesn't drag the
// baseline up and make every other block read as "below typical". The
// in-progress active block is excluded (its totals are incomplete) and gap rows
// are excluded (they carry no usage). Returns 0 when there are no completed
// blocks — callers render that as an em-dash.
export function typicalBlockTokens(rows: BlockRow[]): number {
  const tokens = rows
    .filter((b) => !b.isGap && !b.isActive)
    .map((b) => b.totalTokens)
    .sort((a, b) => a - b);
  const n = tokens.length;
  if (n === 0) return 0;
  const mid = Math.floor(n / 2);
  // Odd count → the middle value; even → the mean of the two middle values.
  // The `?? 0` fallbacks are unreachable for n >= 1 (mid and mid-1 are valid
  // indices) but keep the access total under noUncheckedIndexedAccess.
  const hi = tokens[mid] ?? 0;
  if (n % 2 !== 0) return hi;
  const lo = tokens[mid - 1] ?? 0;
  return (lo + hi) / 2;
}
