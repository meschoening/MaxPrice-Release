import type { DailyRow, HubConnection, HubMachine } from "@maxprice/shared";
import { MACHINE_PALETTE, resolveMergeTarget } from "@maxprice/shared";
import { mergeRows } from "@/lib/rollup";
import type { DateRangePreset } from "@/state/filters";

// ADR-0041 (M6) — the renderer's machine-identity toolbox. The engine and the
// wire are id-exact; EVERYTHING name/alias/color-shaped lives here, renderer-
// side, where the machine directory already is: transitive mergedInto
// resolution, the alias-closure filter expansion, the ONE canonical
// color/order assignment, series folding, the seed percent, and the machine UI
// gate. Pure functions only — no ambient clock, no fetches.

// Grey for ids the directory doesn't know — the machine axis's own neutral
// glass token (T3 §3; per-axis scoping, mirroring --proj-other's role).
export const MACHINE_FALLBACK_COLOR = "var(--mach-other)";

// Follow a mergedInto chain to its terminal target. Transitive; cycle-safe (a
// malformed directory stops at the first repeat rather than spinning). Unknown
// ids resolve to themselves. Delegates to the shared resolver (ADR-0041) so the
// client and hub console walk aliases identically — the arg order stays
// (id, machines) for the renderer's many call sites.
export function resolveMachineTarget(id: string, machines: HubMachine[]): string {
  return resolveMergeTarget(machines, id);
}

export type FoldedMachine = {
  machineId: string;
  name: string;
  color: string;
  isSelf: boolean;
};

// The canonical machine list every surface shares: directory TARGETS only
// (mergedInto === null), registeredAt-ascending (ties by machineId), colored
// by index from MACHINE_PALETTE. Deliberately NOT window-total rank (the
// project-axis pattern): machines are few, never top-N-capped, and the list
// dots must match the chart hue — stability across windows beats rank.
export function foldMachines(machines: HubMachine[], selfId: string): FoldedMachine[] {
  const selfTarget = resolveMachineTarget(selfId, machines);
  return machines
    .filter((m) => m.mergedInto === null)
    .sort(
      (a, b) =>
        a.registeredAt.localeCompare(b.registeredAt) || a.machineId.localeCompare(b.machineId),
    )
    .map((m, i) => ({
      machineId: m.machineId,
      name: m.name,
      color: MACHINE_PALETTE[i % MACHINE_PALETTE.length] as string,
      isSelf: m.machineId === selfTarget,
    }));
}

// The display fallback for an id the directory doesn't know — mirrors the
// hub's own registration fallback shape ("machine-<prefix>").
export function shortMachineId(id: string): string {
  return `machine-${id.slice(0, 8)}`;
}

export function machineName(id: string, machines: HubMachine[]): string {
  const target = resolveMachineTarget(id, machines);
  const entry = machines.find((m) => m.machineId === target);
  return entry?.name ?? shortMachineId(target);
}

export function machineColor(id: string, folded: FoldedMachine[], machines: HubMachine[]): string {
  const target = resolveMachineTarget(id, machines);
  return folded.find((f) => f.machineId === target)?.color ?? MACHINE_FALLBACK_COLOR;
}

// The alias-closure expansion for machine= params (the engine stays id-exact —
// ADR-0041): selecting a target selects every id that resolves into it, so
// merged history matches. Selected ids ride through verbatim (an id the
// directory has forgotten still filters exactly). Sorted for stable keys/URLs.
export function expandMachineFilter(selected: string[], machines: HubMachine[]): string[] {
  if (selected.length === 0) return [];
  const targets = new Set(selected.map((id) => resolveMachineTarget(id, machines)));
  const out = new Set<string>(selected);
  for (const m of machines) {
    if (targets.has(resolveMachineTarget(m.machineId, machines))) out.add(m.machineId);
  }
  return [...out].sort();
}

// Dedupe a machine-id list through alias resolution (ADR-0041 M6): an aliased
// id and its merge target collapse to a single terminal id, first-seen order
// preserved. The Machines-column / session-detail chip source of truth.
export function foldMachineIdList(ids: string[], machines: HubMachine[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    const target = resolveMachineTarget(id, machines);
    if (!seen.has(target)) {
      seen.add(target);
      out.push(target);
    }
  }
  return out;
}

// --- series folding (merged machines are rare; correctness over speed) -------
//
// The arithmetic itself lives in lib/rollup.ts — the project axis folds a
// repository's worktrees with the identical operations (ADR-0061).

