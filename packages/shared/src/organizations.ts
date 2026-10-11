import { z } from "zod";
import {
  orgLimitsAnswerSchema,
  windowStatesSchema,
  type OrganizationRosterHints,
} from "./usage-limits";

// GET /api/organizations — the Settings roster (#287): every Organization
// (GLOSSARY.md) this machine knows about, each with its Organization label as
// `resolveOrganizationLabel` below resolves it and the facts Settings shows
// beside it; the Home organization select (ADR-0098) is one of its readers.
// PUT /api/organizations/:uuid renames one. UUIDs, labels and plan words only:
// the upstream `name` of an Organization can embed the user's email address,
// so it is never carried (ADR-0098 §6), and no count of hidden usage rides
// here — the app must not acknowledge that usage outside the home exists.
export const ORGANIZATIONS_PATH = "/api/organizations";

// PUT target for one Organization's rename.
export function organizationPath(uuid: string): string {
  return `${ORGANIZATIONS_PATH}/${encodeURIComponent(uuid)}`;
}

// The Limits answer (GLOSSARY.md) the roster shows for an Organization.
export const organizationLimitsSchema = z.object({
  answer: orgLimitsAnswerSchema,
  // What the last successful poll said about each primary window (#384): the
  // per-window fact a "no limit" surface reads. null for a Connect seed, which
  // records the answer alone, and before any successful read.
  windowStates: windowStatesSchema.nullable(),
  // "poll": this machine's poller (or the Hub's map it mirrors) answered;
  // "connect": the roster's seed from the last Connect discovery ("(at connect)").
  source: z.enum(["poll", "connect"]),
  lastReadAt: z.string().nullable(),
  lastSampleAt: z.string().nullable(),
});
export type OrganizationLimits = z.infer<typeof organizationLimitsSchema>;

export const organizationEntrySchema = z.object({
  uuid: z.string().min(1),
  // Resolved, WITHOUT any collision suffix — `displayOrganizationLabels` adds
  // that at render time.
  label: z.string().min(1),
  // Whether `label` is the user's rename.
  renamed: z.boolean(),
  // The plan word, reported even when a rename hides it from `label`.
  plan: z.string().nullable(),
  // Whether some watched root's login file names this Organization RIGHT NOW;
  // several can at once. Display only — the home is never read live from those
  // files (GLOSSARY.md).
  currentLogin: z.boolean(),
  // In the resolved tracked set (a null set excludes nothing, so every row).
  tracked: z.boolean(),
  // null: nothing has answered for it.
  limits: organizationLimitsSchema.nullable(),
  // Where this machine learned of it: usage walked, archived or replicated from
  // this machine, or a current login (`machine`); another machine's replicated
  // usage (`fleet`); Connect's discovery listing it for the key (`account`).
  seenOn: z.object({ machine: z.boolean(), fleet: z.boolean(), account: z.boolean() }),
  // When this machine's registry first recorded it (ISO). null for one recorded
  // before first-seen times were kept; a deleted registry loses the time, and
  // the Organization is re-stamped when next seen.
  firstSeenAt: z.string().nullable(),
  // A settings edit is re-walking its usage into the engine right now (#276).
  reingesting: z.boolean(),
});
export type OrganizationEntry = z.infer<typeof organizationEntrySchema>;

export const organizationsResponseSchema = z.object({
  // The organization the engine is showing: the persisted setting, else the
  // first-launch corpus seed (most sessions; boot login breaks ties or is the
  // fallback when none name an organization), else null (nothing excluded).
  home: z.string().nullable(),
  // Whether Claude Code attaches Remote Control to every interactive session
  // on this machine (ADR-0101) — the setting that makes each one write an
  // Owner record. Settings hints when false. Setup guidance only: no count and
  // no mention of hidden usage rides with it.
  remoteControlAtStartup: z.boolean(),
  organizations: z.array(organizationEntrySchema),
});
export type OrganizationsResponse = z.infer<typeof organizationsResponseSchema>;

// PUT /api/organizations/:uuid body: the new label, or null to clear the rename
// back to the resolved default. The sidecar trims and checks it
// (`checkOrganizationLabel`) and refuses one another Organization already uses.
export const organizationRenameRequestSchema = z.object({ label: z.string().nullable() });
export type OrganizationRenameRequest = z.infer<typeof organizationRenameRequestSchema>;

