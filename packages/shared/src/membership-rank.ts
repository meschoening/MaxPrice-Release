import {
  membershipReadability,
  type OrgLimitsAnswer,
  type UsageConnection,
  type UsageReading,
  type WindowState,
} from "./usage-limits";

// The one "most used" ordering (ADR-0136 §6 as amended by #610/#622, ADR-0138
// §8, #633): Live's limit area, the Readout, the Popout head, the Blocks tabs,
// the Hub console and the Headless views all rank Memberships by it, and the
// poller's per-Organization projection breaks a tie between two Memberships of
// one Organization with it. Pure: each surface maps its own rows onto
// `RankableMembership` and keeps whatever else it carries (the generic `T`).
//
// 1. Ranked first: Readable memberships, and a stale one — its key expired —
//    whose last answer was readable. A stale reading keeps its rank by that
//    reading (§8); whether it may drive a number is the surface's choice (the
//    Readout never lets it).
// 2. Within each group, by the highest percent of any live window: a window in
//    the reading whose reset is still ahead. An idle window is no reading (the
//    reading holds no window for it), and neither is a window whose reset has
//    passed, which a stale reading can hold.
// 3. Ties, and Memberships with no live window: by label, then by key, in code
//    unit order, so every surface and every process orders them alike.

export type RankableMembership = {
  // A stable, unique id for the Membership, e.g. `${account}/${organization}`.
  key: string;
  // What the surface shows for it; the first tiebreak.
  label: string;
  // Its Account's connection, and its Organization's last Limits answer (null
  // before any).
  connection: UsageConnection;
  limits: OrgLimitsAnswer | null;
  // Its last reading, null when none is held.
  reading: Pick<UsageReading, "fiveHour" | "weekly" | "weeklyModel"> | null;
};

export type LiveWindowKind = "fiveHour" | "weekly" | "weeklyModel";

// A reading's most used live window, or null when it holds none.
export function mostUsedWindow(
  reading: RankableMembership["reading"],
  nowMs: number,
): { kind: LiveWindowKind; utilizationPct: number } | null {
  if (reading === null) return null;
  let best: { kind: LiveWindowKind; utilizationPct: number } | null = null;
  for (const kind of ["fiveHour", "weekly", "weeklyModel"] as const) {
    const window = reading[kind];
    if (window == null) continue;
    const reset = Date.parse(window.resetAt);
    if (!(reset > nowMs)) continue;
    if (best === null || window.utilizationPct > best.utilizationPct) {
      best = { kind, utilizationPct: window.utilizationPct };
    }
  }
  return best;
}

function ranked(m: RankableMembership): boolean {
  if (membershipReadability(m.connection, m.limits) === "readable") return true;
  return m.connection === "expired" && (m.limits === "windows" || m.limits === "none");
}

// Strings by UTF-16 code unit, as `Array.prototype.sort` with no comparator,
// independent of locale.
export const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// A new array, most used first; the input is not touched.
export function rankMemberships<T extends RankableMembership>(
  memberships: readonly T[],
  nowMs: number,
): T[] {
  const keyed = memberships.map((m) => ({
    m,
    ranked: ranked(m),
    peak: mostUsedWindow(m.reading, nowMs)?.utilizationPct ?? Number.NEGATIVE_INFINITY,
  }));
  keyed.sort(
    (a, b) =>
      Number(b.ranked) - Number(a.ranked) ||
      (b.peak === a.peak ? 0 : b.peak > a.peak ? 1 : -1) ||
      byCodeUnit(a.m.label, b.m.label) ||
      byCodeUnit(a.m.key, b.m.key),
  );
  return keyed.map((k) => k.m);
}

// --- What a Membership's limits show ------------------------------------------

// A Membership's state on a surface that lists Memberships (Live's limit
// area, the Blocks tabs, the ranked Popout): what its Account's key and its
// Organization's last Limits answer let it show (ADR-0138 §8, #610's states).
//   readable      — windows to draw;
//   no-limits     — read, and the Organization reports no supported limit;
//   stale         — the key expired: the last-known reading, greyed;
//   not-connected — no key reads this Account;
//   unreadable    — a key, but no reading now (refused, failed, or not read yet).
export type MembershipLimitState =
  | "readable"
  | "no-limits"
  | "stale"
  | "not-connected"
  | "unreadable";

