import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { constants as os } from "node:os";
import { join } from "node:path";
import {
  foldAccountsPatch,
  homeOrganizationOf,
  normalizeHubUrl,
  parseSettings,
  seedAccountsPatch,
  type AccountsSeed,
  type PendingFold,
  type Settings,
  settingsObjectSchema,
  trackAccountPatch,
  withHomeOrganization,
} from "@maxprice/shared";
import { errnoName, tryLockExclusive } from "@maxprice/usage-core/flock";
import { type AnyZodObject, z, type ZodIssue, type ZodTypeAny } from "zod";
import { CliError, EXIT } from "./exit";
import { displayHubUrl } from "./hub-url";
import {
  dataDir,
  displayPath,
  type Env,
  ensureDataDir,
  settingsLockPath,
  settingsPath,
} from "./paths";
import {
  type ParseContext,
  SETTING_KEYS,
  type SettingFile,
  type SettingKey,
  settingKeyForFile,
  settingsUsage,
  type SettingValue,
} from "./settings-keys";

// The Headless client's settings, `<data dir>/settings.json` (ADR-0122). The
// `maxprice` binary is its only writer, through `editSettings`; the daemon
// reads it through the sidecar's own watch.
//
// A read uses the shared `parseSettings`, as the Desktop's renderer reads its
// own: each absent key resolves to its schema default in this process, so an
// unset `timezone` is the invoking shell's zone (ADR-0122 §2). A report reads
// it for the time zone, the cost mode, the Week, Home, the tracked set and the
// machine axis's gate; it never reads the Desktop's `scope` (ADR-0122 §4).

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// The file's JSON object as written: no key defaulted, none dropped. No file
// yet reads as `{}`. A file that is not a JSON object is one nothing can be
// trusted from (ADR-0122 §7), so the command fails rather than describe Home
// and the tracked set as defaults, and a write never replaces it.
export function readSettingsObject(env: Env): Record<string, unknown> {
  const path = settingsPath(dataDir(env));
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") return {};
    throw new CliError(EXIT.FAILURE, `cannot read ${displayPath(path, env)}: ${messageOf(error)}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new CliError(
      EXIT.FAILURE,
      `${displayPath(path, env)} is not valid JSON: ${messageOf(error)}`,
    );
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new CliError(EXIT.FAILURE, `${displayPath(path, env)} does not hold a JSON object`);
  }
  return raw as Record<string, unknown>;
}

export function readSettings(env: Env): Settings {
  return parseSettings(readSettingsObject(env));
}

// Whether settings.json names a Hub. A file that cannot be read names none
// here; `status` says why.
export function hubNamed(env: Env): boolean {
  try {
    return displayHubUrl(readSettings(env).hubUrl) !== null;
  } catch {
    return false;
  }
}

// The Hub a `hubUrl` joins (ADR-0121 §3), as `serve` passes it to the boot:
// null when it names none, else normalized as the Desktop's
// `deriveHubConfigBody` normalizes its push, or as written when it does not
// parse, so the sidecar's own failure state shows it.
export function joinedHubUrl(hubUrl: string): string | null {
  if (hubUrl.trim() === "") return null;
  try {
    return normalizeHubUrl(hubUrl);
  } catch {
    return hubUrl;
  }
}

// ADR-0122 §4: the keys a Headless command writes. The seven `settings` keys,
// then the Home membership and the tracked lists (`org`, and `serve`'s seeds),
// then `hubUrl` and `hubAutoHeal` (`hub join|leave`). The Desktop-only
// `sidebarCollapsed`, `keepRunningInBackground` and `showModelLimit` are not
// the Headless client's, and `scope` is never written: its fallback, `null`,
// is the default Scope, the Home membership, which is what a report with no
// `--org` describes anyway. Neither is checked, and a file's `scope` (or a
// released file's `organizationScope`) is kept as written through every
// write, as every key a command does not own is.
//
// `homeOrganization` is no longer written by anything: it is a v0.9.2 file's
// Home (#631), read as the Home membership while the file names no
// `homeMemberships`, and still checked then, since it is that file's Home.
// Every write replaces it (`replaceLegacyHome`).
const LEGACY_HOME = "homeOrganization";
const OTHER_OWNED = [
  "homeMemberships",
  LEGACY_HOME,
  "trackedOrganizations",
  "trackedAccounts",
  "hubUrl",
  "hubAutoHeal",
] as const;

export type OwnedKey = SettingFile | (typeof OTHER_OWNED)[number];

const OWNED_KEYS: readonly OwnedKey[] = [...SETTING_KEYS.map((key) => key.file), ...OTHER_OWNED];

type ZodDef = { typeName?: string; innerType?: ZodTypeAny };

// A field's schema without its `.catch` and `.default`, through an object's
// fields and an optional's inner schema too (the Week's sub-fields and a Home
// membership's Account carry their own): what `set` validates against, and
// what tells a stored value the schema accepts from one it replaced (ADR-0122
// §4, §7). Wrappers are known by `_def.typeName`, not `instanceof`, since two
// copies of zod can load; an object is rebuilt with its own copy's `extend`.
function strict(schema: ZodTypeAny): ZodTypeAny {
  const def = schema._def as ZodDef;
  if ((def.typeName === "ZodCatch" || def.typeName === "ZodDefault") && def.innerType) {
    return strict(def.innerType);
  }
  if (def.typeName === "ZodOptional" && def.innerType) return strict(def.innerType).optional();
  if (def.typeName === "ZodObject") {
    const object = schema as AnyZodObject;
    const shape = Object.entries(object.shape as Record<string, ZodTypeAny>);
    return object.extend(Object.fromEntries(shape.map(([name, field]) => [name, strict(field)])));
  }
  return schema;
}

function strictFor(file: OwnedKey): ZodTypeAny {
  // Its inner schema is a transform that swaps a bad zone for the host's
  // rather than fail, so the strict form asks it: the shared schema stays the
  // one definition of a valid zone.
  if (file === "timezone") {
    return z
      .string()
      .refine(
        (zone) => settingsObjectSchema.shape.timezone.parse(zone) === zone,
        "not an IANA time zone",
      );
  }
  // v0.9.2's own reading of it.
  if (file === LEGACY_HOME) return z.string().min(1).nullable();
  return strict(settingsObjectSchema.shape[file]);
}

const STRICT = Object.fromEntries(OWNED_KEYS.map((file) => [file, strictFor(file)])) as Record<
  OwnedKey,
  ZodTypeAny
>;

// Zod's message, after the path inside the value when there is one:
// `weekday: Required`, `[0]: Expected string, received number`.
function issueText(issue: ZodIssue | undefined): string {
  if (issue === undefined) return "rejected";
  const path = issue.path
    .map((part) => (typeof part === "number" ? `[${part}]` : `.${part}`))
    .join("")
    .replace(/^\./, "");
  return path === "" ? issue.message : `${path}: ${issue.message}`;
}

// The value `settings set <key> <words…>` stores: the key's own parse, then
// the file's strict schema. Either refusal is a usage error (exit 2).
export function settingValue(
  key: SettingKey,
  words: readonly string[],
  context: ParseContext,
): SettingValue {
  const value = key.parse(words, context);
  const result = STRICT[key.file].safeParse(value);
  if (!result.success) {
    throw settingsUsage(
      `invalid ${key.name} '${words.join(" ")}': ${issueText(result.error.issues[0])}`,
    );
  }
  return value;
}

export type RejectedField = {
  file: OwnedKey;
  // The `settings` key that writes it, or null for a key another command owns.
  key: SettingKey | null;
  // Zod's reason.
  reason: string;
  // The schema's fallback, which is what applies, as `get` and `status` print
  // it: `none` for an empty Hub URL, Home or tracked list.
  effective: string;
};

function effectiveValue(settings: Settings, file: OwnedKey): string {
  switch (file) {
    case "homeMemberships":
    case LEGACY_HOME:
      return homeOrganizationOf(settings) ?? "none";
    case "trackedOrganizations":
      return settings.trackedOrganizations.join(", ") || "none";
    case "trackedAccounts":
      return settings.trackedAccounts?.join(", ") || "none";
    case "hubUrl":
      return settings.hubUrl || "none";
    case "hubAutoHeal":
      return settings.hubAutoHeal ? "on" : "off";
    default:
      return settingKeyForFile(file)?.format(settings) ?? "";
  }
}

// Each owned key present in the file whose value the strict schema rejects,
// in OWNED_KEYS's order (ADR-0122 §7). An absent key is never rejected, and
// neither is a legacy Home beside a `homeMemberships`, which no read uses.
export function rejectedFields(raw: Record<string, unknown>): RejectedField[] {
  const settings = parseSettings(raw);
  const rejected: RejectedField[] = [];
  for (const file of OWNED_KEYS) {
    if (!Object.hasOwn(raw, file)) continue;
    if (file === LEGACY_HOME && Object.hasOwn(raw, "homeMemberships")) continue;
    const result = STRICT[file].safeParse(raw[file]);
    if (result.success) continue;
    rejected.push({
      file,
      key: settingKeyForFile(file),
      reason: issueText(result.error.issues[0]),
      effective: effectiveValue(settings, file),
    });
  }
  return rejected;
}

// The admission keys (ADR-0098, ADR-0136 §3): a degraded Home or tracked set,
// of Organizations or of Accounts, can admit an Excluded organization's or
// Account's usage, or start a repair.
const ADMISSION_KEYS: readonly OwnedKey[] = [
  "homeMemberships",
  LEGACY_HOME,
  "trackedOrganizations",
  "trackedAccounts",
];

// Home or a tracked list, when the file holds a value the schema rejects:
// `<path>: trackedOrganizations is rejected (<reason>)`, each such field
// named; null when none is. `serve` will not boot on such a file
// (ADR-0122 §7), and `org` will not rewrite it: its patch would replace the
// stored value with one built on the schema's fallback.
export function admissionRejection(raw: Record<string, unknown>, env: Env): string | null {
  const refused = rejectedFields(raw).filter((field) => ADMISSION_KEYS.includes(field.file));
  if (refused.length === 0) return null;
  const path = displayPath(settingsPath(dataDir(env)), env);
  const fields = refused.map((field) => `${field.file} is rejected (${field.reason})`);
  return `${path}: ${fields.join("; ")}`;
}

const FIX_HINT = "Fix the file, then start the daemon again.";

// ADR-0122 §7: `serve` refuses to boot, with exit 6, on a file it cannot read
// as a JSON object, or one whose Home or a tracked list the schema rejects. Any
// other rejected field boots on the schema's fallback. Returns the settings it
// checked, so `serve` reads the file once.
export function checkSettingsForServe(env: Env): Settings {
  let raw: Record<string, unknown>;
  try {
    raw = readSettingsObject(env);
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    throw new CliError(EXIT.SETTINGS_REFUSED, error.message, [FIX_HINT]);
  }
  const rejection = admissionRejection(raw, env);
  if (rejection !== null) throw new CliError(EXIT.SETTINGS_REFUSED, rejection, [FIX_HINT]);
  return parseSettings(raw);
}

export type SettingsHealth = { unreadable: string } | { rejected: RejectedField[] };

// What `status` says about the file: never a throw.
export function settingsHealth(env: Env): SettingsHealth {
  try {
    return { rejected: rejectedFields(readSettingsObject(env)) };
  } catch (error) {
    return { unreadable: messageOf(error) };
  }
}

export type EditOptions = {
  // How long to wait for another writer's lock; 5 s (ADR-0122 §2).
  lockTimeoutMs?: number;
  // How often to try the lock again while it waits.
  pollMs?: number;
  // Awaited between the read and the edit, under the lock: a test holds a
  // writer inside its critical section with it.
  afterRead?: () => Promise<void>;
};

const LOCK_TIMEOUT_MS = 5000;
const LOCK_POLL_MS = 50;

// ADR-0122 §2: an exclusive flock on `settings.lock`, through the binding
// ADR-0120 §3's serve lock uses. It never blocks, so waiting is a poll, which
// gives up after the timeout. Closing the descriptor releases it.
async function lockSettings(dir: string, env: Env, options: EditOptions): Promise<number> {
  const path = settingsLockPath(dir);
  const timeoutMs = options.lockTimeoutMs ?? LOCK_TIMEOUT_MS;
  const pollMs = options.pollMs ?? LOCK_POLL_MS;
  const deadline = Date.now() + timeoutMs;
  // O_RDWR | O_CREAT, never "w": the file holds nothing, and a lock is on the
  // open file description, not the bytes.
  const fd = openSync(path, constants.O_RDWR | constants.O_CREAT, 0o600);
  try {
    for (;;) {
      const errno = tryLockExclusive(fd);
      if (errno === 0) return fd;
      if (errno !== os.errno.EWOULDBLOCK) {
        throw new CliError(
          EXIT.FAILURE,
          `cannot lock ${displayPath(path, env)}: flock failed with ${errnoName(errno)}`,
        );
      }
      const left = deadline - Date.now();
      if (left <= 0) throw new CliError(EXIT.FAILURE, "another maxprice is changing settings");
      await Bun.sleep(Math.min(pollMs, left));
    }
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

// A uniquely named temp file in the data dir, opened 0600, fsynced, then
// renamed over settings.json, so a reader sees the old file or the new one
// and never a part of either. The Desktop's `to_string_pretty` shape.
function writeSettingsObject(dir: string, raw: Record<string, unknown>, env: Env): void {
  const path = settingsPath(dir);
  const temp = join(dir, `.settings.json.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
  let fd: number | null = null;
  let created = false;
  try {
    fd = openSync(temp, "wx", 0o600);
    created = true;
    writeFileSync(fd, JSON.stringify(raw, null, 2) + "\n");
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(temp, path);
  } catch (error) {
    if (fd !== null) closeSync(fd);
    if (created) unlinkSync(temp);
    throw new CliError(EXIT.FAILURE, `cannot write ${displayPath(path, env)}: ${messageOf(error)}`);
  }
}

// #631: a write replaces a v0.9.2 file's `homeOrganization` with the Home
// membership it reads as, so the file keeps only the new key, as the Desktop
// client's next write leaves it. Not when either value is one the schema
// rejects: the file is left as it is for the user to fix (ADR-0122 §7).
function replaceLegacyHome(raw: Record<string, unknown>): void {
  if (!Object.hasOwn(raw, LEGACY_HOME)) return;
  if (!STRICT[LEGACY_HOME].safeParse(raw[LEGACY_HOME]).success) return;
  const named = Object.hasOwn(raw, "homeMemberships");
  if (named && !STRICT.homeMemberships.safeParse(raw.homeMemberships).success) return;
  const memberships = parseSettings(raw).homeMemberships;
  delete raw[LEGACY_HOME];
  // A legacy `null` was no Home: nothing to name.
  if (named || Object.keys(memberships).length > 0) raw.homeMemberships = memberships;
}

// The only writer (ADR-0122 §2): a locked, sparse read-modify-write. `edit`
// changes only the keys its command owns, in place, and returns whether it
// changed anything; every other key, unknown and Desktop-only ones included,
// stays as read, in its order, but for a legacy Home a write replaces
// (`replaceLegacyHome`). Nothing is filled in, so an unset key keeps
// resolving to its default. An edit that changes nothing writes nothing, and
// a file that is not a JSON object is never rewritten: the read throws exit 1
// first. Returns whether it wrote.
export async function editSettings(
  env: Env,
  edit: (raw: Record<string, unknown>) => boolean,
  options: EditOptions = {},
): Promise<boolean> {
  const dir = dataDir(env);
  ensureDataDir(dir);
  const fd = await lockSettings(dir, env, options);
  try {
    const raw = readSettingsObject(env);
    await options.afterRead?.();
    const changed = edit(raw);
    if (changed) {
      replaceLegacyHome(raw);
      writeSettingsObject(dir, raw, env);
    }
    return changed;
  } finally {
    closeSync(fd);
  }
}

// ADR-0122 §3: `serve` saves the first-boot Home seed, unless the file
// already names a Home (ADR-0098's #385 rule). It writes the Anthropic Home
// membership alone, with the seed as its Organization and its Account not
// known (ADR-0136 §8).
export async function saveHomeSeed(env: Env, uuid: string): Promise<"saved" | "named"> {
  const saved = await editSettings(env, (raw) => {
    const settings = parseSettings(raw);
    if (homeOrganizationOf(settings) !== null) return false;
    raw.homeMemberships = withHomeOrganization(settings, uuid);
    return true;
  });
  return saved ? "saved" : "named";
}

// #631: `serve` saves the boot's Account seed (ADR-0136 §4, §8) the same way,
// unless the file names a `trackedAccounts` list by then: the tracked Account
// list, and the Home membership's Account where the Home is still the seed's
// (`seedAccountsPatch`, shared with the Desktop renderer).
export async function saveAccountsSeed(env: Env, seed: AccountsSeed): Promise<"saved" | "named"> {
  const saved = await editSettings(env, (raw) => {
    const patch = seedAccountsPatch(parseSettings(raw), seed);
    if (patch === null) return false;
    raw.homeMemberships = patch.homeMemberships;
    raw.trackedAccounts = patch.trackedAccounts;
    return true;
  });
  return saved ? "saved" : "named";
}

// #631: `serve` writes the Pending account folds the boot or a pair change
// decided (ADR-0137 §1), where the list still names their Pending keys
// (`foldAccountsPatch`).
export async function saveAccountFolds(
  env: Env,
  folds: readonly PendingFold[],
): Promise<"saved" | "unchanged"> {
  const saved = await editSettings(env, (raw) => {
    const patch = foldAccountsPatch(parseSettings(raw), folds);
    if (patch === null) return false;
    raw.trackedAccounts = patch.trackedAccounts;
    return true;
  });
  return saved ? "saved" : "unchanged";
}

// #633 (ADR-0136 §4): `key set` tracks the key's Account, as the Desktop
// client's Connect does, appending it to the tracked list
// (`trackAccountPatch`, shared). Nothing is written for the Home membership's
// Account, which is always tracked, for one the list already names, or while
// the file names no list yet (the boot's seed decides it).
export async function trackKeyAccount(
  env: Env,
  accountUuid: string,
): Promise<"tracked" | "unchanged"> {
  const saved = await editSettings(env, (raw) => {
    const patch = trackAccountPatch(parseSettings(raw), accountUuid);
    if (patch === null) return false;
    raw.trackedAccounts = patch.trackedAccounts;
    return true;
  });
  return saved ? "tracked" : "unchanged";
}
