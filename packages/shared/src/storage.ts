import { z } from "zod";

// Wire contract for GET /api/storage — the Settings › Storage report (map #124,
// tickets #126 / #131).
//
// Loopback-only: this shape never crosses the hub wire, so the hub's
// `.optional()`-forever rule does not bind it and it evolves freely with the
// monorepo (no back-compat shims — CLAUDE.md).
//
// ONE request fills the whole section — the bar's segments, the corpus context
// line, both action previews, and the Forget guard verdict. That is not a
// convenience: the section renders a blocked Forget as *present but disabled
// with the reason stated inline*, so the verdict has to arrive WITH the section
// rather than after a click. Both previews are pure RAM work over stores that
// are already loaded, so they add no IO to the walk this endpoint already does.
export const STORAGE_PATH = "/api/storage";

export const storageSegmentIdSchema = z.enum([
  "webviewProfile",
  "fleetReplica",
  "localArchive",
  "scanCache",
  "usageHistory",
  "logs",
  "other",
]);

// Three states, deliberately unconfusable. Absent from `segments` = this
// platform has no such thing (the bar is complete without it). `unavailable` =
// it should be here and could not be read (the bar is INCOMPLETE — the renderer
// must say so; it may never render this as 0). `bytes: 0` is only ever a real,
// measured zero.
//
// Why the union rather than letting an unreadable segment fall out of the
// array: the webview profile is ~71% of the Windows bar. If a permissions
// failure collapsed it to absent, the bar would understate the total three-fold
// while looking complete — in a section whose entire premise is honesty about
// where the bytes went.
export const storageSegmentSchema = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("measured"),
    id: storageSegmentIdSchema,
    bytes: z.number().int().nonnegative(),
    files: z.number().int().nonnegative(),
  }),
  z.object({
    state: z.literal("unavailable"),
    id: storageSegmentIdSchema,
    detail: z.string(),
  }),
]);

export const storageReportSchema = z.object({
  // Bar order IS array order — the sidecar picks it, and the legend renders off
  // the same array, so a renderer-side sort would put the two pictures in
  // different orders. Every segment MaxPrice cannot reclaim is emitted LAST
  // (#127).
  segments: z.array(storageSegmentSchema),

  // The Claude Code corpus: a context line ABOVE the bar, never a segment. Not
  // ours, and the app cannot delete a byte of it. Freshly walked, never derived
  // from the scan cache — the cache skips every non-`.jsonl` entry, so it knows
  // roughly half the files the corpus actually holds (#126 §5).
  corpus: z.object({
    bytes: z.number().int().nonnegative(),
    files: z.number().int().nonnegative(),
    roots: z.array(z.string()),
    // Configured roots that could not be read or hold no transcripts. Also
    // feeds guard 2's `detail` — the unmounted-drive / edited-`claudePaths`
    // case.
    missingRoots: z.array(z.string()),
  }),

  // The earliest event the Local archive holds, ISO, or null (issue #139).
  //
  // The one number behind the section's "Storing history back to <date>" line: what the
  // archive protects floors here, because Claude Code had already swept
  // everything older by the time MaxPrice first walked the corpus. It is an
  // EVENT date, never an install date — first boot archives whatever transcripts
  // still existed, so this routinely predates the install by up to Claude Code's
  // retention window. Copy that reads "archiving since" would be wrong.
  //
  // Deliberately top-level rather than a field on the `localArchive` segment:
  // `storageSegmentSchema` is one shape shared by all seven segments, and a
  // per-segment optional would make every other segment carry a field that can
  // never mean anything.
  //
  // null ⇒ nothing to say, and the renderer draws no line at all: no archive on
  // this install, a load that failed (already confessed by `localArchiveDegraded`
  // — a second broken-looking element would be noise), or an archive that is
  // genuinely empty. Scoped to the archive FILE, not to what the app can display:
  // on a hub client the fleet replica can carry this machine's own rows back
  // further, so reports may reach past this date. That is the right scope for a
  // row on a disk-usage bar, which describes files (spec 2026-08-07 §4).
  localArchiveEarliestAt: z.string().nullable(),

  // Always present: Clean is always safe and always available.
  clean: z.object({
    bytes: z.number().int().nonnegative(), // scanCacheBytes + duplicateBytes
    scanCacheBytes: z.number().int().nonnegative(),
    duplicateRows: z.number().int().nonnegative(),
    duplicateBytes: z.number().int().nonnegative(),
  }),

  // null ⇒ no hub configured, or the fleet replica is off ⇒ the action is
  // ABSENT from the UI, not disabled (it is not a temporary state — a hub-less
  // client has no replica, so nothing it shows can be unbacked). That reuses
  // the segment array's "absent means not applicable" rule; `block` non-null is
  // the disabled-with-reason case. Keeping them as two mechanisms is what stops
  // "no hub" and "hub, but a guard tripped" from collapsing into each other.
  forget: z
    .object({
      unbackedRows: z.number().int().nonnegative(),
      unbackedBytes: z.number().int().nonnegative(),
      // This machine's total self rows — the tripwire denominator, and the
      // "N of M" the confirm copy needs.
      selfRows: z.number().int().nonnegative(),
      // How many distinct sessions those unbacked rows span, in FULL — the
      // third of the three facts the typed confirm states, and what makes the
      // sample below it legible as a sample ("…and 143 more sessions") rather
      // than as the whole list. `sampleSessions` is capped server-side
      // (UNBACKED_SAMPLE_LIMIT), so it cannot answer this itself; #133 added
      // the field the classifier's own comment already assumed was here.
      sessionCount: z.number().int().nonnegative(),
      sampleSessions: z.array(
        z.object({
          projectSlug: z.string(),
          sessionId: z.string(),
          rows: z.number().int().nonnegative(),
        }),
      ),
      // null ⇒ enabled. Non-null ⇒ rendered disabled with `detail` stated
      // inline (a control that silently vanishes reads as a bug). Guard 4 (the
      // typed confirm) is deliberately NOT a reason here — it is the UI gate
      // that `sampleSessions` and `unbackedRows` feed.
      block: z
        .object({
          reason: z.enum(["scan-incomplete", "roots-missing", "ratio-tripwire"]),
          detail: z.string(),
        })
        .nullable(),
    })
    .nullable(),
});

