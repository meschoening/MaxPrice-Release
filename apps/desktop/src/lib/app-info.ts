import { formatRelativeTime, type PricingFailureKind, type PricingStatus } from "@maxprice/shared";
import type { ConnectionState } from "@/state/use-live-status";
import type { DotVariant } from "./dot-variant";

// Settings › App info — the four rows' derivations (map #100, T5; the grammar
// and the frozen copy are NOTES §"Settings › App info — Glass").
// Every user-visible string in the section is produced here rather than inline
// in JSX, for two reasons: the Engine row's drift comparison is the section's
// one piece of real logic, and the Pricing row has six states whose tone rules
// are easy to get subtly wrong. The component that renders these is a dumb
// mapper over the returned cells.

// `soft` = the fact is unknown; `warn` = the value itself is degraded; `bad` =
// the value reports a hard failure. Amber tints the VALUE only in the degraded
// case — a failed refresh sitting on top of good live prices tints only the
// note, because the number being read is fine. `bad` arrived with the Sidecar
// row, whose Offline state is not a degradation of a number but the absence of
// every number: it reads in the same red its dot wears.
export type AppInfoTone = "" | "soft" | "warn" | "bad";

// A note is a small run of prose with the occasional command in it. Parts,
// rather than a string with markup, so the renderer wraps commands in <code>
// without any HTML ever crossing this boundary.
export type NotePart = { text: string } | { code: string };

// The glass `.dot` triad variant a row's value wears, plus whether it breathes
// on the shared pulse. `null` on every static row — the three original facts
// are label/value pairs, not status vocabulary, and only the live Sidecar row
// earns a dot (NOTES §"Settings › App info", amended 2026-08-01).
export type AppInfoDot = { variant: DotVariant; pulse: boolean };

export type AppInfoCell = {
  value: string;
  tone: AppInfoTone;
  dot: AppInfoDot | null;
  // The secondary fact under the value (`LiteLLM · N models`). Never a
  // hard-coded snapshot size — the count is a wire field, and it differs
  // between the vendored floor and a live fetch.
  meta: string | null;
  note: NotePart[] | null;
  noteTone: "" | "warn";
  // The raw failure detail, surfaced as the value's tooltip. Failure copy is
  // written from the five-member `kind` enum; the raw error is never prose.
  title: string | null;
};

// The em dash every other status surface already uses for "we don't know"
// (`formatRelativeTime`, the StatusBar's old `engine —`).
const UNKNOWN = "—";

const BARE = { meta: null, note: null, noteTone: "", title: null, dot: null } as const;

// One written clause per failure kind (ADR-0053's enum). Exhaustive by type:
// a new kind fails to compile until it has copy.
const FAILURE_CLAUSE: Record<PricingFailureKind, string> = {
  offline: "no network connection",
  timeout: "LiteLLM didn’t respond in time",
  http: "LiteLLM returned an error",
  payload: "LiteLLM’s price list couldn’t be read",
  unknown: "the refresh failed",
};

export function versionCell(appVersion: string): AppInfoCell {
  return { ...BARE, value: `v${appVersion}`, tone: "" };
}

// `engineVersion` arrives at runtime from the sidecar binary while
// `appVersion` (`__APP_VERSION__`) is baked into the renderer at Vite config
// time, so a disagreement means a stale `bun run build:binaries` — the whole
// reason this row is shown even though a coherent build makes it a duplicate.
//
// Version equality is NOT proof of a fresh binary, though, and on its own this
// row could never fire in the case it exists for. `scripts/set-version.ts`
// rewrites the desktop and sidecar manifests TOGETHER, so the two numbers can
// only disagree across a release bump — and `v0.1.0` has never been tagged. A
// sidecar predating ADR-0053 therefore reports a matching `0.1.0` while
// emitting no `pricing` at all, which is exactly the staleness the Pricing row
// below renders as "Not reported by the sidecar." So the drift signal is the
// OR of two independent pieces of evidence, and `pricingReported` is the one
// that actually fires today. It is required, not defaulted: a default would be
// a compat shim for callers that don't exist.
export function engineCell(
  engineVersion: string | null,
  appVersion: string,
  pricingReported: boolean,
): AppInfoCell {
  // Not-yet-known is not drift: no status frame has landed. A bare em dash and
  // NO explanatory note, because this state only ever coincides with the
  // Pricing row's "Not reported by the sidecar." directly below it, and the
  // same sentence stacked twice reads worse than one. This case MUST come
  // first: no frame means no pricing either, and a frameless boot is not a
  // stale binary. `applyStatusSnapshot` writes both fields in one `set()`, so
  // `engineVersion !== null` with no pricing means precisely "a frame arrived
  // and carried none" — never a torn read.
  if (engineVersion === null) return { ...BARE, value: UNKNOWN, tone: "soft" };
  if (!pricingReported || engineVersion !== appVersion) {
    return {
      ...BARE,
      value: `v${engineVersion}`,
      tone: "warn",
      note: [
        { text: "Stale sidecar binary — run " },
        { code: "bun run build:binaries" },
        { text: " and relaunch." },
      ],
      noteTone: "warn",
    };
  }
  return { ...BARE, value: `v${engineVersion}`, tone: "" };
}

