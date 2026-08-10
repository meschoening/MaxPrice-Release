import {
  TOKEN_CATEGORY_LABELS,
  TOKEN_COLORS,
  TOKEN_DRAW_ORDER,
  TOKEN_LEGEND_ORDER,
  MODEL_COLORS,
  MODEL_DRAW_ORDER,
  MODEL_LEGEND_ORDER,
  PROJECT_OTHER_COLOR,
  PROJECT_PALETTE,
  deriveProjectName,
  slugToPath,
  type TokenCategory,
  type DailyRow,
  type ModelFamily,
} from "@maxprice/shared";
import { bucketFromDaily, type ChartBucket } from "@/lib/chart-bucket";
import { projectTopN, type GroupByAxis } from "@/lib/group-by";
import {
  MACHINE_FALLBACK_COLOR,
  type FoldedMachine,
  type MachineSeriesEntry,
} from "@/lib/machines";
import type { Metric } from "@/state/filters";

// ADR-0033 — the compose step. Turns the selected group-by axes + the fetched
// window data into the flat, ordered series list the three composed chart
// builders draw: one entry per CROSS-PRODUCT combination of the selected axes'
// values, stack-ordered hue-major, colored hue+ramp. Pure & theme-free (the
// single-series brand color is resolved by the builders via `color: null`).

export type ComposedSeries = {
  id: string;
  label: string;
  // null ⇒ the builder substitutes theme.brand (only the empty selection).
  color: string | null;
  values: number[];
  prevValues: number[] | null;
  // The series' per-axis value keys (ADR-0042) — one entry per selected axis
  // (family / slug or OTHER_KEY / target machineId / token band); {} for the
  // empty selection's total series. The mute pass drops series by these.
  parts: Partial<Record<GroupByAxis, string>>;
  // The series' token-type band, when the token-type axis is on — drives the
  // tooltip's "cache N% of total" row.
  tokenType?: TokenCategory;
};

// Every legend group names its axis and every entry carries the same stable
// value key its series' `parts` use (ADR-0042) — the legend's mute toggles
// address series by (axis, value), never by parsing labels.
export type LegendGroup =
  | {
      kind: "hue";
      axis: GroupByAxis;
      entries: Array<{ value: string; label: string; color: string }>;
    }
  | {
      kind: "ramp";
      axis: GroupByAxis;
      entries: Array<{ value: string; label: string; color: string }>;
    }
  | { kind: "stack"; axis: GroupByAxis; entries: Array<{ value: string; label: string }> };

export type Composed = {
  series: ComposedSeries[]; // stack order: index 0 = bottom
  legendGroups: LegendGroup[];
  // Per-bucket totals for the chart summary + tooltip Total row. When the
  // project axis is on these sum the per-project map (all projects, Other
  // included); otherwise they are the rows' own totals (Unknown included,
  // matching the pre-ADR-0033 tooltips).
  totals: number[];
  prevTotals: number[] | null;
  isEmpty: boolean;
};

export type ComposeInput = {
  axes: GroupByAxis[]; // normalized (priority order)
  metric: Metric;
  rows: DailyRow[]; // current window (labels = rows[i].date)
  prevRows: DailyRow[] | null; // ghost window, position-aligned, or null = ghost off/absent
  // Required when axes includes "project": the per-project map. For the
  // intraday path prevProjectData is the adapted per-project previousBuckets;
  // for the daily path pass the SAME doubled-window map for both (the join by
  // prev label slices the previous period out of it). The top-N candidate pool
  // is whatever projectData contains: with a doubled-window map, a prev-only
  // project aligns to all-zero current buckets, ranks at the bottom (total 0),
  // and mints a zero-current, ghost-only series ONLY when fewer than topN
  // projects were current-active — otherwise it folds into Other's prev.
  // (Matches the engine's intraday slugEntry semantics, and keeps the pool
  // stable when the daily path fetches the doubled window unconditionally —
  // the ranking never shifts on a ghost toggle.)
  // Caller contract: when the project axis is on and prevProjectData is
  // absent, the ghost is OFF (every prevValues null, prevTotals null) even if
  // prevRows is present — prevRows alone cannot be split per project.
  projectData?: Record<string, { path: string; rows: DailyRow[] }>;
  prevProjectData?: Record<string, { path: string; rows: DailyRow[] }>;
  // ADR-0041 (M6) — required when axes includes "machine": the per-machine map,
  // ALREADY alias-folded + named (lib/machines.ts foldMachineEntries), keyed by
  // target machineId. `projects` nests the per-(machine, project) rows when the
  // project axis is also on. machineOrder (foldMachines) carries the canonical
  // order + colors + isSelf. Caller contract mirrors the project axis: machine
  // axis on + machineData absent ⇒ isEmpty; ghost on + prevMachineData absent ⇒
  // ghost OFF (prevRows alone cannot be split per machine).
  machineData?: Record<string, MachineSeriesEntry>;
  prevMachineData?: Record<string, MachineSeriesEntry>;
  machineOrder?: FoldedMachine[];
};

