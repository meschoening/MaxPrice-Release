import { z } from "zod";

// GET /api/organizations — every Organization (CONTEXT.md) this machine knows
// about, for Settings' Home organization select (ADR-0098). UUIDs and plan
// words only: the upstream `name` of a personal org embeds the user's email
// address, so it is never carried, and no count of hidden usage rides here —
// the app must not acknowledge that usage outside the home exists.
export const ORGANIZATIONS_PATH = "/api/organizations";

export const organizationEntrySchema = z.object({
  uuid: z.string().min(1),
  label: z.string().min(1),
  // Whether Claude Code's login file names this organization RIGHT NOW. Display
  // only — the home is never read live from that file (CONTEXT.md).
  currentLogin: z.boolean(),
});
export type OrganizationEntry = z.infer<typeof organizationEntrySchema>;

export const organizationsResponseSchema = z.object({
  // The organization the engine is showing: the persisted setting, else the
  // first-launch corpus seed (most sessions; boot login breaks ties or is the
  // fallback when none name an organization), else null (nothing excluded).
  home: z.string().nullable(),
  currentLogin: z.string().nullable(),
  // The org id the usage-limits credential tracks (ADR-0023); null when
  // disconnected. Lets the connection status name what it is polling.
  trackedLimits: z.string().nullable(),
  organizations: z.array(organizationEntrySchema),
});
export type OrganizationsResponse = z.infer<typeof organizationsResponseSchema>;

// Claude Code's `oauthAccount.organizationType` values, as a label. Unknown
// types yield null so the caller falls back to the short id.
const PLAN_LABELS: Readonly<Record<string, string>> = {
  claude_max: "Max plan",
  claude_pro: "Pro plan",
  claude_team: "Team",
  claude_enterprise: "Enterprise",
  claude_free: "Free plan",
};

export function planLabel(organizationType: string | null | undefined): string | null {
  if (organizationType === null || organizationType === undefined) return null;
  return PLAN_LABELS[organizationType] ?? null;
}

// The display label for an organization: its plan word when known, else
// "Organization <first 8 of the uuid>".
export function organizationLabel(
  uuid: string,
  organizationType: string | null | undefined,
): string {
  return planLabel(organizationType) ?? `Organization ${uuid.slice(0, 8)}`;
}
