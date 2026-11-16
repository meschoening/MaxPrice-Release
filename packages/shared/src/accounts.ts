import { z } from "zod";
import { editedAtSchema } from "./newest-wins";
import {
  membershipReadabilitySchema,
  orgLimitsAnswerSchema,
  usageConnectionSchema,
  usageReadingSchema,
} from "./usage-limits";

// ── Accounts (ADR-0136 §1, §3–§4, §7–§8; ADR-0137 §1) ──
//
// An Account is one login at one Provider, keyed by that Provider's account
// id (Anthropic's account uuid). A Pending account is an Email record's
// address no pair maps yet: this machine keys it by its email hash,
// `pending:<sha256-hex>`, and the hash never leaves the machine (ADR-0137 §1),
// so no wire, Hub, archive or directory shape carries one. The label rules
// and `accountUuidSchema` below are shared with the Hub's Label directory
// (ADR-0139 §7, §10); everything else in this module is the loopback shape
// between the sidecar and its own host.

// What may name an Account's stored key, in a keychain entry's name, a
// secrets.json key or a route's target: the Desktop client's rule for its
// keychain entries (`valid_account_uuid`, a Rust copy), 8 to 64 hex digits
// and dashes. A uuid is checked before it names any of them.
export const ACCOUNT_UUID_PATTERN = /^[0-9a-fA-F-]{8,64}$/;

export function isAccountUuid(value: string): boolean {
  return ACCOUNT_UUID_PATTERN.test(value);
}

// The prefix of a Pending account's key (#631 decision 1): `pending:<hash>`.
export const PENDING_ACCOUNT_PREFIX = "pending:";

// Whether `key` names a Pending account rather than an account uuid.
export function isPendingAccountKey(key: string): boolean {
  return key.startsWith(PENDING_ACCOUNT_PREFIX);
}

// The Pending account key of an email hash: `pending:<hash>`. The one place a
// Pending key is built.
export function pendingAccountKey(emailHash: string): string {
  return `${PENDING_ACCOUNT_PREFIX}${emailHash}`;
}

// The email hash a Pending account key names, or null for an account uuid.
// The one place a Pending key is taken apart.
export function pendingHashOf(key: string): string | null {
  return isPendingAccountKey(key) ? key.slice(PENDING_ACCOUNT_PREFIX.length) : null;
}

// An Account as the fleet's shapes name it (ADR-0139 §6–§7): an account uuid
// by ACCOUNT_UUID_PATTERN, the key of a Label directory account entry, a
// published Home membership's Account and a Membership assertion's. The
// pattern admits no `:` and no `@`, so a Pending key and an email address are
// refused wherever it is the schema, and neither can reach the Hub.
export const accountUuidSchema = z.string().regex(ACCOUNT_UUID_PATTERN);

// ADR-0136 §7's Account label: the user's own label, else the email as read
// on this machine (never on the wire or the Hub), else `Account <first 8>` of
// the key's id, which is the account uuid, or the hash of a Pending account.
export function accountLabel(
  key: string,
  email: string | null,
  userLabel: string | null = null,
): string {
  if (userLabel !== null) return userLabel;
  if (email !== null && email !== "") return email;
  const id = pendingHashOf(key) ?? key;
  return `Account ${id.slice(0, 8)}`;
}

// The words for a Membership whose Account is not known (ADR-0137 §3's note:
// rows whose Account resolves to none, the `accountUuid: null` Membership of
// `/api/blocks`): every surface that names such an Account says this (#635:
// "if unsure what account it came from it should say it's unknown").
export const ACCOUNT_NOT_KNOWN = "Account not known";

// The label rules, one maximum for Account and Organization labels alike
// (ADR-0139 §10): trimmed, 1 to 40 code points (not UTF-16 units, so an
// emoji counts once). Uniqueness needs a roster, so it belongs to whichever
// machine edits (ADR-0105 §8): the sidecar's rename checks it against its own
// roster, the Hub's PUT against its roster and its directory.
export const LABEL_MAX = 40;