export type StorageSegmentId = z.infer<typeof storageSegmentIdSchema>;
export type StorageSegment = z.infer<typeof storageSegmentSchema>;
export type StorageReport = z.infer<typeof storageReportSchema>;

// ── The two actions (ticket #132) ──────────────────────────────────────────
//
// Both are POSTs behind the sidecar's `x-maxprice-auth` guard, both answer with
// WHAT ACTUALLY HAPPENED rather than echoing what the button was painted with.
// The report above is a preview: it is re-measured server-side at the moment of
// the act, and these bodies report that second measurement. Neither carries a
// fresh report — the renderer invalidates `storageQueryKey` and refetches, so
// there is exactly one place the section's numbers come from.

export const STORAGE_CLEAN_PATH = "/api/storage/clean";
export const STORAGE_FORGET_PATH = "/api/storage/forget";

// Clean drops the parse cache and compacts the replica's superseded lines.
// Fields mirror `storageReportSchema.clean` one for one so the preview and the
// outcome are directly comparable; they will differ whenever the corpus moved
// between the paint and the click, which is information rather than an error.
// A hub-less client has no replica, so the two duplicate fields are 0 — the
// same value the preview showed it.
export const storageCleanResponseSchema = z.object({
  bytes: z.number().int().nonnegative(), // scanCacheBytes + duplicateBytes
  scanCacheBytes: z.number().int().nonnegative(),
  duplicateRows: z.number().int().nonnegative(),
  duplicateBytes: z.number().int().nonnegative(),
});
export type StorageCleanResponse = z.infer<typeof storageCleanResponseSchema>;

// Forget's three counts are deliberately separate, because they answer three
// different questions and the interesting cases are where they disagree
// (hub.ts's `removed` / `sessionsMatched` reasoning, one layer out):
//   sessionsRequested — what THIS machine's classifier named, re-run fresh.
//   sessionsMatched   — how many of those the hub actually held. Short means
//                       the classifier named sessions the hub never had.
//   rowsRemoved       — what the hub's rewrite actually dropped. Short means
//                       rows arrived or were already gone; never a retry signal.
// A guard that trips, or a hub that cannot be reached, is an ERROR (the pinned
// envelope), never a 200 with zeroes: "nothing happened" and "nothing needed to
// happen" must not arrive looking alike on a destructive action.
// Forget's request body is a CEILING THE USER SIGNED, never the delete target.
//
// The typed confirm is painted from a preview — `useStorage` has a 30s
// staleTime, no polling and no focus refetch, and nothing refetches while the
// dialog is open — so the number under "Forget N rows of unbacked history?" can
// be arbitrarily old by the time the button is pressed. The route still re-runs
// the classifier and deletes what THAT fresh pass names (a renderer-held
// session list could never authorise a deletion); these two figures only bound
// it. Growth beyond what was shown is a 409: the user is asked again rather
// than having a larger deletion performed under a smaller sentence.
//
// Deliberately NOT a clamp. Truncating the fresh set to fit a row count would
// delete an arbitrary subset — the exact silent truncation ADR-0063 §1 refuses
// for the over-cap body.
export const storageForgetRequestSchema = z.object({
  unbackedRows: z.number().int().nonnegative(),
  sessionCount: z.number().int().nonnegative(),
});
export type StorageForgetRequest = z.infer<typeof storageForgetRequestSchema>;

export const storageForgetResponseSchema = z.object({
  sessionsRequested: z.number().int().nonnegative(),
  sessionsMatched: z.number().int().nonnegative(),
  rowsRemoved: z.number().int().nonnegative(),
});
export type StorageForgetResponse = z.infer<typeof storageForgetResponseSchema>;
