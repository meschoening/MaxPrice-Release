import { z } from "zod";
import { costModeSchema } from "./cost-mode";
import { hostTimeFormat, timeFormatSchema } from "./time-format";
import { DEFAULT_WEEK, weekSettingSchema } from "./week";

// Settings (GLOSSARY.md): durable user config, persisted as settings.json in
// the OS app-data dir. Distinct from ephemeral filter-rail/chart state.
// `timezone` and `costMode` travel to the engine as `tz`/`mode` query params,
// and `scope` as the Scope's `account`, `organization` and `membership` params
// (#637). The sidecar reads the file
// directly, at boot and on every watch event: `claudePaths` (ADR-0014; an
// absent key falls through to `$CLAUDE_CONFIG_DIR`, ADR-0122 §5),
// `hubShareEvents` and `hubFleetReplica` (ADR-0041), `homeMemberships` and
// `trackedOrganizations` (ADR-0098, ADR-0136 §5) and `trackedAccounts`
// (ADR-0136 §3, §8); `scope` only for the status's usage
// connection; and `hubUrl` at boot only.
//
// The Home membership replaced v0.9.2's `homeOrganization` (#631). A file
// that still carries `homeOrganization: X` and no Anthropic Home membership
// reads as `homeMemberships.anthropic = { organizationUuid: X, accountUuid:
// null }`, and the parse drops the old key, so whatever a writer writes back
// from a parsed Settings carries only the new one. That is on-disk data, not
// a wire shim: a v0.9.2 settings.json is read once this way and rewritten by
// its next write.
// `timeFormat` travels nowhere — it is renderer-only (ADR-0060).

// Default Claude data paths — the two standard locations, kept literal and
// unfiltered so a fresh machine still has roots to watch (ADR-0014).
export const DEFAULT_CLAUDE_PATHS = ["~/.config/claude/projects", "~/.claude/projects"] as const;

// One Home membership (ADR-0136 §5, ADR-0139 §6): an Organization uuid and the
// Account uuid that holds it there, or null when that Account is not known.
// An empty or missing Organization is no membership (`homeMemberships` below
// catches it to absent); an empty or wrong-typed Account is not known.
export const homeMembershipSchema = z.object({
  organizationUuid: z.string().min(1),
  accountUuid: z.string().min(1).nullable().default(null).catch(null),
});

export type HomeMembership = z.infer<typeof homeMembershipSchema>;

// A hand-edited settings.json can carry a syntactically-valid string that is
// not a real IANA zone (e.g. "Not/AZone"). Such a value clears z.string() and
// the type-only `.catch()` below, then reaches `new Intl.DateTimeFormat({
// timeZone })` on the renderer's hot path (msSinceLocalMidnight, ymdShift) and
// in the engine's `tz` query param, where it throws a synchronous RangeError.
// There is no React error boundary in apps/desktop, so that throw crashes the
// Live chart render. Probe the zone here so an invalid one degrades to the host
// default at the schema boundary and never escapes. (try/catch probe rather
// than `Intl.supportedValuesOf("timeZone")` so we don't depend on its runtime
// availability.)
function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// The persisted Scope (#637): the raw tokens of the Scope's query grammar
// (`./scope`), one list per repeated param: `account` (an Account key, `home`
// or `all`), `organization` (an Organization uuid, `home` or `all`) and
// `membership` (`formatMembershipToken`'s, `MEMBERSHIP_NONE` for an empty
// selection). Each list is kept as written, never resolved: a stale token is
// the sidecar's to answer (an explicit Account it no longer tracks is an empty
// Scope, #635). Each degrades on its own: a list of the wrong type is absent,
// an empty `account` or `organization` token names nothing and is dropped
// (`membership`'s empty token is `MEMBERSHIP_NONE`, so it is kept), and an
// object naming nothing is the default Scope, `null`, which is also every
// non-object value's reading.
const scopeListSchema = z.array(z.string()).optional().catch(undefined);

// Each key is named for its query param, singular as the param is (`account=`,
// `organization=`, `membership=`), not for the resolved Scope's plural axes
// (`ResolvedScope`'s `accounts`, `organizations`, `memberships`) or the
// report input's (`ReportQueryInput`'s `memberships`): `membership` here is
// the repeated `membership` param's tokens, which resolve to `memberships`.
export type ScopeSetting = {
  account?: string[];
  organization?: string[];
  membership?: string[];
};

export const scopeSettingSchema = z
  .object({
    account: scopeListSchema,
    organization: scopeListSchema,
    membership: scopeListSchema,
  })
  .nullable()
  .transform((value): ScopeSetting | null => {
    if (value === null) return null;
    const out: ScopeSetting = {};
    const account = value.account?.filter((token) => token !== "");
    const organization = value.organization?.filter((token) => token !== "");
    if (account !== undefined && account.length > 0) out.account = account;
    if (organization !== undefined && organization.length > 0) out.organization = organization;
    if (value.membership !== undefined && value.membership.length > 0) {
      out.membership = value.membership;
    }
    return Object.keys(out).length === 0 ? null : out;
  });