export type LabelCheck = { ok: true; label: string } | { ok: false; reason: "empty" | "too-long" };

export function checkLabel(raw: string): LabelCheck {
  const label = raw.trim();
  const length = Array.from(label).length;
  if (length === 0) return { ok: false, reason: "empty" };
  if (length > LABEL_MAX) return { ok: false, reason: "too-long" };
  return { ok: true, label };
}

// The uniqueness half of the label rules (#287, #635), one rule for both
// kinds on both editors: `label` (a `checkLabel`-clean label) is taken when it
// equals, case-insensitively, the resolved label (defaults included) of any
// OTHER entry of its kind the editing machine knows, so renaming one to the
// label it already shows is allowed. `rows` are `[id, resolved label]` pairs:
// the sidecar's Organization or Account roster, or the Hub's Organization rows
// or known Accounts.
export function labelTaken(
  rows: Iterable<readonly [id: string, label: string]>,
  id: string,
  label: string,
): boolean {
  const folded = label.toLowerCase();
  for (const [other, resolved] of rows) {
    if (other !== id && resolved.toLowerCase() === folded) return true;
  }
  return false;
}

// One user-set label, as a local labels file, the Hub's Label directory and
// the wire between them hold it (#288, #635): a label the rename rules accept
// unchanged, or null for a cleared one (a tombstone). The `editedAt` shape is
// exactly toISOString()'s, so newest-wins can compare strings
// (./newest-wins.ts). Keyed by an Organization uuid or an account uuid.
export const labelEntrySchema = z.object({
  label: z
    .string()
    .refine((label) => {
      const check = checkLabel(label);
      return check.ok && check.label === label;
    }, "not a label a rename could write")
    .nullable(),
  editedAt: editedAtSchema,
});
export type LabelEntry = z.infer<typeof labelEntrySchema>;

// The seed the sidecar announces for its host to persist, while settings.json
// names no `trackedAccounts` (#631 decision 2): ADR-0136 §8's upgrade set on a
// machine that already had a Home, or §4's first-launch set (the Home
// membership's Account alone) on one that had none. `homeOrganizationUuid` is
// the Home membership the seed belongs to, so a writer can tell whether the
// Home it would complete is still that one.
export const accountsSeedSchema = z.object({
  homeOrganizationUuid: z.string().min(1),
  homeAccountUuid: z.string().min(1).nullable(),
  trackedAccounts: z.array(z.string().min(1)),
});
export type AccountsSeed = z.infer<typeof accountsSeedSchema>;

// A Pending account a pair has resolved (ADR-0137 §1), as the sidecar decided
// it: `pendingKey` folds into `accountUuid`. `takesPendingState` is true when
// that Account was not known before the fold, so it takes the Pending
// account's tracking state; false when it was, so its own state wins and the
// Pending choice is dropped. The sidecar applies the fold at read time
// (`foldTrackedAccounts`) and announces it so its host writes it once
// (`foldAccountsPatch`, organization-tracking.ts), freezing the decision.
export const pendingFoldSchema = z.object({
  pendingKey: z.string().min(1),
  accountUuid: z.string().min(1),
  takesPendingState: z.boolean(),
});
export type PendingFold = z.infer<typeof pendingFoldSchema>;

// The tracked Account list with every fold applied: a folded Pending key leaves
// it, and its Account joins it when the fold takes the Pending account's state
// (the key was listed, so that state is Tracked). A key the list does not name
// is Excluded, and an Account that takes that state is Excluded too, so it
// adds nothing. The order of the list is kept and nothing is listed twice.
// The one rule for the Desktop renderer's and the Headless client's writes
// and for the sidecar's read-time resolution.
export function foldTrackedAccounts(
  list: readonly string[],
  folds: readonly PendingFold[],
): string[] {
  const byPending = new Map(folds.map((fold) => [fold.pendingKey, fold]));
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (key: string): void => {
    if (seen.has(key)) return;
    seen.add(key);
    out.push(key);
  };
  for (const key of list) {
    const fold = byPending.get(key);
    if (fold === undefined) push(key);
    else if (fold.takesPendingState) push(fold.accountUuid);
  }
  return out;
}

