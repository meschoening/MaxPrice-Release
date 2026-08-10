import type { HubMachine, StorageReport, StorageSegment, StorageSegmentId } from "@maxprice/shared";

// Settings › Storage — the renderer's pure half (map #124, ticket #133).
//
// The wire (`GET /api/storage`) carries only ids and bytes; every label,
// sentence and proportion below is renderer-side, and this module is where the
// ones that can be wrong live. `storage-section.tsx` and `storage-actions.tsx`
// hold the markup; the arithmetic, the copy table, and the two rules the
// section exists to keep honest live here, where they are testable.
//
// The visual contract is `plans/mocks/redesign/storage-glass.html` (variant C,
// `framed`) + NOTES.md §"Settings › Storage — Glass". The copy below is the
// mock's frozen `COPY` table.

export type MeasuredSegment = Extract<StorageSegment, { state: "measured" }>;
export type UnavailableSegment = Extract<StorageSegment, { state: "unavailable" }>;

const KB = 1024;
const MB = 1024 * 1024;

// The mock's `fmt`. One decimal from a megabyte up, whole kilobytes below that,
// raw bytes under a kilobyte — deliberately NOT the hub console's
// KiB/MiB/GiB `formatBytes`: this section talks to a user about their disk,
// where the units on the box say MB.
export function formatStorageBytes(bytes: number): string {
  if (bytes >= MB) return `${(bytes / MB).toFixed(1)} MB`;
  if (bytes >= KB) return `${Math.round(bytes / KB).toLocaleString()} KB`;
  return `${bytes} B`;
}

// Segments MaxPrice cannot reclaim. Today exactly one; kept as a SET because
// "which of these is ours to act on" is the section's whole argument, and a
// second one (some future OS-managed cache) must not need a code hunt.
export const INERT_SEGMENT_IDS: ReadonlySet<StorageSegmentId> = new Set<StorageSegmentId>([
  "webviewProfile",
]);

export function isInertSegment(id: StorageSegmentId): boolean {
  return INERT_SEGMENT_IDS.has(id);
}

export function measuredSegments(report: StorageReport): MeasuredSegment[] {
  return report.segments.filter((s): s is MeasuredSegment => s.state === "measured");
}

export function unavailableSegments(report: StorageReport): UnavailableSegment[] {
  return report.segments.filter((s): s is UnavailableSegment => s.state === "unavailable");
}

// The bar's denominator and the total line's figure: measured bytes only. An
// `unavailable` segment contributes nothing here and is confessed separately
// (the "+ unknown" suffix and the warn inset) — counting it as 0 would state a
// number we do not have.
export function storageTotalBytes(report: StorageReport): number {
  return measuredSegments(report).reduce((sum, s) => sum + s.bytes, 0);
}

// A segment's share of the measured total, as a flex-GROW weight. Never a
// percentage basis: `flex-basis: 71%` resolves against the full container and
// `gap` is then added on top, so an n-segment bar overshoots its box by
// (n−1)×gap. With `flex: <share> 1 0` flexbox subtracts the gaps itself.
export function segmentShare(report: StorageReport, segment: StorageSegment): number {
  if (segment.state !== "measured") return 0;
  return segment.bytes / (storageTotalBytes(report) || 1);
}

// The corpus line's "about N× everything below" clause — null when ANY segment
// is unavailable. A ratio computed against a total we have just admitted we do
// not know is a number with no meaning, and one that moves for a reason that
// has nothing to do with the corpus.
export function corpusRatio(report: StorageReport): string | null {
  if (unavailableSegments(report).length > 0) return null;
  return (report.corpus.bytes / (storageTotalBytes(report) || 1)).toFixed(1).replace(/\.0$/, "");
}

// ── The legend's dwell popover ────────────────────────────────────────────
//
// The legend's seven notes are ~9 lines of prose under a 26px bar, so they left
// the resting list and come back on a dwell (chosen 2026-08-04 from the four
// `?notes=` variants in `plans/mocks/redesign/storage-glass.html`: dwell / a
// per-row `?` / one section switch / a reserved strip).
//
// The two timings are what make the gesture survivable, and they are a pair:
// DWELL is the toll for the FIRST note — long enough that reading the list
// top to bottom never summons one — and GRACE keeps the group WARM, so every
// neighbour opens instantly and a diagonal mouse path across the rows doesn't
// have to re-earn the delay.
export const NOTE_DWELL_MS = 450;
export const NOTE_GRACE_MS = 250;

const POP_EDGE = 8; // viewport margin the popover may never cross
const POP_GAP = 6; // between the row and the popover
const POP_INDENT = 18; // past the row's left edge, clearing the swatch column