// Whether two persisted Scopes are the same Scope as written: each list equal
// token for token, in order, an absent list equal only to an absent one. A
// list's order is kept as written, so a reordered list is a different value
// (a change a reader re-applies, never a missed one).
export function scopeSettingsEqual(a: ScopeSetting | null, b: ScopeSetting | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    sameTokens(a.account, b.account) &&
    sameTokens(a.organization, b.organization) &&
    sameTokens(a.membership, b.membership)
  );
}

function sameTokens(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.length === b.length && a.every((token, i) => token === b[i]);
}

// Per-field `.catch()` mirrors each `.default()`: a present-but-wrong-typed or
// out-of-enum field degrades to its own default while valid siblings survive,
// instead of one bad field wiping the whole object (which the renderer's
// sole-writer round-trip would then persist permanently). `.passthrough()`
// keeps unknown keys written by a newer app version through a read/edit/write
// round-trip on an older binary, so a downgrade doesn't erase future fields.
// The object alone, before `settingsSchema`'s legacy read: its `shape` is each
// field's own schema, which the Headless client validates a write against.
export const settingsObjectSchema = z
  .object({
    claudePaths: z
      .array(z.string())
      .default([...DEFAULT_CLAUDE_PATHS])
      .catch([...DEFAULT_CLAUDE_PATHS]),
    timezone: z
      .string()
      // Valid IANA zone → kept; bad zone string → degraded to the host default
      // (see isValidTimeZone above). `.default` covers a missing field and
      // `.catch` a non-string; this transform closes the bad-zone-string gap.
      .transform((tz) =>
        isValidTimeZone(tz) ? tz : new Intl.DateTimeFormat().resolvedOptions().timeZone,
      )
      .default(() => new Intl.DateTimeFormat().resolvedOptions().timeZone)
      .catch(() => new Intl.DateTimeFormat().resolvedOptions().timeZone),
    costMode: costModeSchema.default("auto").catch("auto"),
    // How clock times are RENDERED (ADR-0060) — distinct from `timezone`, which
    // decides which day an event buckets into. Derived from the host's hour
    // cycle, so a fresh US machine reads AM/PM and a fresh European one reads
    // 24h without anyone visiting Settings.
    //
    // "Seeded once" is exact only for a FRESH install: `fetchSettings` seeds and
    // WRITES solely when `read_settings` returns a literally empty object; every
    // other input is parsed without a write. So on a settings.json written
    // before this field existed, the default below re-derives from
    // `hostTimeFormat()` on EVERY launch until any setting is written (which
    // persists the resolved value permanently). `timezone` never had that
    // exposure — it shipped before v0.1.0, so every settings.json on disk
    // already carries one — and the other post-ship additions default to
    // constants, which cannot drift. Accepted, not fixed: see ADR-0060
    // decision 6.
    //
    // Renderer-only: it is NOT a query param and NOT part of any query key, so
    // flipping it re-renders every clock without refetching a byte. It must
    // never reach the engine's `tz-clock` formatter, which is h23-pinned because
    // `localDate` buckets every daily total through it.
    timeFormat: timeFormatSchema.default(hostTimeFormat).catch(hostTimeFormat),
    // The Week (ADR-0083): what "this week" means — rolling 7 days (the
    // original behaviour), the weekly-limit reset window, or a custom
    // weekday + time in `timezone`. Client-only: the sidecar never reads it;
    // the renderer and the Headless client's reports resolve instants and
    // pass them on the wire.
    week: weekSettingSchema.default(DEFAULT_WEEK).catch(DEFAULT_WEEK),
    // Whether the user has collapsed the sidebar to its 64px icon rail
    // (map #151 / T11, ADR-0073). Renderer-only, like `timeFormat`: it reaches
    // no endpoint and no query key.
    //
    // This is only ONE HALF of what the sidebar draws. The rule is "collapsed =
    // the user collapsed it OR the window is too narrow", and the second half is
    // a container query on `frame` that no field can see — so `false` here means
    // "the user has not asked for the rail", never "the sidebar is expanded".
    // Expanding below that threshold is a transient flyout and deliberately does
    // NOT write this field.
    sidebarCollapsed: z.boolean().default(false).catch(false),
    // The hub base URL (e.g. "http://my-desktop.tailnet-name.ts.net:47100"),
    // empty = no hub (ADR-0035). The optional hub PASSWORD (ADR-0037)
    // deliberately does not live here — settings.json is plaintext and
    // export-able; the password goes to the OS keychain beside the usage
    // credential (ADR-0023's posture).
    hubUrl: z.string().default("").catch(""),
    // Auto-heal toggle (ADR-0035): push this machine's Claude credential to a
    // hub whose own key died. Default on; off keeps this machine's key local.
    hubAutoHeal: z.boolean().default(true).catch(true),
    // Fleet event sync toggles (ADR-0041). Flat, hub-prefixed, both default ON
    // because configuring the hub is the opt-in (hubUrl empty ⇒ both inert —
    // the hubAutoHeal precedent). Consumed by the sidecar via the ADR-0015
    // settings watch — in-session apply, no relaunch:
    //   hubShareEvents  — gates every event push trigger (share-off retracts
    //                     nothing; the protocol is tombstone-free).
    //   hubFleetReplica — gates the pull loop, hub:events pokes, and
    //                     fleet-events.jsonl (off = unlink + in-session engine
    //                     rebuild; re-toggling on is an ordinary reseed).
    hubShareEvents: z.boolean().default(true).catch(true),
    hubFleetReplica: z.boolean().default(true).catch(true),
    // Background residency (map #168 / M1): closing the main window hides it
    // and keeps the app + sidecar alive; OFF restores close-means-quit.
    // Governs the CLOSE BUTTON only — quitting (tray Quit, macOS Cmd+Q) always
    // exits. Default ON per the map's charter. The Rust shell reads this field
    // straight out of settings.json at close time (it cannot run Zod), with
    // the same absent/non-bool → true semantics — keep the two in lockstep.
    keepRunningInBackground: z.boolean().default(true).catch(true),
    // Whether the tray popout draws the Model-scoped weekly limit row
    // (GLOSSARY.md) — default OFF, an opt-in for the one account shape that
    // reports one. Two gates AND together: this field and the sample actually
    // carrying the window (the Settings switch itself only renders while it
    // does). The Rust shell reads this field straight out of settings.json to
    // size the popout before showing it (`model_limit_row_enabled`, the
    // `keepRunningInBackground` precedent) — absent/non-bool → false; keep the
    // two in lockstep. Popout only: the Live page and the readout ignore it.
    showModelLimit: z.boolean().default(false).catch(false),
    // The Home membership per Provider (GLOSSARY.md, ADR-0136 §5; the shape is
    // ADR-0139 §6's Machine directory field): the default Scope and the
    // presumption for that Provider's owner-less usage. Its Organization is
    // what ADR-0098 called the Home organization, and `homeOrganizationOf`
    // reads it. No `anthropic` entry = not chosen yet: the sidecar then uses
    // the Organization its boot walk seeded, and the renderer persists that
    // value on first launch so a later `/login` elsewhere can never silently
    // move the home. `accountUuid: null` is a Home whose Account is not known
    // (ADR-0136 §8). Consumed by the sidecar via the settings watch
    // (in-session engine rebuild, no relaunch). An empty string is not a
    // uuid: an empty Organization is no membership, an empty Account is
    // `null`. Passthrough, so a later Provider's entry survives an older
    // binary's round-trip. The legacy `homeOrganization` is read by the
    // transform below.
    homeMemberships: z
      .object({ anthropic: homeMembershipSchema.optional().catch(undefined) })
      .passthrough()
      .default({})
      .catch({}),
    // The tracked set (the #260 lifecycle decision, item 1): the Organizations
    // whose usage THIS machine counts, beyond the Home organization —
    // generalising ADR-0098's single Home organization (#275; #299 is the
    // slice that records it in the ADR). The sidecar reads this as the list
    // UNION {Home} on every settings read, so Home is always tracked and a
    // hand-edited file cannot exclude it; an absent or empty list is therefore
    // exactly {Home} and an upgraded machine runs today's engine with no
    // migration. uuids, order insignificant, duplicates and empty strings
    // dropped by the sidecar's resolver (`resolveTrackedOrganizations`) rather
    // than here, so one junk member cannot wipe the user's whole list.
    trackedOrganizations: z.array(z.string()).default([]).catch([]),
    // The tracked Accounts (ADR-0136 §3): the Accounts whose usage THIS
    // machine counts, each an account uuid or `pending:<sha256-hex>` (a
    // Pending account). The sidecar reads this as the list UNION the Home
    // membership's Account (`resolveTrackedAccounts`), so Home's Account is
    // always tracked. `null` means the key is ABSENT, and absent is
    // meaningful (#631, decision 2): the file predates Accounts, so the
    // sidecar derives ADR-0136 §8's upgrade set and announces it as a seed for
    // the host to persist. It is therefore not `[]`, which tracks only the
    // Home membership's Account. A JSON `null` reads as absent too (the
    // Desktop renderer writes its whole parsed Settings back, so an absent key
    // round-trips as `null`), and so does a value of the wrong type: a typo
    // must not narrow the set and start a repair.
    trackedAccounts: z.array(z.string()).nullable().default(null).catch(null),
    // The Scope (GLOSSARY.md, ADR-0136 §6, #637): the Memberships every report
    // describes, persisted as the raw tokens the sidecar's query grammar takes
    // (`scopeSettingSchema`), or `null` for the default Scope, the Home
    // membership, which sends no Scope param at all. Renderer-owned
    // (ADR-0014): every reader passes the tokens through as repeated
    // `account`, `organization` and `membership` params (`scopeQueryParams`),
    // and only the sidecar resolves them (`resolveScope`), so a stale token
    // answers alike wherever it is read. The sidecar reads it from the file
    // only for the status's usage connection. Optional here so the legacy read
    // below can tell an absent key from a junk one, which reads as `null`.
    scope: scopeSettingSchema.optional().catch(null),
  })
  .passthrough();