// One Membership an Account holds, as this machine's evidence or a key's
// listing names it (ADR-0136 §2): its Organization, whether it is the Home
// membership, and its live state (ADR-0138 §8, #633). `limits` is its last
// Limits answer (null before any, or with no key reading it); `readability`
// is `membershipReadability` of its Account's connection and those limits;
// `stale` that its key expired and `current` is the last reading, kept;
// `current` its last reading (null: none held); `lastReadAt` its last
// successful read.
export const accountMembershipSchema = z.object({
  organizationUuid: z.string(),
  home: z.boolean(),
  limits: orgLimitsAnswerSchema.nullable(),
  readability: membershipReadabilitySchema.nullable(),
  stale: z.boolean(),
  current: usageReadingSchema.nullable(),
  lastReadAt: z.string().nullable(),
});
export type AccountMembership = z.infer<typeof accountMembershipSchema>;

// One known Account (GET /api/accounts). `key` is the account uuid, or
// `pending:<hash>` for a Pending account, whose `accountUuid` is null.
// `tracked`: inside the resolved tracked Account set (every Account is while
// that set is null, excluding nothing). `home`: the Home membership's Account.
// `email`: the address as read on this machine, live, from a root's login
// file; never stored by the sidecar, so a Pending account (whose address the
// parser hashed) has none. `label`: `accountLabel`. `connection` (#633,
// ADR-0138 §8): its key's, `disconnected` when this machine holds none (a
// Pending account always); on a hub-connected client the Hub's connection for
// the Account its one key heals, and `disconnected` for every other.
export const accountEntrySchema = z.object({
  key: z.string().min(1),
  accountUuid: z.string().min(1).nullable(),
  pending: z.boolean(),
  tracked: z.boolean(),
  home: z.boolean(),
  email: z.string().nullable(),
  label: z.string(),
  connection: usageConnectionSchema,
  memberships: z.array(accountMembershipSchema),
});
export type AccountEntry = z.infer<typeof accountEntrySchema>;

// GET /api/accounts — every Account this machine knows (root logins, the
// evidence its walks read, Excluded rows' included, the tracked list, the
// Home membership's Account, the pair table and every held key), plus what the
// host persists: `seed` while settings.json names no `trackedAccounts`, and
// `folds` while it still names a folded Pending key. `staleOrganizations`
// (ADR-0138 §8): the Organizations whose shown reading is stale, as the poller
// decides it from the keys that actually read each (an expired key's
// exclusive ones; the legacy key counts, evidence-only Memberships do not),
// sorted; empty while hub-connected, where the Hub owns live state.
// `expiredReaderOrganizations`: the Organizations, polled or named by a key's
// listing, whose every reader has an expired key (tracking one now reads
// nothing until a key is reconnected), sorted; empty while hub-connected.
export const ACCOUNTS_PATH = "/api/accounts";

// PUT /api/accounts/:uuid/label (#635, ADR-0136 §7): the user's label for
// one Account, or null to clear it back to the email as read here, else
// `Account <first 8>`. The target is an account uuid (`accountUuidSchema`):
// a Pending account cannot be labelled, since its key never leaves this
// machine and the label rides the fleet's Label directory. The sidecar trims
// and checks the label (`checkLabel`) and answers the fresh GET
// /api/accounts body.
export function accountLabelPath(accountUuid: string): string {
  return `${ACCOUNTS_PATH}/${encodeURIComponent(accountUuid)}/label`;
}
export const accountLabelRequestSchema = z.object({ label: z.string().nullable() });
export type AccountLabelRequest = z.infer<typeof accountLabelRequestSchema>;

export const accountsResponseSchema = z.object({
  accounts: z.array(accountEntrySchema),
  seed: accountsSeedSchema.nullable(),
  folds: z.array(pendingFoldSchema),
  staleOrganizations: z.array(z.string().min(1)),
  expiredReaderOrganizations: z.array(z.string().min(1)),
});
export type AccountsResponse = z.infer<typeof accountsResponseSchema>;
