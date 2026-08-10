import type { DailyRow, ModelBreakdown } from "@maxprice/shared";

// Summing two of the same wire shape into one.
//
// Extracted from lib/machines.ts, which is where these grew: the machine axis
// folds merged aliases into one series, and the project axis folds a repository's
// worktrees into one row (ADR-0061). Both need identical arithmetic over the same
// payloads, and a project module importing from a machine module to get it would
// be a dependency with no domain meaning behind it.
//
// Every function here is pure and total. The list-shaped helpers
// (`mergeBreakdowns`, `unionInOrder`) scan linearly on purpose: they run over
// per-model / per-machine label arrays that are single digits long, where a Map
// would cost more than it saves.
//
// `mergeRows` is the exception and is written for the row counts instead —
// ADR-0062 put it on the project fold's hot path (once per worktree and once per
// identity sibling, per machine, twice over for the ghost) across intraday
// windows of up to ~721 densified one-minute buckets (ADR-0046), so it keeps
// positions rather than searching for them.

// Sum two optional components. `undefined` only survives when BOTH sides omit
// it, so a payload that carries a cost slice never loses it by being merged with
// one that doesn't — it merges against an implicit zero instead.
export function sumOptional(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined && b === undefined) return undefined;
  return (a ?? 0) + (b ?? 0);
}

// Merge two per-model breakdown lists, matching on `modelName`. `a`'s order is
// preserved and models only `b` knows about are appended.
export function mergeBreakdowns(a: ModelBreakdown[], b: ModelBreakdown[]): ModelBreakdown[] {
  const out: ModelBreakdown[] = a.map((x) => ({ ...x }));
  for (const bd of b) {
    const into = out.find((x) => x.modelName === bd.modelName);
    if (!into) {
      out.push({ ...bd });
      continue;
    }
    into.inputTokens += bd.inputTokens;
    into.outputTokens += bd.outputTokens;
    into.cacheCreationTokens += bd.cacheCreationTokens;
    into.cacheReadTokens += bd.cacheReadTokens;
    into.cost += bd.cost;
    into.cacheCreationCost = sumOptional(into.cacheCreationCost, bd.cacheCreationCost);
    into.cacheReadCost = sumOptional(into.cacheReadCost, bd.cacheReadCost);
    into.outputCost = sumOptional(into.outputCost, bd.outputCost);
  }
  return out;
}

// Sum two DailyRows that describe the SAME bucket/date label (the caller
// guarantees alignment — merged-alias entries share the window grid intraday,
// and join by date label on the daily path). Keeps `a`'s label.
export function sumDailyRows(a: DailyRow, b: DailyRow): DailyRow {
  return {
    date: a.date,
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    totalTokens: a.totalTokens + b.totalTokens,
    totalCost: a.totalCost + b.totalCost,
    ...(sumOptional(a.cacheCreationCost, b.cacheCreationCost) !== undefined
      ? { cacheCreationCost: sumOptional(a.cacheCreationCost, b.cacheCreationCost) }
      : {}),
    ...(sumOptional(a.cacheReadCost, b.cacheReadCost) !== undefined
      ? { cacheReadCost: sumOptional(a.cacheReadCost, b.cacheReadCost) }
      : {}),
    ...(sumOptional(a.outputCost, b.outputCost) !== undefined
      ? { outputCost: sumOptional(a.outputCost, b.outputCost) }
      : {}),
    modelsUsed: [...a.modelsUsed, ...b.modelsUsed.filter((m) => !a.modelsUsed.includes(m))],
    modelBreakdowns: mergeBreakdowns(a.modelBreakdowns, b.modelBreakdowns),
  };
}

// Merge two row lists label-keyed. Order follows `a` with unseen labels
// appended — every consumer joins per-series rows BY LABEL (alignBuckets), so
// order is display-irrelevant here.
export function mergeRows(a: DailyRow[], b: DailyRow[]): DailyRow[] {
  const out = a.map((r) => ({ ...r }));
  // label → POSITION, not label → row. `sumDailyRows` returns a fresh object, so
  // the merged row has to be written back into `out`; locating it with
  // `out.indexOf` made every merge O(n·m) — ~260k reference comparisons on a
  // 721-bucket intraday window, all of it avoidable by remembering the index we
  // already had.
  const posOf = new Map<string, number>();
  // Seeded unconditionally, so a duplicate label in `a` resolves to its LAST
  // occurrence — exactly what `new Map(entries)` did, where a later entry
  // overwrites an earlier one. A `has`-guarded seed would be a silent behaviour
  // change for duplicate labels.
  out.forEach((r, i) => posOf.set(r.date, i));
  for (const row of b) {
    const at = posOf.get(row.date);
    if (at !== undefined) {
      // No map write back: the position is unchanged by the merge, and a later
      // duplicate label in `b` must fold onto the already-merged row.
      out[at] = sumDailyRows(out[at]!, row);
    } else {
      posOf.set(row.date, out.length);
      out.push({ ...row });
    }
  }
  return out;
}

// Union two string lists, first-seen order preserved. The `modelsUsed` /
// `machines` shape: parallel label arrays where order is provenance, not rank.
export function unionInOrder(a: readonly string[], b: readonly string[]): string[] {
  const out = [...a];
  for (const v of b) if (!out.includes(v)) out.push(v);
  return out;
}