// --- color ramp -------------------------------------------------------------

// The dark→light lightness ramp within a hue (ADR-0033): step 0 (first in the
// ramp axis's draw order) sits toward black, the last step toward white.
// Emitted as CSS `color-mix()` so the CSS-canonical var() palette bases
// (T3 §3) resolve in the DOM — the sRGB mix is numerically identical to the
// retired hex math (keep = 1 − |f|, as a 0.1-rounded percent). count==1
// returns the hue untouched.
export function rampColor(base: string, index: number, count: number): string {
  if (count <= 1) return base;
  const f = -0.45 + (index / (count - 1)) * 0.8; // -0.45 … +0.35
  const keep = Math.round((1 - Math.abs(f)) * 1000) / 10;
  return `color-mix(in srgb, ${base} ${keep}%, ${f < 0 ? "#000" : "#fff"})`;
}

// Neutral ramp swatches for the ramp axis's legend group (the per-hue shades
// vary by hue, so the legend shows the ramp on a neutral grey). Deliberately a
// mode-neutral hex literal, not a data-palette token — it's legend chrome.
const RAMP_LEGEND_BASE = "#9ca3af";

// --- per-axis vocabularies ----------------------------------------------------

// Exported for the mute pass's tests + any UI needing the Other sentinel — the
// project axis's fold residual mutes like any value (ADR-0042).
export const OTHER_KEY = "__other__";

// Composite key for the per-(machine, project) nested grids. A NUL joiner can
// appear in neither a machineId nor a slug, so the store and lookup ends can
// never collide or drift onto different separators (the M6 bug: the store used
// a NUL, the lookup a space, so every nested series read back zeros).
const machProjKey = (machineId: string, projectKey: string): string =>
  `${machineId}\0${projectKey}`;

type AxisValue = {
  key: string;
  label: string;
  hueColor: string; // the color this value carries when its axis is the hue axis
};

function modelAxisValues(): AxisValue[] {
  // Draw order (bottom→top): Haiku → … → Fable, dearest on top — same as the
  // retired by-model builders. Unknown is never charted (ADR-0021/0032).
  return MODEL_DRAW_ORDER.map((f) => ({ key: f, label: f, hueColor: MODEL_COLORS[f] }));
}

function tokenTypeAxisValues(): AxisValue[] {
  return TOKEN_DRAW_ORDER.map((c) => ({
    key: c,
    label: TOKEN_CATEGORY_LABELS[c],
    hueColor: TOKEN_COLORS[c],
  }));
}

// --- project ranking ----------------------------------------------------------

// Align one project's sparse rows to the window's label sequence. Keyed on the
// display label, so labels MUST be unique within a window — the same caveat as
// intraday-adapter.ts's by-project join (deferred finding f2b): a DST
// fall-back's repeated wall-clock hour can duplicate a label and merge two
// physically distinct buckets. Deliberately not handled here.
function alignBuckets(rows: DailyRow[], labels: string[]): Array<ChartBucket | null> {
  const byLabel = new Map(rows.map((r) => [r.date, r]));
  return labels.map((l) => {
    const row = byLabel.get(l);
    return row ? bucketFromDaily(row) : null;
  });
}

