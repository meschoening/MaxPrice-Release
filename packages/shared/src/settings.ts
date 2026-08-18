import { z } from "zod";
import { costModeSchema } from "./cost-mode";
import { hostTimeFormat, timeFormatSchema } from "./time-format";

// Settings (CONTEXT.md): durable user config, persisted as settings.json in
// the OS app-data dir. Distinct from ephemeral filter-rail/chart state.
// `timezone` and `costMode` travel to the engine as `tz`/`mode` query params;
// `claudePaths` is the only field the sidecar consumes directly (ADR-0014).
// `timeFormat` travels nowhere — it is renderer-only (ADR-0060).

// Default Claude data paths — the two standard locations, kept literal and
// unfiltered so a fresh machine still has roots to watch (ADR-0014).
export const DEFAULT_CLAUDE_PATHS = ["~/.config/claude/projects", "~/.claude/projects"] as const;

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

// Per-field `.catch()` mirrors each `.default()`: a present-but-wrong-typed or
// out-of-enum field degrades to its own default while valid siblings survive,
// instead of one bad field wiping the whole object (which the renderer's
// sole-writer round-trip would then persist permanently). `.passthrough()`
// keeps unknown keys written by a newer app version through a read/edit/write
// round-trip on an older binary, so a downgrade doesn't erase future fields.
export const settingsSchema = z
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
  })
  .passthrough();

export type Settings = z.infer<typeof settingsSchema>;

export const DEFAULT_SETTINGS: Settings = settingsSchema.parse({});

// Parse an untrusted value (file contents, IPC payload) into Settings. The
// per-field `.catch()` above recovers individual bad fields in-place, so the
// wholesale fallback here only fires for non-object input (`null`, a string,
// etc.) that can't carry any recoverable fields at all.
export function parseSettings(value: unknown): Settings {
  const result = settingsSchema.safeParse(value);
  return result.success ? result.data : DEFAULT_SETTINGS;
}