// A v0.9.2 file's Home organization, as that version's schema took it; and a
// v0.9.x file's Organization scope, a uuid or "all" (#278).
const legacyHomeOrganizationSchema = z.string().min(1);
const legacyOrganizationScopeSchema = z.string().min(1);

// The settings.json reading every reader shares: the plain fields, then the
// two legacy keys folded into their successors and dropped, so whatever a
// writer writes back from a parsed Settings carries only the new ones:
//   - `homeOrganization` into the Home membership (#631). A valid Anthropic
//     Home membership wins over the legacy key; a legacy value that is not a
//     non-empty string is no Home, as it was.
//   - `organizationScope: X` into `scope: { organization: [X] }` (#637), the
//     same Organization axis the v0.9.x renderer sent as `organization=X`,
//     when the file has no `scope` key at all. A `scope` key, even a junk one
//     (which reads as `null`), wins; a legacy value that is not a non-empty
//     string is the default Scope, as it was. The value is passed through
//     unresolved, as every `scope` is: a stale uuid is the sidecar's to
//     answer.
// That is on-disk data, not a wire shim: a released file is read once this way
// and rewritten by its next write.
export const settingsSchema = settingsObjectSchema.transform(
  ({ homeOrganization: legacyHome, organizationScope: legacyScope, scope, ...rest }) => {
    const organization = legacyOrganizationScopeSchema.safeParse(legacyScope);
    const settings = {
      ...rest,
      scope:
        scope !== undefined
          ? scope
          : organization.success
            ? { organization: [organization.data] }
            : null,
    };
    if (settings.homeMemberships.anthropic !== undefined) return settings;
    const home = legacyHomeOrganizationSchema.safeParse(legacyHome);
    if (!home.success) return settings;
    return {
      ...settings,
      homeMemberships: {
        ...settings.homeMemberships,
        anthropic: { organizationUuid: home.data, accountUuid: null },
      },
    };
  },
);