// Sum ChartBucket `b` into `into` (used to fold non-top projects into Other).
function addBucket(into: ChartBucket, b: ChartBucket): void {
  into.totalCost += b.totalCost;
  into.totalTokens += b.totalTokens;
  for (const f of Object.keys(into.perModel) as ModelFamily[]) {
    into.perModel[f].cost += b.perModel[f].cost;
    into.perModel[f].tokens += b.perModel[f].tokens;
    for (const c of TOKEN_DRAW_ORDER) {
      into.perModel[f].perToken[c].cost += b.perModel[f].perToken[c].cost;
      into.perModel[f].perToken[c].tokens += b.perModel[f].perToken[c].tokens;
    }
  }
  for (const c of TOKEN_DRAW_ORDER) {
    into.perToken[c].cost += b.perToken[c].cost;
    into.perToken[c].tokens += b.perToken[c].tokens;
  }
}

function zeroBucket(label: string): ChartBucket {
  return bucketFromDaily({
    date: label,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 0,
    totalCost: 0,
    modelsUsed: [],
    modelBreakdowns: [],
  });
}

// --- the compose step -----------------------------------------------------------

export function composeSeries(input: ComposeInput): Composed {
  const { axes, metric, rows, prevRows, projectData, prevProjectData } = input;
  const labels = rows.map((r) => r.date);
  const n = labels.length;
  const projectOn = axes.includes("project");
  const machineOn = axes.includes("machine");
  // Null prevLabels ⇒ ghost off everywhere downstream. Besides the usual
  // length-mismatch guard, an axis whose data is split into a per-group map
  // requires that map's PREV counterpart (the caller contract above): prevRows
  // alone cannot be split per group, so a missing prev map turns the ghost OFF
  // rather than silently drawing all-zero bars. On machine paths the project
  // rows are nested in machineData (prevProjectData is never supplied), so the
  // project term yields to the machine term there — the machine prev map gates.
  const prevLabels =
    prevRows &&
    prevRows.length === n &&
    !(projectOn && !machineOn && !prevProjectData) &&
    !(machineOn && !input.prevMachineData)
      ? prevRows.map((r) => r.date)
      : null;

  const pick = (v: { cost: number; tokens: number }): number =>
    metric === "cost" ? v.cost : v.tokens;

  // --- project alignment + ranking (ADR-0034: the prev period reuses the SAME
  // top-N set). Ranked by current-window total in the ACTIVE metric — a metric
  // toggle may reshuffle hue assignment, deliberately. The candidate pool is
  // every projectData key: prev-only projects total 0 here and only mint a
  // (zero-current, ghost-only) series when current-active projects leave top-N
  // slots free. Ties break by slug so hue assignment is deterministic across
  // refetches. ------------------------------------------------------------
  let projectValues: AxisValue[] = [];
  // key → aligned current/prev buckets (null = zero bucket at that position).
  const projBuckets = new Map<string, Array<ChartBucket | null>>();
  const projPrevBuckets = new Map<string, Array<ChartBucket | null>>();

  // --- machine alignment (ADR-0041 M6). Machine is axes[0] whenever selected,
  // so it carries hue from machineOrder (unknown ids get the grey fallback) and
  // the second axis ramps. NO top-N — every entry mints a series (machines are
  // few); a machine present only in the previous window draws zero-current bars
  // with a real ghost. On machine paths the project rows are NESTED in
  // machineData, so the top-level project block below is skipped and this block
  // owns projectValues when the project axis is also on. -----------------------
  const machineValues: AxisValue[] = [];
  const machineLegendEntries: Array<{ value: string; label: string; color: string }> = [];
  // machineId → machine-level aligned grids (drive totals + the machine source).
  const machBuckets = new Map<string, Array<ChartBucket | null>>();
  const machPrevBuckets = new Map<string, Array<ChartBucket | null>>();
  // Keyed by machProjKey(machineId, slugOrOther) → per-(machine, project) aligned grids.
  const machProjBuckets = new Map<string, Array<ChartBucket | null>>();
  const machProjPrevBuckets = new Map<string, Array<ChartBucket | null>>();
  if (machineOn) {
    const machineData = input.machineData ?? {};
    const prevMachineData = input.prevMachineData;
    const folded = input.machineOrder ?? [];
    const foldedById = new Map(folded.map((f) => [f.machineId, f]));
    // Value order: machineOrder order (filtered to ids present in either
    // window), then unknown ids sorted, with the grey fallback color.
    const presentIds = new Set<string>([
      ...Object.keys(machineData),
      ...Object.keys(prevMachineData ?? {}),
    ]);
    const orderedKnown = folded.map((f) => f.machineId).filter((id) => presentIds.has(id));
    const knownSet = new Set(orderedKnown);
    const orderedIds = [
      ...orderedKnown,
      ...[...presentIds].filter((id) => !knownSet.has(id)).sort(),
    ];
    for (const id of orderedIds) {
      const f = foldedById.get(id);
      const entry = machineData[id] ?? prevMachineData?.[id];
      const label = f?.name ?? entry?.name ?? id;
      const hueColor = f?.color ?? MACHINE_FALLBACK_COLOR;
      const isSelf = f?.isSelf ?? entry?.self ?? false;
      machineValues.push({ key: id, label, hueColor });
      // The "(this)" suffix is LEGEND-only — series labels/tooltips stay plain.
      machineLegendEntries.push({
        value: id,
        label: isSelf ? `${label} (this)` : label,
        color: hueColor,
      });
    }
    // Machine-level grids: only current-present machines (the cross product
    // supplies null for a machine absent from one side). isEmpty keys on this.
    for (const [id, entry] of Object.entries(machineData)) {
      machBuckets.set(id, alignBuckets(entry.rows, labels));
    }
    if (prevLabels && prevMachineData) {
      for (const [id, entry] of Object.entries(prevMachineData)) {
        machPrevBuckets.set(id, alignBuckets(entry.rows, prevLabels));
      }
    }
    // --- machine + project: rank slugs by summing nested rows ACROSS machines
    // (machine is a combining axis ⇒ projectTopN = 3); each machine folds its
    // OWN non-top slugs into that machine's Other. Project VALUES come from the
    // summed ranking, ties by slug.
    if (projectOn) {
      const slugTotals = new Map<string, number>();
      const slugPath = new Map<string, string>();
      const curSlugGrids = new Map<string, Map<string, Array<ChartBucket | null>>>();
      for (const [mid, entry] of Object.entries(machineData)) {
        const grid = new Map<string, Array<ChartBucket | null>>();
        for (const [slug, { path, rows: pr }] of Object.entries(entry.projects ?? {})) {
          const bs = alignBuckets(pr, labels);
          grid.set(slug, bs);
          const total = bs.reduce(
            (s, b) => s + (b ? pick({ cost: b.totalCost, tokens: b.totalTokens }) : 0),
            0,
          );
          slugTotals.set(slug, (slugTotals.get(slug) ?? 0) + total);
          if (!slugPath.has(slug)) slugPath.set(slug, path);
        }
        curSlugGrids.set(mid, grid);
      }
      const ranked = [...slugTotals.keys()].sort(
        (a, b) => (slugTotals.get(b) ?? 0) - (slugTotals.get(a) ?? 0) || a.localeCompare(b),
      );
      const topN = projectTopN(axes);
      const topSlugs = ranked.slice(0, topN);
      const topSet = new Set(topSlugs);
      const hasOther = ranked.length > topN;
      projectValues = topSlugs.map((slug, idx) => ({
        key: slug,
        // Every ranked slug is populated from the same walk that filled
        // `slugPath`, so the fallback is defensive — but it decodes the slug
        // rather than rendering it raw, matching the sidecar's own fallback.
        label: deriveProjectName(slugPath.get(slug) ?? slugToPath(slug)),
        hueColor: PROJECT_PALETTE[idx % PROJECT_PALETTE.length] as string,
      }));
      if (hasOther) {
        projectValues.push({ key: OTHER_KEY, label: "Other", hueColor: PROJECT_OTHER_COLOR });
      }
      const foldOther = (
        grid: Map<string, Array<ChartBucket | null>>,
        into: Map<string, Array<ChartBucket | null>>,
        mid: string,
        otherLabels: string[],
      ) => {
        for (const slug of topSlugs) {
          into.set(machProjKey(mid, slug), grid.get(slug) ?? labels.map(() => null));
        }
        if (hasOther) {
          const other = otherLabels.map((l) => zeroBucket(l));
          for (const [slug, bs] of grid) {
            if (topSet.has(slug)) continue;
            bs.forEach((b, i) => {
              const target = other[i];
              if (b && target) addBucket(target, b);
            });
          }
          into.set(machProjKey(mid, OTHER_KEY), other);
        }
      };
      for (const [mid, grid] of curSlugGrids) foldOther(grid, machProjBuckets, mid, labels);
      // Previous-window nested grids reuse the SAME top-N set (ADR-0034).
      if (prevLabels && prevMachineData) {
        for (const [mid, entry] of Object.entries(prevMachineData)) {
          const grid = new Map<string, Array<ChartBucket | null>>();
          for (const [slug, { rows: pr }] of Object.entries(entry.projects ?? {})) {
            grid.set(slug, alignBuckets(pr, prevLabels));
          }
          foldOther(grid, machProjPrevBuckets, mid, prevLabels);
        }
      }
    }
  }

  // --- project alignment + ranking (ADR-0034: the prev period reuses the SAME
  // top-N set). Non-machine paths only — on machine paths the nested block above
  // owns projectValues, and projectData/prevProjectData are never supplied.
  if (projectOn && !machineOn) {
    const entries = Object.entries(projectData ?? {});
    const aligned = entries.map(([slug, { path, rows: pr }]) => {
      const buckets = alignBuckets(pr, labels);
      const total = buckets.reduce(
        (s, b) => s + (b ? pick({ cost: b.totalCost, tokens: b.totalTokens }) : 0),
        0,
      );
      return { slug, path, buckets, total };
    });
    aligned.sort((a, b) => b.total - a.total || a.slug.localeCompare(b.slug));
    const topN = projectTopN(axes);
    const top = aligned.slice(0, topN);
    const rest = aligned.slice(topN);
    projectValues = top.map(({ slug, path }, idx) => ({
      key: slug,
      label: deriveProjectName(path),
      hueColor: PROJECT_PALETTE[idx % PROJECT_PALETTE.length] as string,
    }));
    for (const { slug, buckets } of top) projBuckets.set(slug, buckets);
    if (rest.length > 0) {
      projectValues.push({ key: OTHER_KEY, label: "Other", hueColor: PROJECT_OTHER_COLOR });
      const other = labels.map((l) => zeroBucket(l));
      for (const { buckets } of rest) {
        buckets.forEach((b, i) => {
          const target = other[i];
          if (b && target) addBucket(target, b);
        });
      }
      projBuckets.set(OTHER_KEY, other);
    }
    // Previous-window alignment for the SAME keys (ADR-0034). For Other, fold
    // every non-top project found in prevProjectData.
    if (prevLabels && prevProjectData) {
      const topSet = new Set(top.map((t) => t.slug));
      const otherPrev = labels.map((_, i) => zeroBucket(prevLabels[i] ?? ""));
      for (const [slug, { rows: pr }] of Object.entries(prevProjectData)) {
        const buckets = alignBuckets(pr, prevLabels);
        if (topSet.has(slug)) {
          projPrevBuckets.set(slug, buckets);
        } else {
          buckets.forEach((b, i) => {
            const target = otherPrev[i];
            if (b && target) addBucket(target, b);
          });
        }
      }
      if (projBuckets.has(OTHER_KEY)) projPrevBuckets.set(OTHER_KEY, otherPrev);
    }
  }

  // --- current/prev top-level buckets ----------------------------------------
  // Only the flat path reads these: when the project OR machine axis is on,
  // every series reads its per-group grids and totals fold those — so building
  // these would be ~2×N (up to ~2,880 intraday buckets) wasted bucketFromDaily
  // allocations per recompose (f3).
  const buckets: ChartBucket[] = projectOn || machineOn ? [] : rows.map(bucketFromDaily);
  const prevBuckets =
    projectOn || machineOn ? null : prevLabels && prevRows ? prevRows.map(bucketFromDaily) : null;

  // Value of one combo at bucket index i, over a given bucket source.
  const comboValue = (
    bucket: ChartBucket | null,
    family: ModelFamily | null,
    tokenType: TokenCategory | null,
  ): number => {
    if (!bucket) return 0;
    if (family && tokenType) return pick(bucket.perModel[family].perToken[tokenType]);
    if (family) return pick(bucket.perModel[family]);
    if (tokenType) return pick(bucket.perToken[tokenType]);
    return pick({ cost: bucket.totalCost, tokens: bucket.totalTokens });
  };

  // Bucket-source picker for one (machKey, projKey) combo. The four sources —
  // machine×project, machine, project, flat — mirror the axis nesting, and the
  // current and previous windows walk the identical branch structure (only the
  // `src` grids differ), so cur/prev can never drift out of sync by hand. The
  // machine×project grid is keyed via machProjKey — NEVER re-inline the NUL join
  // (the M6/M7 nested-series-zeros bug). `flat` and `projFallback` are passed by
  // the caller because they are ASYMMETRIC between the windows: the current grid
  // uses [] for an absent project, the previous grid a null-filled row (and the
  // flat fallback is `buckets` vs `prevBuckets`).
  const pickSource = (
    machKey: string | null,
    projKey: string | null,
    src: {
      machProj: Map<string, Array<ChartBucket | null>>;
      mach: Map<string, Array<ChartBucket | null>>;
      proj: Map<string, Array<ChartBucket | null>>;
      flat: Array<ChartBucket | null>;
      projFallback: Array<ChartBucket | null>;
    },
  ): Array<ChartBucket | null> => {
    if (machKey) {
      return projKey
        ? (src.machProj.get(machProjKey(machKey, projKey)) ?? labels.map(() => null))
        : (src.mach.get(machKey) ?? labels.map(() => null));
    }
    if (projKey) return src.proj.get(projKey) ?? src.projFallback;
    return src.flat;
  };

  // --- the cross product, hue-major ------------------------------------------
  // Axis loops in priority order: machine (if on) → model (if on) → project (if
  // on) → token type (if on), matching GROUP_BY_AXES. The FIRST selected axis is
  // the hue carrier, the second the ramp; further axes ride stack order.
  const machineVals: Array<AxisValue | null> = machineOn ? machineValues : [null];
  const modelVals: Array<AxisValue | null> = axes.includes("model") ? modelAxisValues() : [null];
  const projVals: Array<AxisValue | null> = projectOn ? projectValues : [null];
  const tokenTypeVals: Array<AxisValue | null> = axes.includes("tokenType")
    ? tokenTypeAxisValues()
    : [null];

  const series: ComposedSeries[] = [];
  const rampAxis = axes[1] ?? null;

  for (const mav of machineVals) {
    for (const mv of modelVals) {
      for (const pv of projVals) {
        for (const tv of tokenTypeVals) {
          const parts = [mav, mv, pv, tv].filter((p): p is AxisValue => p !== null);
          if (parts.length === 0) {
            // Empty selection — single un-split totals series, brand-colored.
            series.push({
              id: "total",
              label: "Total",
              color: null,
              values: buckets.map((b) => comboValue(b, null, null)),
              prevValues: prevBuckets ? prevBuckets.map((b) => comboValue(b, null, null)) : null,
              parts: {},
            });
            continue;
          }
          // Hue from the first part; ramp index from the second.
          const hueVal = parts[0] as AxisValue;
          const rampVal = parts[1];
          const rampVals =
            rampAxis === "model"
              ? modelVals
              : rampAxis === "project"
                ? projVals
                : rampAxis === "tokenType"
                  ? tokenTypeVals
                  : [];
          const color = rampVal
            ? rampColor(
                hueVal.hueColor,
                rampVals.findIndex((r) => r !== null && r.key === rampVal.key),
                rampVals.length,
              )
            : hueVal.hueColor;
          const family = (mv?.key ?? null) as ModelFamily | null;
          const tokenType = (tv?.key ?? null) as TokenCategory | null;
          const machKey = mav?.key ?? null;
          const projKey = pv?.key ?? null;
          // Bucket source: machine paths read the per-machine (or per-machine×
          // project) grids, filling null for a machine absent from that side;
          // non-machine paths keep the flat/project logic verbatim. pickSource
          // walks the same nesting for both windows; the prev window as a whole
          // is gated on prevLabels (no ghost ⇒ every prev source null).
          const curSrc = pickSource(machKey, projKey, {
            machProj: machProjBuckets,
            mach: machBuckets,
            proj: projBuckets,
            flat: buckets,
            projFallback: [],
          });
          const prevSrc = prevLabels
            ? pickSource(machKey, projKey, {
                machProj: machProjPrevBuckets,
                mach: machPrevBuckets,
                proj: projPrevBuckets,
                flat: prevBuckets ?? [],
                projFallback: labels.map(() => null),
              })
            : null;
          series.push({
            id: parts.map((p) => p.key).join("|"),
            label: parts.map((p) => p.label).join(" · "),
            color,
            values: labels.map((_, i) => comboValue(curSrc[i] ?? null, family, tokenType)),
            prevValues: prevSrc
              ? labels.map((_, i) => comboValue(prevSrc[i] ?? null, family, tokenType))
              : null,
            parts: {
              ...(mav ? { machine: mav.key } : {}),
              ...(mv ? { model: mv.key } : {}),
              ...(pv ? { project: pv.key } : {}),
              ...(tv ? { tokenType: tv.key } : {}),
            },
            ...(tokenType ? { tokenType } : {}),
          });
        }
      }
    }
  }

  // --- totals -----------------------------------------------------------------
  // machine on ⇒ sum the machine-LEVEL grids (not the nested per-project ones);
  // project on ⇒ sum the per-project grids; otherwise the flat bucket totals.
  const sumGrids = (grids: Map<string, Array<ChartBucket | null>>): number[] =>
    labels.map((_, i) => {
      let sum = 0;
      for (const bs of grids.values()) sum += comboValue(bs[i] ?? null, null, null);
      return sum;
    });
  const totals = machineOn
    ? sumGrids(machBuckets)
    : projectOn
      ? sumGrids(projBuckets)
      : buckets.map((b) => comboValue(b, null, null));
  const prevTotals = machineOn
    ? prevLabels
      ? sumGrids(machPrevBuckets)
      : null
    : projectOn
      ? prevLabels
        ? sumGrids(projPrevBuckets)
        : null
      : prevBuckets
        ? prevBuckets.map((b) => comboValue(b, null, null))
        : null;

  // --- legend groups (per-axis; ADR-0033/ADR-0041) -----------------------------
  const legendGroups: LegendGroup[] = [];
  for (const [pos, axis] of axes.entries()) {
    if (pos === 0) {
      // Hue group — the axis's own palette, in LEGEND order. Machine carries the
      // "(this)" self-suffix here (legend only; series labels stay plain). Every
      // entry carries its stable value key (ADR-0042) for the mute toggles.
      const entries =
        axis === "machine"
          ? machineLegendEntries
          : axis === "model"
            ? MODEL_LEGEND_ORDER.map((f) => ({
                value: f as string,
                label: f as string,
                color: MODEL_COLORS[f],
              }))
            : axis === "tokenType"
              ? TOKEN_LEGEND_ORDER.map((c) => ({
                  value: c as string,
                  label: TOKEN_CATEGORY_LABELS[c],
                  color: TOKEN_COLORS[c],
                }))
              : projectValues.map((p) => ({ value: p.key, label: p.label, color: p.hueColor }));
      legendGroups.push({ kind: "hue", axis, entries });
    } else if (pos === 1) {
      // Ramp group — dark→light neutral swatches in DRAW (ramp) order,
      // generalized to the actual second axis (model / project / token type).
      const vals =
        axis === "model"
          ? modelAxisValues()
          : axis === "tokenType"
            ? tokenTypeAxisValues()
            : projectValues;
      legendGroups.push({
        kind: "ramp",
        axis,
        entries: vals.map((v, i) => ({
          value: v.key,
          label: v.label,
          color: rampColor(RAMP_LEGEND_BASE, i, vals.length),
        })),
      });
    } else {
      // Stack axis (pos ≥ 2) — stack order + tooltip only. Reachable axes here
      // are project and token type (machine/model outrank them, so they can
      // only be pos 0/1); generalize the labels to whichever it is.
      const entries =
        axis === "project"
          ? projectValues.map((p) => ({ value: p.key, label: p.label }))
          : tokenTypeAxisValues().map((v) => ({ value: v.key, label: v.label }));
      legendGroups.push({ kind: "stack", axis, entries });
    }
  }

  const isEmpty = machineOn
    ? machBuckets.size === 0
    : projectOn
      ? projBuckets.size === 0
      : rows.length === 0;
  return { series, legendGroups, totals, prevTotals, isEmpty };
}