// Claude Code's `oauthAccount.organizationType` values, as a label. Unknown
// types yield null so the caller falls back to the short id.
const PLAN_LABELS: Readonly<Record<string, string>> = {
  claude_max: "Max plan",
  claude_pro: "Pro plan",
  claude_team: "Team",
  claude_enterprise: "Enterprise",
  claude_free: "Free plan",
};

// An own key only: "toString" and the other prototype names are not plan words.
export function planLabel(organizationType: string | null | undefined): string | null {
  if (organizationType === null || organizationType === undefined) return null;
  if (!Object.hasOwn(PLAN_LABELS, organizationType)) return null;
  return PLAN_LABELS[organizationType] ?? null;
}

// Connect's roster hints (usage-limits.ts) as a plan word, for an Organization
// no login file names. First match wins, and the table is total: every rule
// yields one of its own fixed words and anything unrecognised yields null, so
// no hint value ever becomes a label raw — `analyticsSubscriptionPlan` is not
// uniformly token-shaped (docs/research/organization-limits-probe). The
// capabilities read are `SUBSCRIPTION_CAPS`'s vocabulary (usage-limits.ts)
// plus `raven_enterprise` and `api`. `billingType` maps nothing:
// `stripe_subscription*` names no plan. Nor is the Limits answer a hint:
// `forbidden` is also what a readable Organization answers to a key that
// cannot read it, so it names no plan either.
export function planFromHints(hints: OrganizationRosterHints | null | undefined): string | null {
  if (hints === null || hints === undefined) return null;
  // Exactly a PLAN_LABELS key, never a prefix or a case-fold.
  const analytics = planLabel(hints.analyticsSubscriptionPlan);
  if (analytics !== null) return analytics;
  if (hints.ravenType === "enterprise") return "Enterprise";
  const caps = hints.capabilities;
  if (caps.includes("claude_max")) return "Max plan";
  if (caps.includes("claude_pro")) return "Pro plan";
  if (caps.includes("raven_enterprise")) return "Enterprise";
  const tier = hints.rateLimitTier;
  if (tier !== null && tier.startsWith("default_claude_max")) return "Max plan";
  if (tier === "default_raven_enterprise") return "Enterprise";
  if (caps.includes("api") && !caps.includes("chat")) return "API";
  return null;
}

// An Organization's plan word: a login file's `organizationType` always beats
// a roster hint.
export function organizationPlan(input: {
  organizationType: string | null | undefined;
  hints: OrganizationRosterHints | null | undefined;
}): string | null {
  return planLabel(input.organizationType) ?? planFromHints(input.hints);
}

// The Organization label (GLOSSARY.md): the user's rename, else the plan word,
// else "Organization <first 8 of the uuid>" — never the upstream `name`.
// `plan` is reported beside a rename, which hides it from the label.
export type ResolvedOrganizationLabel = { label: string; renamed: boolean; plan: string | null };

export function resolveOrganizationLabel(input: {
  uuid: string;
  rename: string | null; // the user's label, null when none or cleared
  organizationType: string | null | undefined;
  hints: OrganizationRosterHints | null | undefined;
}): ResolvedOrganizationLabel {
  const plan = organizationPlan(input);
  return {
    label: input.rename ?? plan ?? `Organization ${input.uuid.slice(0, 8)}`,
    renamed: input.rename !== null,
    plan,
  };
}

