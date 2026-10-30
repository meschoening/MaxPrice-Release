import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { z } from "zod";
import { parentProjectSlug, type DateRangePreset, type Span, spanSchema } from "@maxprice/shared";
import { groupByAxisSchema, normalizeAxes, type GroupByAxis } from "@/lib/group-by";

// `Span` + `spanSchema` are owned by the shared package (`./intraday`); they are
// re-exported here so consumers importing `Span` from this module (cost-chart,
// use-live-data) keep working without reaching across the package boundary.
// `GroupByAxis` is likewise owned by `@/lib/group-by` (ADR-0033) and re-exported
// for the same reason.
export type { Span };
export type { GroupByAxis };

export type Metric = "cost" | "tokens";
export type ChartStyle = "bars" | "cumulative" | "trend";

const dateRangePresetSchema = z.enum(["24h", "week", "30d", "90d", "all"]);
const metricSchema = z.enum(["cost", "tokens"]);
const chartStyleSchema = z.enum(["bars", "cumulative", "trend"]);

// Mute (ADR-0042) — the chart-local, per-axis legend-visibility sets. Values
// are the compose step's stable per-axis keys (model family / project slug or
// the Other sentinel / target machineId / token band); stale values (a purged
// machine, a renamed family) are inert — they simply never match a series.
const mutedSchema = z.object({
  machine: z.array(z.string()),
  model: z.array(z.string()),
  project: z.array(z.string()),
  tokenType: z.array(z.string()),
});
export type MutedState = z.infer<typeof mutedSchema>;
export const EMPTY_MUTED: MutedState = { machine: [], model: [], project: [], tokenType: [] };

// Shape that gets persisted to localStorage. Methods are intentionally excluded
// — Zustand re-attaches them from the store factory on hydrate.
const persistedFiltersSchema = z.object({
  dateRange: dateRangePresetSchema,
  projects: z.array(z.string()),
  models: z.array(z.string()),
  machines: z.array(z.string()),
  metric: metricSchema,
  groupByAxes: z.array(groupByAxisSchema),
  span: spanSchema,
  ghostOverlay: z.boolean(),
  chartStyle: chartStyleSchema,
  // Log scale — the by-model symlog-axis lines toggle (ADR-0032).
  logScale: z.boolean(),
  // Mute — the per-axis legend-visibility sets (ADR-0042).
  muted: mutedSchema,
});

export type FiltersState = {
  dateRange: DateRangePreset;
  projects: string[];
  models: string[];
  machines: string[];
  metric: Metric;
  groupByAxes: GroupByAxis[];
  span: Span;
  ghostOverlay: boolean;
  chartStyle: ChartStyle;
  logScale: boolean;
  muted: MutedState;
  setDateRange: (v: DateRangePreset) => void;
  setProjects: (v: string[]) => void;
  setModels: (v: string[]) => void;
  setMachines: (v: string[]) => void;
  setMetric: (v: Metric) => void;
  setGroupByAxes: (v: GroupByAxis[]) => void;
  setSpan: (v: Span) => void;
  setGhostOverlay: (v: boolean) => void;
  setChartStyle: (v: ChartStyle) => void;
  setLogScale: (v: boolean) => void;
  toggleMute: (axis: GroupByAxis, value: string) => void;
};

