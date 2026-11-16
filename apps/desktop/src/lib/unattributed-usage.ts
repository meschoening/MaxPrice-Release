import {
  formatCost,
  organizationLabel,
  SCOPE_ALL,
  ymdShift,
  type CostMode,
  type ReportQueryInput,
  type SessionRow,
} from "@maxprice/shared";
import { countSessions } from "./assignment-writes";
import type { ChooserOption } from "./session-assignment";
import { SETTINGS_SECTIONS, settingsSectionId } from "./settings-sections";

// Settings › Unattributed usage (#620 item 4, #639), as pure view logic: the
// query it reads, when it shows, and its head's copy. The section lists the
// sessions whose usage has no Attribution evidence and no Membership
// assertion (`isUnattributed`), which count under their Presumed membership
// (ADR-0137 §4), and Assign writes a Membership assertion (§5).

// Where the section sits: Settings, at its anchor.
export const UNATTRIBUTED_USAGE_PATH = `/settings#${settingsSectionId(SETTINGS_SECTIONS.unattributedUsage)}`;

// The Gateways subsection's anchor (ADR-0141 §8), where the hint's Connect a
// Gateway goes unless the page hands the section a nearer way to open it.
export const GATEWAYS_SECTION_PATH = `/settings#${settingsSectionId(SETTINGS_SECTIONS.gateways)}`;

// The section's own `/api/sessions` input, independent of the rail: the last
// 30 days in the Settings timezone (today and the 29 before it, the rail's
// `30d`), no project, model or machine filter, under a Scope holding every
// tracked Membership and the rows whose Account is not known
// (`account=all&organization=all`: ADR-0136 §6, the Account axis any and
// Unknown held). A presumed row counts under its Presumed membership's
// Organization with its Account not known (ADR-0137 §4's current rule), so it
// is in that Scope whenever its Organization is tracked.
export function unattributedSessionsInput({
  tz,
  mode,
  now,
}: {
  tz: string | undefined;
  mode: CostMode;
  now?: number;
}): ReportQueryInput {
  return {
    since: ymdShift(-29, tz, now),
    until: ymdShift(0, tz, now),
    mode,
    tz,
    account: [SCOPE_ALL],
    organization: [SCOPE_ALL],
  };
}

// Whether the section shows: while it lists a session (#672, answering
// #639's question 2: "Show when above zero"), however many Memberships there
// are to assign to, and over a failed read, which says why it lists none.
// With one Membership, Assign names it and so the session's Account, which a
// presumed session's count never does (ADR-0137 §4's current rule).
export function unattributedShown(rows: readonly unknown[] | undefined, failed: boolean): boolean {
  return failed || (rows !== undefined && rows.length > 0);
}

// The head's pill: "‹N› sessions · $‹X›" over the listed sessions.
export function unattributedPill(rows: readonly Pick<SessionRow, "totalCost">[]): string {
  const cost = rows.reduce((total, row) => total + row.totalCost, 0);
  return `${countSessions(rows.length)} · ${formatCost(cost)}`;
}

// The description, naming this machine's Home membership (its label, or null
// with no Home membership here).
export function unattributedDescription(homeLabel: string | null): string {
  const here = homeLabel === null ? "" : ` (⌂ ${homeLabel} on this one)`;
  return `Sessions with no evidence of their Account or Organization and no assignment, last 30 days. Each counts under its Presumed membership, the Home membership of the machine it ran on${here}, until you assign it to a Membership; the assignment follows the session to every machine.`;
}

// The Home membership's label for the description: its option's
// ("‹Organization› · ‹Account›"), else, with its Account not known or not
// offered, the Home organization's alone; null with no Home membership.
export function homeMembershipLabel(
  options: readonly Pick<ChooserOption, "isHome" | "label">[],
  homeOrganization: string | null,
  labels: ReadonlyMap<string, string>,
): string | null {
  const home = options.find((option) => option.isHome);
  if (home !== undefined) return home.label;
  return homeOrganization === null ? null : organizationLabel(labels, homeOrganization);
}

// ADR-0141 §4: any listed session carries the Gateway signature (no Login
// record, no Email record, no `requestId`), so the section suggests Connect a
// Gateway. A hint only: it changes no attribution.
export function showsGatewayHint(rows: readonly Pick<SessionRow, "gatewaySignature">[]): boolean {
  return rows.some((row) => row.gatewaySignature === true);
}