// uuid → the label to render. Labels that match case-insensitively (two
// Organizations on one plan word, say) ALL carry their first 8 of the uuid;
// every other label renders unchanged. Render time only — nothing is stored.
export function displayOrganizationLabels(
  entries: ReadonlyArray<{ uuid: string; label: string }>,
): Map<string, string> {
  const counts = new Map<string, number>();
  for (const { label } of entries) {
    const key = label.toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return new Map(
    entries.map(({ uuid, label }) => [
      uuid,
      (counts.get(label.toLowerCase()) ?? 0) > 1 ? `${label} · ${uuid.slice(0, 8)}` : label,
    ]),
  );
}

// The rename limits: trimmed, 1 to 40 code points (not UTF-16 units, so an
// emoji counts once). Uniqueness needs a roster, so it belongs to whichever
// machine edits (ADR-0105 §8): the sidecar's rename checks it against its own
// roster, the Hub's PUT against its roster and its directory.
export const ORGANIZATION_LABEL_MAX = 40;

export type OrganizationLabelCheck =
  | { ok: true; label: string }
  | { ok: false; reason: "empty" | "too-long" };

export function checkOrganizationLabel(raw: string): OrganizationLabelCheck {
  const label = raw.trim();
  const length = Array.from(label).length;
  if (length === 0) return { ok: false, reason: "empty" };
  if (length > ORGANIZATION_LABEL_MAX) return { ok: false, reason: "too-long" };
  return { ok: true, label };
}

// An edit's time as every user-authored directory stamps it — the label
// entry's (#288) and the assertion entry's (#310): exactly toISOString()'s
// shape, so string order is time order (./newest-wins.ts).
export const editedAtSchema = z.string().datetime({ precision: 3 });

// One entry of the user's renames, as held by organization-labels.json, the
// Hub's Organization directory and the wire between them (#288): a label the
// rename rules accept unchanged, or null for a cleared one (a tombstone). The
// `editedAt` shape is exactly toISOString()'s, so newest-wins can compare
// strings (./newest-wins.ts). A key is an organization uuid (opaque; 1–64).
export const organizationLabelEntrySchema = z.object({
  label: z
    .string()
    .refine((label) => {
      const check = checkOrganizationLabel(label);
      return check.ok && check.label === label;
    }, "not a label a rename could write")
    .nullable(),
  editedAt: editedAtSchema,
});
export type OrganizationLabelEntry = z.infer<typeof organizationLabelEntrySchema>;
export const organizationUuidKeySchema = z.string().min(1).max(64);

// ── Organization assertions (#310, ADR-0107 §11) ──

// A session id as an Organization assertion keys it: opaque, non-empty and
// bounded. Real ids are Claude Code's session UUIDs (36 characters); fixtures
// use `sess-…`. Nothing checks that the session exists anywhere: archive-only
// history and other machines' sessions are legitimate targets (#306 item 6).
export const SESSION_ID_KEY_MAX = 128;
export const sessionIdKeySchema = z.string().min(1).max(SESSION_ID_KEY_MAX);

// One Organization assertion, as held by organization-assertions.json, the
// Hub's Organization assertion directory and the wire between them: the
// Organization a session's owner-less usage is claimed for, or null for a
// cleared claim — a tombstone, so an older copy can never resurrect it.
export const organizationAssertionEntrySchema = z.object({
  organizationUuid: organizationUuidKeySchema.nullable(),
  editedAt: editedAtSchema,
});
export type OrganizationAssertionEntry = z.infer<typeof organizationAssertionEntrySchema>;

// Bounds the fleet's union of assertions, tombstones included — a count of
// SESSIONS, not of Organizations. At the cap the compact file, like a push, is
// ~2.7 MB when every id is a 36-character UUID (137 bytes a live entry) and
// ~5.1 MB when every key is at its schema limit (257 bytes an entry). The
// Hub refuses (409) a push whose merged union would pass it, and a local set
// that would grow the file past it is refused whole, so every answer fits the
// wire's cap. Declared here rather than in ./hub.ts because the sidecar's PUT
// body below is bounded by it too, and ./hub.ts imports this module.
export const ORGANIZATION_ASSERTION_DIRECTORY_MAX = 20_000;

// GET /api/organization-assertions — this machine's resolved claims: live
// entries only, no tombstones, no edit times. PUT sets or clears claims in bulk.
export const ORGANIZATION_ASSERTIONS_PATH = "/api/organization-assertions";

export const organizationAssertionsResponseSchema = z.object({
  assertions: z.record(sessionIdKeySchema, organizationUuidKeySchema),
});
export type OrganizationAssertionsResponse = z.infer<typeof organizationAssertionsResponseSchema>;

// PUT body: claim every listed session for `organizationUuid`, or clear each
// one's claim (`null`). Duplicates are allowed and collapse to one.
export const organizationAssertRequestSchema = z.object({
  sessionIds: z.array(sessionIdKeySchema).min(1).max(ORGANIZATION_ASSERTION_DIRECTORY_MAX),
  organizationUuid: organizationUuidKeySchema.nullable(),
});
export type OrganizationAssertRequest = z.infer<typeof organizationAssertRequestSchema>;

// PUT 200 body: how many sessions' entries the request wrote — 0 when every
// session already held that claim (or, clearing, held none).
export const organizationAssertResponseSchema = z.object({
  changed: z.number().int().nonnegative(),
});
export type OrganizationAssertResponse = z.infer<typeof organizationAssertResponseSchema>;
