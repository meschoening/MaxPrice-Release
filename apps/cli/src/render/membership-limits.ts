import {
  type AccountEntry,
  formatRemainingLong,
  formatWallClock,
  LIMIT_STATE_WORDS,
  type LiveWindowKind,
  type MembershipLimitState,
  membershipLimitState,
  membershipWindows,
  type OrganizationEntry,
  rankMemberships,
  type ScopeMembershipReading,
  scopeMembershipReadings,
  type TimeDisplay,
  type TrackedMembership,
  usageTone,
  type WindowStateOf,
} from "@maxprice/shared";
import { terminalText } from "@maxprice/usage-core/terminal-text";
import { style, type Style } from "./style";

// The Scope's Memberships as `live`'s Limits list and `status` name them
// (ADR-0140 §3, #642): the Desktop's per-Membership surfaces (Live's limit
// cards, the ranked Popout) read each Membership off /api/accounts the same
// way, `scopeMembershipReadings` ranked by the one most-used ordering
// (`rankMemberships`), each in its `membershipLimitState`. Its windows are
// the ones Live's cards draw (`membershipWindows`): the 5-hour and weekly
// windows, but one whose Organization reports no such limit, then the
// Model-scoped weekly one while the reading holds it, named `<model> weekly`.
// A plan with no 5-hour limit says so (ADR-0142 §2). Nothing is summed, and
// nothing folds: a terminal has no Popout's height.

export type MembershipRow = ScopeMembershipReading & { state: MembershipLimitState };

// The set's Memberships, most used first, each with its state.
export function rankedMembershipRows(
  memberships: readonly TrackedMembership[],
  accounts: readonly AccountEntry[],
  organizationLabels: ReadonlyMap<string, string>,
  now: number,
): MembershipRow[] {
  const rows = scopeMembershipReadings(memberships, accounts, organizationLabels).map((m) => ({
    ...m,
    state: membershipLimitState(m.connection, m.limits, m.reading),
  }));
  return rankMemberships(rows, now);
}

// A window's Window state off the roster (#384): `absent` where the
// Organization has no such limit.
function rosterWindowState(roster: readonly OrganizationEntry[]): WindowStateOf {
  return (uuid, window) => roster.find((o) => o.uuid === uuid)?.limits?.windowStates?.[window];
}

// A Membership's windows as its Limits line names them, each percent rounded.
function windowsOf(row: MembershipRow, roster: readonly OrganizationEntry[], now: number) {
  const windowState = rosterWindowState(roster);
  return membershipWindows(row.reading, row.organizationUuid, windowState, now).map((w) => ({
    ...w,
    label:
      w.kind === "fiveHour"
        ? "5-hour"
        : w.model === null
          ? "weekly"
          : `${terminalText(w.model)} weekly`,
    pct: w.pct === null ? null : Math.round(w.pct),
  }));
}

const PLAIN = style(false);

// The words a stale reading wears: its key expired, so its last reading is
// kept and marked (ADR-0138 §8).
export const STALE = "stale";

export type LimitsTextOptions = {
  roster: readonly OrganizationEntry[];
  now: number;
  display: TimeDisplay;
};

// The words a plan with no 5-hour limit wears on a Limits line (ADR-0142 §2).
export const NO_FIVE_HOUR_LIMIT = "no 5-hour limit";

// A use percent, coloured by its tone (`usageTone`) where `tone` allows.
export function tonedPct(pct: number, toned: boolean, s: Style): string {
  const tone = toned ? usageTone(pct) : null;
  return tone === "bad" ? s.red(`${pct}%`) : tone === "warn" ? s.yellow(`${pct}%`) : `${pct}%`;
}

// A live window's reset as a Limits line words it: the 5-hour one at its
// wall-clock time, a weekly one by the time left.
export function resetText(
  kind: LiveWindowKind,
  resetAtMs: number,
  now: number,
  display: TimeDisplay,
): string {
  return kind === "fiveHour"
    ? `resets ${formatWallClock(resetAtMs, display)}`
    : `resets in ${formatRemainingLong(resetAtMs - now)}`;
}

// A Membership's limits on one line: every window with its reset,
// `5-hour 82% (resets 7:00 PM) · weekly 61% (resets in 3d 4h)`, an idle one
// `—`, then `no 5-hour limit` where its plan has none; an expired key's last
// reading the same, marked `stale`, never coloured and with no reset; else
// the state's words, `no limits`, `not connected` or `not readable now`
// (`LIMIT_STATE_WORDS`).
export function limitsText(row: MembershipRow, options: LimitsTextOptions, s: Style): string {
  const { state } = row;
  if (state !== "readable" && state !== "stale") return s.dim(LIMIT_STATE_WORDS[state]);
  const { now, display, roster } = options;
  // A stale line is greyed whole, so nothing inside it is painted.
  const p = state === "stale" ? PLAIN : s;
  const parts = windowsOf(row, roster, now).map((w) => {
    if (w.pct === null) return `${w.label} ${p.dim("—")}`;
    const pct = tonedPct(w.pct, state === "readable", s);
    if (state !== "readable" || w.resetAtMs === null) return `${w.label} ${pct}`;
    return `${w.label} ${pct} ${p.dim(`(${resetText(w.kind, w.resetAtMs, now, display)})`)}`;
  });
  if (rosterWindowState(roster)(row.organizationUuid, "fiveHour") === "absent") {
    parts.push(p.dim(NO_FIVE_HOUR_LIMIT));
  }
  if (parts.length === 0) return s.dim(state === "stale" ? STALE : "—");
  const text = parts.join(" · ");
  return state === "stale" ? s.dim(`${text} · ${STALE}`) : text;
}