export function membershipLimitState(
  connection: UsageConnection,
  limits: OrgLimitsAnswer | null,
  reading: RankableMembership["reading"],
): MembershipLimitState {
  if (connection === "disconnected") return "not-connected";
  if (connection === "expired") return reading === null ? "not-connected" : "stale";
  if (membershipReadability(connection, limits) === "readable") {
    return limits === "none" ? "no-limits" : "readable";
  }
  return "unreadable";
}

// What a Membership with no percent to draw says in its place, in each state
// but `readable` (#610/#619's words): the ranked Popout's rows, the Blocks
// tabs' badges and, capitalised, the Membership strip's Limits note all read
// this one map.
export const LIMIT_STATE_WORDS: Record<Exclude<MembershipLimitState, "readable">, string> = {
  "no-limits": "no limits",
  stale: "key expired",
  "not-connected": "not connected",
  unreadable: "not readable now",
};

// --- A Membership's windows ---------------------------------------------------

// A window's Window state for an Organization (#384), as the surface reads it
// off its roster: `absent` when the Organization has no such limit.
export type WindowStateOf = (
  organizationUuid: string,
  window: "fiveHour" | "weekly",
) => WindowState | undefined;

// One window of a Membership's reading. A window with no live reading is
// idle: `pct` and `resetAtMs` null.
export type MembershipWindow = {
  kind: LiveWindowKind;
  // The Model-scoped weekly window's model; null for the 5-hour and weekly.
  model: string | null;
  // The percent used, unrounded, or null for an idle window.
  pct: number | null;
  // When it resets, for a live window.
  resetAtMs: number | null;
};

// A window's live reading, null when absent or its reset has passed.
function liveWindow(
  window: { utilizationPct: number; resetAt: string } | null | undefined,
  nowMs: number,
): { pct: number; resetAtMs: number } | null {
  if (window == null) return null;
  const reset = Date.parse(window.resetAt);
  if (!(reset > nowMs)) return null;
  return { pct: window.utilizationPct, resetAtMs: reset };
}

// Every window of a Membership's reading, as Live's cards, the Blocks strip's
// Limits and the Headless client's Limits lines list them: 5-hour and weekly
// (none for one whose Organization has no such limit), then the Model-scoped
// weekly one while the reading holds it. Each surface names them its own way.
export function membershipWindows(
  reading: RankableMembership["reading"],
  organizationUuid: string,
  windowState: WindowStateOf | undefined,
  nowMs: number,
): MembershipWindow[] {
  const out: MembershipWindow[] = [];
  for (const kind of ["fiveHour", "weekly"] as const) {
    // No such limit (an Enterprise organization's weekly): no window at all.
    if (windowState?.(organizationUuid, kind) === "absent") continue;
    const live = liveWindow(reading?.[kind], nowMs);
    out.push({ kind, model: null, pct: live?.pct ?? null, resetAtMs: live?.resetAtMs ?? null });
  }
  const model = reading?.weeklyModel;
  if (model != null) {
    const live = liveWindow(model, nowMs);
    out.push({
      kind: "weeklyModel",
      model: model.model,
      pct: live?.pct ?? null,
      resetAtMs: live?.resetAtMs ?? null,
    });
  }
  return out;
}

// The tag a most used window wears beside its percent: `wk` for a weekly one
// (the model's weekly included), none for the 5-hour one (#610).
export function windowTag(kind: LiveWindowKind): "wk" | null {
  return kind === "fiveHour" ? null : "wk";
}

// A use percent reads warning-coloured from 75% used and bad, "hot", from
// 90% (#620 item 4): the Account menu's rows, the limit area's cards and
// windows, the Blocks tabs and the ranked Popout colour and count by this one
// rule.
export const USE_WARN_PCT = 75;
export const USE_BAD_PCT = 90;

export function usageTone(usePct: number | null): "bad" | "warn" | null {
  if (usePct === null) return null;
  return usePct >= USE_BAD_PCT ? "bad" : usePct >= USE_WARN_PCT ? "warn" : null;
}