// The vendored floor's capture date is a fixed fact of the build, so it reads
// as a date rather than an age; a fetch is recent by construction and reads
// relatively. `tz` is the Settings timezone, so the date agrees with the day
// the rest of the app would bucket it into.
//
// `capturedAt` is a bare `z.string()` on the wire — nothing constrains it to
// ISO 8601 — and an unparseable stamp would otherwise render the literal text
// "Invalid Date" inside the value ("Built-in snapshot · captured Invalid
// Date"). Every sibling timestamp degrades to the em dash instead
// (`formatRelativeTime` guards the same way), so this one does too. The guard
// belongs HERE and not in the schema: `handleStatusEvent` drops the entire
// frame on a parse failure and the boot splash gates on `ready` riding that
// frame, so tightening `capturedAt` to `.datetime()` would brick the app on the
// splash over a cosmetic date.
function capturedDate(iso: string, tz: string | undefined): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return UNKNOWN;
  return new Date(ms).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: tz,
  });
}

export function pricingCell(pricing: PricingStatus | null, now: number, tz?: string): AppInfoCell {
  // Absent on the wire (a stale sidecar binary) and never-yet-received (no
  // frame) render identically: both mean "we don't know", and the Engine row
  // above already says which.
  if (pricing === null) {
    return {
      ...BARE,
      value: UNKNOWN,
      tone: "soft",
      note: [{ text: "Not reported by the sidecar." }],
    };
  }

  const meta = `LiteLLM · ${pricing.modelCount} models`;
  const attempt = pricing.lastAttempt;
  const failure = attempt?.failure ?? null;
  // A sentence FRAGMENT with a load-bearing trailing space, not a boolean: both
  // branches below finish it with their own clause. Named for what it holds.
  // `attempt &&` is redundant at runtime (a failure implies an attempt) but not
  // to the compiler — it does not narrow `attempt` from `failure`'s truthiness.
  const failurePrefix =
    attempt && failure
      ? `Last refresh failed ${formatRelativeTime(attempt.at, now)} — ` +
        `${FAILURE_CLAUSE[failure.kind]}. `
      : "";

  if (pricing.source === "fetched") {
    // Prices ARE live and current even when the most recent refresh failed
    // (`source` is not derivable from `lastAttempt`), so the value stays plain
    // and only the attempt line goes amber. No relaunch nag either: nothing is
    // degraded, so it would be noise.
    return {
      value: `Live · fetched ${formatRelativeTime(pricing.capturedAt, now)}`,
      tone: "",
      dot: null,
      meta,
      note: failure ? [{ text: `${failurePrefix}Retrying automatically.` }] : null,
      noteTone: failure ? "warn" : "",
      title: failure?.detail ?? null,
    };
  }

  const value = `Built-in snapshot · captured ${capturedDate(pricing.capturedAt, tz)}`;
  // The floor with no settled attempt yet is a plain transient, not a fault.
  // The test is `!failure` rather than the narrower `attempt === null` because
  // the difference — a vendored snapshot with a settled SUCCESSFUL attempt — is
  // unrepresentable: a success swaps the active snapshot, so `source` becomes
  // `fetched`; a swap that itself throws is classified `unknown` and arrives
  // here WITH a failure. And of the two guards, the wider one is the safe one:
  // tightening it would route that impossible case into the amber branch below,
  // which dereferences `failure.detail`.
  if (!failure) {
    return {
      ...BARE,
      value,
      tone: "soft",
      meta,
      note: [{ text: "Checking LiteLLM for newer prices…" }],
    };
  }
  // Now the value itself is degraded, so it goes amber too. Per T2 (#102) the
  // copy can never read as permanent: it names the automatic retry AND the
  // relaunch remedy, which restarts the sidecar and re-attempts at once.
  return {
    value,
    tone: "warn",
    dot: null,
    meta,
    note: [
      { text: `${failurePrefix}Retrying automatically; relaunching MaxPrice retries right away.` },
    ],
    noteTone: "warn",
    title: failure.detail,
  };
}

// The Sidecar row — the one LIVE fact in a section of static ones, and the only
// row that carries a dot. It moved here from the sidebar foot: the foot is a
// glance surface for state you can act on, and the SSE connection is already
// reported on every page by the topbar refresh pill ("offline" / "reconnecting…"
// in warn tone) and by the Live streaming badge, so a third permanent copy in
// the chrome bought nothing the pill wasn't already saying.
//
// The label column says "Sidecar", so the value never repeats it. Tone tracks
// the dot rather than the section's usual "amber only when degraded" rule:
// Offline is not a degraded reading, it is the absence of every reading, and a
// row whose dot is red while its word is amber reads as a contradiction.
const SIDECAR_ROW: Record<ConnectionState, AppInfoCell> = {
  connected: {
    ...BARE,
    value: "Online",
    tone: "",
    dot: { variant: "good", pulse: false },
    title: "Live data pipeline connected.",
  },
  reconnecting: {
    ...BARE,
    value: "Reconnecting…",
    tone: "warn",
    dot: { variant: "warn", pulse: true },
    title: "Sidecar unreachable — reconnecting…",
  },
  disconnected: {
    ...BARE,
    value: "Offline",
    tone: "bad",
    dot: { variant: "bad", pulse: false },
    title: "Sidecar offline.",
  },
};

export function sidecarCell(connectionState: ConnectionState): AppInfoCell {
  return SIDECAR_ROW[connectionState];
}