// Where the popover goes: below the row by default, flipped above when the
// viewport floor is nearer than the popover is tall. Pure, because it is the
// only part of the gesture that can be wrong in a way a screenshot won't show
// — a popover half off-screen on a short window.
//
// Both axes clamp LAST: the right-edge bound is `viewport.width - width - EDGE`,
// which goes negative for a popover wider than the viewport, and a clamp
// written as one `min(max(...))` would then place it off the left edge.
export function placeNotePopover(
  anchor: { left: number; top: number; bottom: number },
  pop: { width: number; height: number },
  viewport: { width: number; height: number },
): { left: number; top: number } {
  const left = Math.min(anchor.left + POP_INDENT, viewport.width - pop.width - POP_EDGE);
  const below = anchor.bottom + POP_GAP;
  const flip = below + pop.height > viewport.height - POP_EDGE;
  const top = flip ? anchor.top - pop.height - POP_GAP : below;
  return { left: Math.max(POP_EDGE, left), top: Math.max(POP_EDGE, top) };
}

// The typed-confirm token: THIS machine's own directory name.
//
// Deliberately not `machineName()` from lib/machines — that resolves the
// `mergedInto` alias chain, and a merged machine would offer its TARGET's name
// as the token. The forget route scopes on `row.machineId === x-maxprice-machine`
// byte-equal and never alias-resolves (T4/ADR-0063), so the word you type has
// to name the id whose rows actually go. Falls back to the same
// `machine-<prefix>` shape the hub registers under when the directory has no
// entry for us yet.
export function selfMachineLabel(selfId: string, machines: HubMachine[]): string {
  return machines.find((m) => m.machineId === selfId)?.name ?? `machine-${selfId.slice(0, 8)}`;
}

// Guard 4 — the LAST gate before ADR-0063's irreversible, fleet-wide delete.
// Extracted from `ForgetConfirm` for exactly the `table-tree.ts` reason: this
// repo has no component-test rig, so a rule living inside a dialog is a rule
// nothing can pin. Pure, so the test file beside `selfMachineLabel` can.
//
// Case-sensitive (the token names an id, not a word), whitespace trimmed (a
// name copied from the machines list carries a trailing space more often than
// not). A `null` machine means the directory has not answered yet — nothing to
// type against, so nothing can arm.
export function isForgetArmed(typed: string, machine: string | null): boolean {
  return machine !== null && typed.trim() === machine;
}

// ── The Local archive's left edge (issue #139) ────────────────────────────
//
// The archive's earliest event, rendered as the "Storing history back to <date>"
// suffix on the Local archive legend row. This is the whole of what #139 shipped:
// that issue asked for a per-machine incompleteness marker on the machine axis,
// and it was rejected as permanent chrome (under `all`, every machine but the oldest
// would be badged forever). What survives is the single-machine half — "why does
// my history start here" — answered once, where the app already claims to keep
// the history (see the `localArchive` note below).
//
// THE WORDING IS LOAD-BEARING. "back to", never "Archiving since" or any
// other phrase implying a start of service: the archive's earliest event
// PREDATES install, because first boot archives whatever transcripts Claude Code
// still held. On the reference fleet the primary machine registered 2026-07-30 carrying events
// from 2026-07-21. #139's own caution — "whatever this renders must not imply
// 'joined on'" — outlived the marker it was written for.
//
// Pure, and here rather than in the section, for the `table-tree.ts` reason:
// this repo has no component-test rig, so a rule inside JSX is a rule nothing
// can pin.
//
// null ⇒ draw nothing. Three cases collapse into it deliberately — no archive on
// this install, a load that failed, an empty archive — plus an unparseable
// timestamp. Unlike `app-info.ts::capturedDate`, whose em-dash degrade sits in a
// table cell that must stay occupied, a half-rendered "Storing history back to —"
// would read as broken; and a failed load already has its own amber inset above the
// bar, so a second fault marker here is noise.
export function archiveHistoryDate(iso: string | null, tz: string | undefined): string | null {
  if (iso === null) return null;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  // The `capturedDate` precedent exactly: short month, numeric day and year,
  // resolved in the user's Timezone setting. ADR-0060's `timeFormat` has nothing
  // to say — this is a calendar date, not a clock time.
  return new Date(ms).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: tz,
  });
}

// ── The frozen copy table ─────────────────────────────────────────────────
//
// One table, so the section, the actions and the confirm can never disagree
// about wording. Everything here is plain text; the few sentences that carry
// emphasis are composed in JSX at their call site with these words verbatim.

