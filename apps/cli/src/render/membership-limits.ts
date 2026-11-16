import {
  type AccountEntry,
  formatRemainingLong,
  formatWallClock,
  LIMIT_STATE_WORDS,
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
} from "@maxprice/shared";
import { terminalText } from "@maxprice/usage-core/terminal-text";
import { style, type Style } from "./style";

// The Scope's Memberships as `blocks`' section headers and `live`'s Limits
// list name them (ADR-0140 §3, #642): the Desktop's per-Membership surfaces
// (the Blocks tabs and strip, Live's limit cards, the ranked Popout) read
// each Membership off /api/accounts the same way, `scopeMembershipReadings`
// ranked by the one most-used ordering (`rankMemberships`), each in its
// `membershipLimitState`. Its windows are the ones Live's cards and the
// Blocks strip draw (`membershipWindows`): the 5-hour and weekly windows, but
// one whose Organization reports no such limit, then the Model-scoped weekly
// one while the reading holds it, named `<model> weekly`. Nothing is summed,
// and nothing folds: a terminal has no Popout's height.

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

// A Membership's windows as its Limits line names them, each percent rounded.
function windowsOf(row: MembershipRow, roster: readonly OrganizationEntry[], now: number) {
  const windowState = (uuid: string, window: "fiveHour" | "weekly") =>
    roster.find((o) => o.uuid === uuid)?.limits?.windowStates?.[window];
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
  // Each live window's reset beside its percent (`live`); a section header
  // (`blocks`) names the percents alone, as the Blocks strip does.
  resets: boolean;
};

// A Membership's limits on one line: every window, `5-hour 82% · weekly 61%`,
// an idle one `—`; an expired key's last reading the same, marked `stale`,
// never coloured and with no reset; else the state's words, `no limits`,
// `not connected` or `not readable now` (`LIMIT_STATE_WORDS`).
export function limitsText(row: MembershipRow, options: LimitsTextOptions, s: Style): string {
  const { state } = row;
  if (state !== "readable" && state !== "stale") return s.dim(LIMIT_STATE_WORDS[state]);
  const { now, display } = options;
  const windows = windowsOf(row, options.roster, now);
  if (windows.length === 0) return s.dim(state === "stale" ? STALE : "—");
  // A stale line is greyed whole, so nothing inside it is painted.
  const p = state === "stale" ? PLAIN : s;
  const parts = windows.map((w) => {
    if (w.pct === null) return `${w.label} ${p.dim("—")}`;
    const tone = state === "readable" ? usageTone(w.pct) : null;
    const pct =
      tone === "bad" ? s.red(`${w.pct}%`) : tone === "warn" ? s.yellow(`${w.pct}%`) : `${w.pct}%`;
    if (!options.resets || state !== "readable" || w.resetAtMs === null) return `${w.label} ${pct}`;
    const reset =
      w.kind === "fiveHour"
        ? `resets ${formatWallClock(w.resetAtMs, display)}`
        : `resets in ${formatRemainingLong(w.resetAtMs - now)}`;
    return `${w.label} ${pct} ${p.dim(`(${reset})`)}`;
  });
  const text = parts.join(" · ");
  return state === "stale" ? s.dim(`${text} · ${STALE}`) : text;
}