export type MachineSeriesEntry = {
  name: string;
  self: boolean;
  rows: DailyRow[];
  projects?: Record<string, { path: string; rows: DailyRow[] }>;
};

// Fold a raw per-machineId map (byMachine wire entries, already adapted to
// DailyRow[]) into per-TARGET entries: alias ids merge into their resolution
// target (rows summed label-keyed; nested project maps merged per-slug, first
// path wins), names/self resolved from the directory.
export function foldMachineEntries(
  raw: Record<
    string,
    { rows: DailyRow[]; projects?: Record<string, { path: string; rows: DailyRow[] }> }
  >,
  machines: HubMachine[],
  selfId: string,
): Record<string, MachineSeriesEntry> {
  const selfTarget = resolveMachineTarget(selfId, machines);
  const out: Record<string, MachineSeriesEntry> = {};
  for (const [id, entry] of Object.entries(raw)) {
    const target = resolveMachineTarget(id, machines);
    const existing = out[target];
    if (!existing) {
      out[target] = {
        name: machineName(target, machines),
        self: target === selfTarget,
        rows: entry.rows.map((r) => ({ ...r })),
        ...(entry.projects
          ? {
              projects: Object.fromEntries(
                Object.entries(entry.projects).map(([slug, p]) => [
                  slug,
                  { path: p.path, rows: p.rows.map((r) => ({ ...r })) },
                ]),
              ),
            }
          : {}),
      };
      continue;
    }
    existing.rows = mergeRows(existing.rows, entry.rows);
    if (entry.projects) {
      existing.projects ??= {};
      for (const [slug, p] of Object.entries(entry.projects)) {
        const intoSlug = existing.projects[slug];
        existing.projects[slug] = intoSlug
          ? { path: intoSlug.path, rows: mergeRows(intoSlug.rows, p.rows) }
          : { path: p.path, rows: p.rows.map((r) => ({ ...r })) };
      }
    }
  }
  return out;
}

// --- seed percent + the machine UI gate + the Live subtitle ------------------

// The seed display percent (ADR-0041): clamp(cursor/target), rounded — NEVER an
// event count (seq-space overcounts; the percent hides the approximation).
// target 0 is the empty-archive seed, which completes immediately — read 100.
export function seedPercent(seed: { cursor: number; target: number } | null): number | null {
  if (seed === null) return null;
  if (seed.target <= 0) return 100;
  return Math.min(100, Math.round((seed.cursor / seed.target) * 100));
}

// The machine UI gate (ADR-0041, ONE rule / three surfaces): the replica
// toggle AND a configured hub — from settings.hubUrl (the packaged app) or a
// non-off sidecar hub connection (the standalone-Vite rig, where the sidecar
// was configured via MAXPRICE_HUB_URL and renderer settings are defaults).
// Both arms are CONFIGURATION state; the gate is never data-presence-gated.
export function machineUiEnabled(opts: {
  hubFleetReplica: boolean;
  hubUrl: string;
  hubConnection: HubConnection;
}): boolean {
  return opts.hubFleetReplica && (opts.hubUrl !== "" || opts.hubConnection !== "off");
}

// Today's exact subtitle range fragments — liveSubtitle must be byte-identical
// to the retired SUBTITLE record whenever the fleet gate is off.
const RANGE_TEXT: Record<DateRangePreset, string> = {
  "24h": "Last 24 hours",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  "90d": "Last 90 days",
  all: "All time",
};

// The Live page subtitle (ADR-0041 M6): the fleet line on a replica client
// ("streaming from N machines", N = alias-folded directory targets, only when
// the fleet is ≥ 2 — a fleet of one keeps today's copy), doubling as the seed
// line mid-seed. Gated off ⇒ byte-identical to today's strings. The saturation
// line (issue #116 / F4) rides the same slot, below seed progress in
// precedence: seeding is the rarer, more actionable state, and mid-seed a busy
// engine is expected — "catching up" there would be noise over signal.
export function liveSubtitle(opts: {
  dateRange: DateRangePreset;
  seed: { cursor: number; target: number } | null;
  machineCount: number;
  fleetOn: boolean;
  saturated?: boolean;
}): string {
  const range = RANGE_TEXT[opts.dateRange];
  if (opts.fleetOn && opts.seed !== null) {
    return `${range} · Syncing fleet history — ${seedPercent(opts.seed)}%`;
  }
  if (opts.saturated === true) {
    return `${range} · catching up…`;
  }
  if (opts.fleetOn && opts.machineCount >= 2) {
    return `${range} · streaming from ${opts.machineCount} machines`;
  }
  return `${range} · streaming from this machine`;
}