export type Settings = z.infer<typeof settingsSchema>;

// The Providers a Home membership is kept for. Anthropic alone today.
export type HomeProvider = "anthropic";

// The Home membership for `provider`, or null when none is chosen.
export function homeMembershipOf(
  settings: Pick<Settings, "homeMemberships">,
  provider: HomeProvider = "anthropic",
): HomeMembership | null {
  return settings.homeMemberships[provider] ?? null;
}

// The Home membership's Organization: ADR-0098's Home organization, or null
// when no Home membership is chosen.
export function homeOrganizationOf(settings: Pick<Settings, "homeMemberships">): string | null {
  return homeMembershipOf(settings)?.organizationUuid ?? null;
}

// The Home memberships with `organizationUuid` as the Anthropic Home
// membership's Organization: the Account it already names is kept (none when
// there was no Home), and every other Provider's entry is left as it is. What
// each Home write sets: the first-launch seed, the Home select and `Make
// Home` (`makeHomePatch`).
export function withHomeOrganization(
  settings: Pick<Settings, "homeMemberships">,
  organizationUuid: string,
): Settings["homeMemberships"] {
  const accountUuid = homeMembershipOf(settings)?.accountUuid ?? null;
  return { ...settings.homeMemberships, anthropic: { organizationUuid, accountUuid } };
}

export const DEFAULT_SETTINGS: Settings = settingsSchema.parse({});

// Parse an untrusted value (file contents, IPC payload) into Settings. The
// per-field `.catch()` above recovers individual bad fields in-place, so the
// wholesale fallback here only fires for non-object input (`null`, a string,
// etc.) that can't carry any recoverable fields at all. Nothing is resolved
// here: the Scope's tokens are the sidecar's to resolve (#637).
export function parseSettings(value: unknown): Settings {
  const result = settingsSchema.safeParse(value);
  return result.success ? result.data : DEFAULT_SETTINGS;
}
