import { z } from "zod";

// ADR-0033 — the composable group-by's axis vocabulary; ADR-0041 (M6) added the
// machine axis at the TOP of the priority order (machine outranks everything
// for hue — model keeps its identity colors in every machine-less selection,
// preserving ADR-0033's hue-stability argument where it matters). A [[Group-by]]
// selection is a SET of these, kept in canonical PRIORITY order (the order
// below): the first selected axis carries segment hue, the second the
// lightness ramp, any further axis rides stack order + tooltip only.
export const GROUP_BY_AXES = ["machine", "model", "project", "tokenType"] as const;
export type GroupByAxis = (typeof GROUP_BY_AXES)[number];
export const groupByAxisSchema = z.enum(GROUP_BY_AXES);

// Canonicalize an axes array: priority order, deduped. The store setter and
// the persist merge both run selections through this, so every consumer can
// assume `axes[0]` is the hue axis and `axes[1]` the ramp axis.
export function normalizeAxes(axes: readonly GroupByAxis[]): GroupByAxis[] {
  return GROUP_BY_AXES.filter((a) => axes.includes(a));
}

// The per-axis single-selection label — also the group-by dropdown's per-axis
// item labels in the Live chart card (one source of truth for both).
export const AXIS_LABELS: Record<GroupByAxis, string> = {
  machine: "by machine",
  model: "by model",
  project: "by project",
  tokenType: "by token type",
};
// Short names for combo labels — "by model + token type", never the raw
// camelCase axis key in UI copy.
const AXIS_SHORT: Record<GroupByAxis, string> = {
  machine: "machine",
  model: "model",
  project: "project",
  tokenType: "token type",
};
// The dropdown trigger label. Single axes keep their classic option labels;
// combos join short axis names ("by model + token type"). Self-normalizes its
// input: the store canonicalizes on set/merge, but callers may also label
// candidate selections (e.g. dropdown previews) that haven't been through it.
export function selectionLabel(axes: readonly GroupByAxis[]): string {
  const normalized = normalizeAxes(axes);
  if (normalized.length === 0) return "single series";
  const single = normalized[0];
  if (normalized.length === 1 && single !== undefined) return AXIS_LABELS[single];
  return `by ${normalized.map((a) => AXIS_SHORT[a]).join(" + ")}`;
}

// ADR-0033 — the project axis's top-N cap: top-5 + Other when project is the
// only axis, top-3 + Other when combined (a 4-step lightness ramp within a hue
// stays readable; 6 steps don't). Only meaningful when "project" is in the
// selection — without the project axis there is no top-N to cap.
export function projectTopN(axes: readonly GroupByAxis[]): number {
  return axes.length > 1 ? 3 : 5;
}

// Log scale applies to selections whose series magnitudes span orders: any
// model-bearing selection (ADR-0032/0033) or token-type-bearing selection
// (ADR-0040 — cache read is ~100× output in tokens).
export function logScaleApplies(axes: readonly GroupByAxis[]): boolean {
  return axes.includes("model") || axes.includes("tokenType");
}
