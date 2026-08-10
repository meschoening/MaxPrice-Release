import {
  MODEL_FAMILIES,
  normalizeModelName,
  type TokenCategory,
  type DailyRow,
  type ModelFamily,
} from "@maxprice/shared";

// The pure per-bucket data-shaping primitives (ADR-0033). Extracted in M0 from
// the old ECharts option builders (deleted in M3) so the compose step
// (composed-series.ts) can consume them from the bottom of the chart pipeline —
// the dependency direction stays one-way (composed-series → chart-bucket ←
// chart-model).

export type TokenSlices = Record<TokenCategory, { cost: number; tokens: number }>;

export type ChartBucket = {
  label: string;
  totalCost: number;
  totalTokens: number;
  // Per model family: the family totals plus the family's own four-band
  // token-type split (ADR-0033/ADR-0040 — exact, from the per-model
  // outputCost/cacheCreationCost/cacheReadCost breakdown fields; absent fields
  // read as 0 ⇒ output reads 0 and all non-cache cost lands in the input band,
  // matching pre-ADR-0040 payloads).
  perModel: Record<ModelFamily, { cost: number; tokens: number; perToken: TokenSlices }>;
  perToken: TokenSlices;
};

export function emptyTokenSlices(): TokenSlices {
  return {
    output: { cost: 0, tokens: 0 },
    input: { cost: 0, tokens: 0 },
    cacheCreate: { cost: 0, tokens: 0 },
    cacheRead: { cost: 0, tokens: 0 },
  };
}

// Sum cache + non-cache tokens for the tokens metric. `totalTokens` already
// includes all four — input, output, cacheCreation, cacheRead — so we
// just use that. Consumed by composed-series.ts (ADR-0033's compose step builds
// per-project buckets directly) and the tests.
export function bucketFromDaily(row: DailyRow): ChartBucket {
  const perModel = Object.fromEntries(
    MODEL_FAMILIES.map((f) => [f, { cost: 0, tokens: 0, perToken: emptyTokenSlices() }]),
  ) as ChartBucket["perModel"];
  for (const bd of row.modelBreakdowns) {
    const family = perModel[normalizeModelName(bd.modelName)];
    family.cost += bd.cost;
    family.tokens += bd.inputTokens + bd.outputTokens + bd.cacheCreationTokens + bd.cacheReadTokens;
    const bdCreate = bd.cacheCreationCost ?? 0;
    const bdRead = bd.cacheReadCost ?? 0;
    const bdOutput = bd.outputCost ?? 0;
    family.perToken.output.cost += bdOutput;
    family.perToken.output.tokens += bd.outputTokens;
    // Input is the clamped remainder (ADR-0040) — absent breakdown cost fields
    // read as 0, so pre-ADR-0040 payloads land all non-cache cost here.
    family.perToken.input.cost += Math.max(0, bd.cost - bdCreate - bdRead - bdOutput);
    family.perToken.input.tokens += bd.inputTokens;
    family.perToken.cacheCreate.cost += bdCreate;
    family.perToken.cacheCreate.tokens += bd.cacheCreationTokens;
    family.perToken.cacheRead.cost += bdRead;
    family.perToken.cacheRead.tokens += bd.cacheReadTokens;
  }
  const cacheCreationCost = row.cacheCreationCost ?? 0;
  const cacheReadCost = row.cacheReadCost ?? 0;
  const outputCost = row.outputCost ?? 0;
  const perToken: TokenSlices = {
    output: { cost: outputCost, tokens: row.outputTokens },
    input: {
      // Clamped at 0: float reassociation across summed events can leave the
      // subtraction ~-1e-13 on cache-dominated buckets (tooltips skip only v === 0).
      cost: Math.max(0, row.totalCost - cacheCreationCost - cacheReadCost - outputCost),
      tokens: row.inputTokens,
    },
    cacheCreate: { cost: cacheCreationCost, tokens: row.cacheCreationTokens },
    cacheRead: { cost: cacheReadCost, tokens: row.cacheReadTokens },
  };
  return {
    label: row.date,
    totalCost: row.totalCost,
    totalTokens: row.totalTokens,
    perModel,
    perToken,
  };
}
