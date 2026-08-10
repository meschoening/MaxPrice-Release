import { z } from "zod";

// The per-model token + cost breakdown row. Every report — daily, sessions,
// projects — carries an identical `modelBreakdowns` array, so the schema +
// type live here (alongside MODEL_COLORS / normalizeModelName, the model
// single-source-of-truth) rather than being redefined per report.
export const modelBreakdownSchema = z.object({
  modelName: z.string(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheCreationTokens: z.number(),
  cacheReadTokens: z.number(),
  cost: z.number(),
  // ADR-0033 — the per-model cache-cost slices, mirroring the row-level
  // ADR-0026 fields. Optional on the wire (additive vs the goldens);
  // the engine always populates them. They are what makes the chart's
  // model × cache cross-product exact — the renderer cannot re-derive a cost
  // split from token sums (per-model prices differ). ADR-0040 adds the
  // per-model `outputCost` slice on the same footing, so the token-type axis's
  // model × band cross-product is exact for the same reason.
  cacheCreationCost: z.number().optional(),
  cacheReadCost: z.number().optional(),
  outputCost: z.number().optional(),
});

export type ModelBreakdown = z.infer<typeof modelBreakdownSchema>;

// Model identity normalization. Real usage data carries versioned model
// strings like `claude-opus-4-7`, `claude-opus-4-5-20251101`, `claude-haiku-
// 4-5-20251001`, `claude-sonnet-4-6`, `claude-fable-5`. The chart, legends,
// swatches, and tile splits should stack by family — Fable/Opus/Sonnet/Haiku —
// and surface the full versioned name only in tooltips.
//
// Family order is dearest-first (per-token price descending): Fable (released
// 2026-06-09, ~2x Opus) leads, then Opus, Sonnet, Haiku. The derived orderings
// below — legend, draw order, markLine anchor — all key off this order.

export const MODEL_FAMILIES = ["Fable", "Opus", "Sonnet", "Haiku", "Unknown"] as const;
export type ModelFamily = (typeof MODEL_FAMILIES)[number];

// The drawn-family orderings for the cost chart, derived from MODEL_FAMILIES so
// the canonical family order has a single home (legends, swatches, chart draw
// order, and the filter rail's model list all read these instead of inlining
// their own literal arrays). Both deliberately EXCLUDE the `Unknown` family:
// unrecognized-model spend is intentionally never charted — the legend shows
// only Fable/Opus/Sonnet/Haiku per ADR-0021 — so a window that contains unknown
// models can have drawn lines that don't sum to the tooltip's Total.
//   - MODEL_LEGEND_ORDER — canonical legend / axis-assignment / return order
//     (Fable → Opus → Sonnet → Haiku).
//   - MODEL_DRAW_ORDER   — bottom→top stacking / draw order (Haiku → Fable), so
//     the dearest model (Fable) is drawn last and reads on top.
export const MODEL_LEGEND_ORDER: readonly ModelFamily[] = MODEL_FAMILIES.filter(
  (f) => f !== "Unknown",
);
export const MODEL_DRAW_ORDER: readonly ModelFamily[] = [...MODEL_LEGEND_ORDER].reverse();

// CSS is canonical for data-series color (T3 §3): every palette entry is a
// var() ref onto a glass token, resolved in the DOM per color mode — the
// mode-specific oklch values live in packages/glass/index.css (both blocks)
// only. Chart series, tile bars, list-row swatches, and Part-5 timeline
// badges all read these as CSS values. Unknown is a neutral grey token so
// unfamiliar models don't claim a family color.
export const MODEL_COLORS: Record<ModelFamily, string> = {
  Fable: "var(--fable)",
  Opus: "var(--opus)",
  Sonnet: "var(--sonnet)",
  Haiku: "var(--haiku)",
  Unknown: "var(--model-unknown)",
};

// Chart-series colors for the cost chart's `by project` group-by (Part 4).
// Lives alongside MODEL_COLORS so every chart-series color source is in one
// module. Series are assigned a palette entry by window-total rank; the
// aggregated "Other" series gets the muted grey.
export const PROJECT_PALETTE = [
  "var(--proj-1)",
  "var(--proj-2)",
  "var(--proj-3)",
  "var(--proj-4)",
  "var(--proj-5)",
  "var(--proj-6)",
];
export const PROJECT_OTHER_COLOR = "var(--proj-other)";

// ADR-0041 (M6) — the machine group-by axis's series palette, beside
// PROJECT_PALETTE (colors are scoped per-axis, the PROJECT_PALETTE precedent).
// Assignment is by alias-folded directory order (registeredAt ascending, ties
// by machineId), NOT by window-total rank: machines are few and stable, there
// is no top-N cap (every machine always draws), and one assignment colors the
// chart hue, legend, and list dots alike so a machine keeps its color across
// every surface and window.
export const MACHINE_PALETTE = [
  "var(--mach-1)",
  "var(--mach-2)",
  "var(--mach-3)",
  "var(--mach-4)",
  "var(--mach-5)",
  "var(--mach-6)",
];

// --- token-category axis for the `by token type` group-by (ADR-0026, four-band split by ADR-0040) ---
// The four exhaustive bands a bucket's tokens/cost split into — Output, Input,
// Cache create, Cache read. Lives beside MODEL_COLORS / PROJECT_PALETTE so every
// chart-series color source is in one module.
export const TOKEN_CATEGORIES = ["output", "input", "cacheCreate", "cacheRead"] as const;
export type TokenCategory = (typeof TOKEN_CATEGORIES)[number];

// Bottom→top stack/draw order. Output is anchored to the axis (ADR-0040 — the
// band read first, at the baseline), then Input, Cache create, and Cache read on
// top. The two orders deliberately coincide today — the legend (and tooltips)
// read in bottom-up stacking order per ADR-0026 — but carry dual names for
// symmetry with MODEL_DRAW_ORDER / MODEL_LEGEND_ORDER, which genuinely differ:
// series construction reads DRAW order, legends/tooltips read LEGEND order.
export const TOKEN_DRAW_ORDER: readonly TokenCategory[] = TOKEN_CATEGORIES;
export const TOKEN_LEGEND_ORDER: readonly TokenCategory[] = TOKEN_CATEGORIES;

export const TOKEN_CATEGORY_LABELS: Record<TokenCategory, string> = {
  output: "Output",
  input: "Input",
  cacheCreate: "Cache create",
  cacheRead: "Cache read",
};

// The ADR-0040 band palette, CSS-canonical like the rest (T3 §3): Output the
// accent-adjacent primary (the model's "real work", anchored at the axis),
// Input a distinct second hue, Cache create the warm amber (the priciest
// cache tokens), cache read the cool fourth band. Per-mode values live on the
// --tt-* glass tokens.
export const TOKEN_COLORS: Record<TokenCategory, string> = {
  output: "var(--tt-output)",
  input: "var(--tt-input)",
  cacheCreate: "var(--tt-create)",
  cacheRead: "var(--tt-read)",
};

// The cache-vs-non-cache partition of the four ADR-0040 bands: Cache create +
// Cache read are cache tokens, Output + Input are not. Co-located with the
// band definitions above so this domain fact has one owner (currently used by
// the cost chart's tooltip cache-share row).
export function isCacheCategory(category: TokenCategory): boolean {
  return category === "cacheCreate" || category === "cacheRead";
}

// Match by family prefix. Model strings are kebab-case with `-N` version
// segments; we only care about the family token between `claude-` and the
// first digit. Case-insensitive to survive any future capitalization shifts.
export function normalizeModelName(raw: string): ModelFamily {
  const lowered = raw.toLowerCase();
  if (lowered.includes("fable")) return "Fable";
  if (lowered.includes("opus")) return "Opus";
  if (lowered.includes("sonnet")) return "Sonnet";
  if (lowered.includes("haiku")) return "Haiku";
  return "Unknown";
}