export const useFilters = create<FiltersState>()(
  persist(
    (set) => ({
      dateRange: "week",
      projects: [],
      models: [],
      machines: [],
      metric: "cost",
      groupByAxes: ["model"],
      span: "week",
      ghostOverlay: true,
      chartStyle: "bars",
      logScale: false,
      muted: EMPTY_MUTED,
      setDateRange: (v) => set({ dateRange: v }),
      setProjects: (v) => set({ projects: v }),
      setModels: (v) => set({ models: v }),
      setMachines: (v) => set({ machines: v }),
      setMetric: (v) => set({ metric: v }),
      setGroupByAxes: (v) => set({ groupByAxes: normalizeAxes(v) }),
      setSpan: (v) => set({ span: v }),
      setGhostOverlay: (v) => set({ ghostOverlay: v }),
      setChartStyle: (v) => set({ chartStyle: v }),
      setLogScale: (v) => set({ logScale: v }),
      // Mute (ADR-0042): flip one value in one axis's muted set. Sets for
      // axes outside the current group-by selection are kept as-is — muting
      // is dormant, not cleared, while its axis is off.
      toggleMute: (axis, value) =>
        set((s) => ({
          muted: {
            ...s.muted,
            [axis]: s.muted[axis].includes(value)
              ? s.muted[axis].filter((v) => v !== value)
              : [...s.muted[axis], value],
          },
        })),
    }),
    {
      name: "maxprice.filters",
      storage: createJSONStorage(() => localStorage),
      version: 14,
      // Merge runs on every hydration (regardless of version match), so all
      // validation lives here. Same-version corrupt payloads, unknown enum
      // values, missing fields, and migrate→undefined all reach this point.
      // Returning currentState drops the persisted state entirely. Persisted
      // axes are re-normalized (priority order, deduped) so every consumer can
      // rely on the canonical ordering even if the stored array was hand-edited.
      merge: (persistedState, currentState) => {
        const parsed = persistedFiltersSchema.safeParse(persistedState);
        if (!parsed.success) return currentState;
        return {
          ...currentState,
          ...parsed.data,
          groupByAxes: normalizeAxes(parsed.data.groupByAxes),
        };
      },
      // Migrate handles version bumps. Returning undefined for unknown
      // versions makes merge see undefined → falls back to currentState.
      // v1 → v2 adds ghostOverlay (default true so existing users see it on);
      // v2 → v3 drops costMode (moved to settings.json — Part 6, ADR-0014);
      // v3 → v4 adds chartStyle (default "bars" — today's per-bucket view);
      // v4 → v5 renames the `24h` chart span to `today` (ADR-0020 — the
      // calendar-day window). NOTE: only the SPAN renames; the `24h` Date-range
      // preset is a different field and is untouched. v5 → v6 adds splitScale
      // (default off — ADR-0021). v6 → v7 renames the `6h` span to `block`
      // (ADR-0031). v7 → v8 renames splitScale to logScale, CARRYING the value
      // — the boolean encodes intent ("keep small models legible"), not
      // mechanism, so an opted-in user stays opted in across the ADR-0032
      // replacement. v8 → v9 turns the scalar groupBy into the groupByAxes
      // array — ADR-0033; `none` maps to the empty selection. v9 → v10 renames
      // the `cache` axis key to `tokenType` (ADR-0040). v10 → v11 adds the
      // machine filter array `machines` (ADR-0041 M6 — default empty; the axis
      // key "machine" is newly admitted, never renamed). v11 → v12 adds the
      // per-axis `muted` sets (ADR-0042 — default all-empty). v12 → v13 maps a
      // persisted worktree slug onto the project that now owns it (ADR-0061).
      // v13 → v14 renames `7d` to `week` — BOTH the span and the Date-range
      // preset, which now follow the Week setting (ADR-0083).
      // A v1 payload chains through every step.
      migrate: (state, version) => {
        if (version === 14) return state;
        if (version >= 1 && version <= 13) {
          if (!state || typeof state !== "object") return undefined;
          const next = { ...(state as Record<string, unknown>) };
          if (version <= 8) {
            if (version <= 2) delete next.costMode; // v2 → v3
            if (version === 1) next.ghostOverlay = true; // v1 → v2
            if (version <= 3) next.chartStyle = "bars"; // v3 → v4
            if (next.span === "24h") next.span = "today"; // v4 → v5 (ADR-0020)
            if (version <= 5) next.splitScale = false; // v5 → v6 (ADR-0021)
            if (next.span === "6h") next.span = "block"; // v6 → v7 (ADR-0031)
            if (version <= 7) {
              next.logScale = next.splitScale === true; // v7 → v8 (ADR-0032)
              delete next.splitScale;
            }
            // v8 → v9 (ADR-0033): scalar groupBy → axes array; "none" → [].
            // Only a string groupBy maps — every genuine v1..v8 payload carries
            // one, so a missing or non-string groupBy is corruption: groupByAxes
            // is left absent and merge's schema rejects the payload wholesale,
            // as it always has.
            if (typeof next.groupBy === "string") {
              next.groupByAxes = next.groupBy === "none" ? [] : [next.groupBy];
            }
            delete next.groupBy;
          }
          // v9 → v10 (ADR-0040): the cache axis key becomes tokenType. Runs for
          // every version ≤ 10 — idempotent (a v10 payload has no "cache" left),
          // and the v8 → v9 step above can itself mint ["cache"].
          if (Array.isArray(next.groupByAxes)) {
            next.groupByAxes = next.groupByAxes.map((a) => (a === "cache" ? "tokenType" : a));
          }
          // v10 → v11 (ADR-0041 M6): the machine filter joins the rail. No value
          // mapping — the axis key "machine" is newly admitted, never renamed.
          // Gated on ≤ 10 so a genuine v11 payload keeps its machine selection.
          if (version <= 10) next.machines = [];
          // v11 → v12 (ADR-0042): the per-axis muted sets join the chart state,
          // default all-empty — a fresh deep object per payload (structuredClone,
          // never the shared constant or a shallow spread, both of which would
          // alias the inner arrays across payloads).
          if (version <= 11) next.muted = structuredClone(EMPTY_MUTED);
          // v12 → v13 (ADR-0061): worktrees fold into their project, so a
          // persisted worktree slug maps to the project that now owns it and
          // duplicates collapse. Left alone it would still filter correctly —
          // the sidecar matches it exactly — but it would select nothing the
          // menu can show as selected, so the rail would look unfiltered while
          // the data was not.
          if (Array.isArray(next.projects)) {
            next.projects = [
              ...new Set(
                next.projects.map((p) => (typeof p === "string" ? parentProjectSlug(p) : p)),
              ),
            ];
          }
          // v13 → v14 (ADR-0083): `7d` becomes `week` — the span AND the
          // Date-range preset, both now following the Week setting. Two
          // independent fields, so each renames on its own value (the v4 → v5
          // `24h` precedent, which renamed the span only).
          if (next.span === "7d") next.span = "week";
          if (next.dateRange === "7d") next.dateRange = "week";
          return next;
        }
        return undefined;
      },
    },
  ),
);
