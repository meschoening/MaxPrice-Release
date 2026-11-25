import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { z } from "zod";
import { parentProjectSlug, type DateRangePreset, type Span, spanSchema } from "@maxprice/shared";
import { groupByAxisSchema, normalizeAxes, type GroupByAxis } from "@/lib/group-by";

// The Live chart's spans are the shared `spanSchema`'s (`./intraday`). Every
// renderer module takes `Span` from here. `GroupByAxis` is owned by
// `@/lib/group-by` (ADR-0033) and re-exported so chart consumers import both
// from one place.
export type { GroupByAxis, Span };

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
      version: 15,
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
      // v0.1.0, the first release, shipped v12, so v12 is the oldest payload a
      // released install can hold; the dev-only v1..v11 steps are gone, and
      // such a payload falls back to the initial state (#690).
      // v12 → v13 maps a persisted worktree slug onto the project that now
      // owns it (ADR-0061). v13 → v14 renames `7d` to `week` — BOTH the span
      // and the Date-range preset, which now follow the Week setting
      // (ADR-0083). v14 → v15 rewrites the retired `block` span to `today`,
      // the nearest frame to a 5-hour window, and keeps everything else
      // (ADR-0142 §6): left alone, `block` would fail the schema and `merge`
      // would drop every filter with it.
      migrate: (state, version) => {
        if (version === 15) return state;
        if (version === 12 || version === 13 || version === 14) {
          if (!state || typeof state !== "object") return undefined;
          const next = { ...(state as Record<string, unknown>) };
          // v12 → v13 (ADR-0061): worktrees fold into their project, so a
          // persisted worktree slug maps to the project that now owns it and
          // duplicates collapse. Left alone it would still filter correctly —
          // the sidecar matches it exactly — but it would select nothing the
          // menu can show as selected, so the rail would look unfiltered while
          // the data was not.
          if (version <= 13 && Array.isArray(next.projects)) {
            next.projects = [
              ...new Set(
                next.projects.map((p) => (typeof p === "string" ? parentProjectSlug(p) : p)),
              ),
            ];
          }
          // v13 → v14 (ADR-0083): `7d` becomes `week` — the span AND the
          // Date-range preset, both now following the Week setting.
          if (next.span === "7d") next.span = "week";
          if (next.dateRange === "7d") next.dateRange = "week";
          // v14 → v15 (ADR-0142 §6): the Block span is gone.
          if (next.span === "block") next.span = "today";
          return next;
        }
        return undefined;
      },
    },
  ),
);