export const STORAGE_COPY = {
  title: "Disk usage",
  desc: "What MaxPrice is storing on this machine.",
  actTitle: "Clean up",
  actDesc: "Reclaim space MaxPrice can rebuild, or drop history it can't.",

  // "Own" contrasts with the corpus line directly above — Claude Code's files,
  // which MaxPrice only reads — not with the webview profile, which is disk
  // this install caused and which the total therefore INCLUDES.
  totalLabel: "MaxPrice's own files on this machine",

  unavailable: "couldn't be read",

  // The Local archive row's suffix. See `archiveHistoryDate` for why the verb is
  // "back to" and never "since".
  historyBackTo: (date: string): string => `Storing history back to ${date}`,
  barIncompleteLead: "This total is incomplete.",
  barIncomplete: (segment: UnavailableSegment): string =>
    `${STORAGE_COPY.seg[segment.id].label} couldn't be read — ${segment.detail}. ` +
    "Everything else here is measured; that segment isn't counted in the total above.",

  // The mock reads "N configured path is/are missing"; the noun is pluralised
  // here alongside the verb it already switched.
  corpusMissing: (missing: string[]): string =>
    `${missing.length} configured ${missing.length === 1 ? "path is" : "paths are"} missing, ` +
    "so this is incomplete.",

  // Segment words. Only ids cross the wire. "Reclaimed automatically" is not
  // here and must never be: T1 (#125) measured the webview profile at ~13% of
  // a 320 MiB ceiling with no documented reclamation, so the promise is false.
  seg: {
    webviewProfile: {
      label: "System webview",
      note: "The browser engine this window runs in keeps its own cache and storage here. Managed by the system webview — MaxPrice can't reclaim it.",
    },
    fleetReplica: {
      label: "Fleet history",
      note: "Usage events from every machine sharing your hub. Where the Claude Code logs are already gone, this is the only copy.",
    },
    localArchive: {
      label: "Local archive",
      note: "Your own usage events, kept permanently so reports reach back past Claude Code's cleanup of old session logs. Where those logs are already gone, this is the only copy.",
    },
    scanCache: {
      label: "Parse cache",
      note: "Lets MaxPrice skip re-reading session files it has already parsed. Rebuilt on demand; dropping it costs one slower launch.",
    },
    usageHistory: {
      label: "Usage limit readings",
      note: "One reading a minute. Old readings are what place your 5-hour block boundaries, so they're kept.",
    },
    logs: { label: "Logs", note: "Capped at 5 MB, with one older copy kept." },
    other: { label: "Other app files", note: "Settings, machine and project identity." },
  } satisfies Record<StorageSegmentId, { label: string; note: string }>,

  clean: {
    label: (clean: StorageReport["clean"]): string => `Clean up ${formatStorageBytes(clean.bytes)}`,
    labelEmpty: "Nothing to clean",
    // The duplicated-rows clause disappears entirely when there are none:
    // "and 0 duplicated history rows (0 B)" makes a working number look
    // broken, and a hub-less client has no replica at all.
    why: (clean: StorageReport["clean"]): string =>
      clean.duplicateRows > 0
        ? `Drops the parse cache (${formatStorageBytes(clean.scanCacheBytes)}) and ` +
          `${clean.duplicateRows.toLocaleString()} duplicated history rows ` +
          `(${formatStorageBytes(clean.duplicateBytes)}). ` +
          "Both are rebuilt from files you already have; the only cost is one slower launch."
        : "Drops the parse cache. It's rebuilt from session files you already have; the only cost is one slower launch.",
    whyEmpty: "The parse cache is empty and there are no duplicated rows.",
    done: (bytes: number): string => `Cleaned ${formatStorageBytes(bytes)}.`,
  },

  forget: {
    // The ellipsis is load-bearing: it is the difference between the two
    // buttons at a glance. Clean acts; Forget asks first.
    label: (rows: number): string => `Forget ${rows.toLocaleString()} rows…`,
    labelEmpty: "Nothing unbacked",
    whyEmpty: "Every row this machine has shared is still backed by a session file you have.",
    done: (rows: number): string => `Forgot ${rows.toLocaleString()} rows.`,

    // Guards 1–3. All amber: each describes a CONDITION, not a danger, and two
    // of the three really mean "check your Claude data paths".
    block: {
      "scan-incomplete": {
        lead: "Waiting for a complete scan.",
        tail: "Until every session file has been read, MaxPrice can't tell which history is unbacked.",
      },
      "roots-missing": {
        lead: "A Claude data path is missing.",
        tail: "Reconnect it, or remove it in Claude data paths above.",
      },
      "ratio-tripwire": {
        lead: "This doesn't look right.",
        tail: "That usually means a data path is missing rather than that your history is old. Check Claude data paths before forgetting anything.",
      },
    },

    confirmTitle: (rows: number): string =>
      `Forget ${rows.toLocaleString()} rows of unbacked history?`,
    // The three facts that decide it: unbacked of this machine's rows,
    // sessions, bytes.
    confirmFacts: (forget: NonNullable<StorageReport["forget"]>): string =>
      `${forget.unbackedRows.toLocaleString()} of ${forget.selfRows.toLocaleString()} rows from this machine · ` +
      `${forget.sessionCount.toLocaleString()} sessions · ${formatStorageBytes(forget.unbackedBytes)}`,
    // The sample is capped server-side, so the tail is what stops five rows
    // from reading as the whole list. Absent when the sample IS the whole list.
    confirmMore: (forget: NonNullable<StorageReport["forget"]>): string | null => {
      const rest = forget.sessionCount - forget.sampleSessions.length;
      return rest > 0 ? `…and ${rest.toLocaleString()} more sessions` : null;
    },
    confirmCta: "Forget history",
    confirmCancel: "Cancel",
  },
} as const;
