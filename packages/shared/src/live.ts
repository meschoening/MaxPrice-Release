import { z } from "zod";
import { usageConnectionSchema, usageSampleSchema } from "./usage-limits";
import { hubConnectionSchema } from "./hub";

// Wire contract for the Part 3 live data pipeline — the SSE channel the
// sidecar pushes over (`GET /api/stream`) and the status snapshot endpoint
// (`GET /api/status`). Shared so the sidecar's stream writer and the
// renderer's EventSource listeners validate against one definition.

// Event-type tags for the SSE channel. Single source of truth for the
// `LiveMessage` discriminants (apps/sidecar/src/live-hub.ts) and the renderer's
// `addEventListener` calls (apps/desktop/src/lib/live-stream.ts), so a typo
// can't drift the two apart. `heartbeat` is the hub's keep-alive message — the
// sidecar writes it as an SSE comment line, not a named event, so the renderer
// never listens for it by name.
export const SSE_EVENT = {
  usageNew: "usage:new",
  blockTick: "block:tick",
  statusChanged: "status:changed",
  heartbeat: "heartbeat",
  usageSample: "usage:sample",
  // Fleet machine directory changed (ADR-0041 M5): the sidecar re-emits the
  // hub's hub:machines poke (and its own cache refreshes) under this name so
  // the renderer can refetch GET /api/machines. Payload is empty — a poke,
  // never data.
  machinesChanged: "machines:changed",
  // Identity directory changed — refetch /api/project-identity and refold (ADR-0062).
  identityChanged: "identity:changed",
} as const;

// `usage:new` — emitted once per 500ms-debounced write window per JSONL file.
// `project` / `sessionId` come from the file path; `timestamp` / `count` from
// the tail-reader's opaque parse of the appended lines. The renderer treats
// this purely as a signal — it invalidates every report family wholesale (see
// apps/desktop/src/lib/live-stream.ts) rather than reading `timestamp`.
export const usageEventSchema = z.object({
  project: z.string(),
  sessionId: z.string(),
  timestamp: z.string(),
  count: z.number(),
});

// `block:tick` — emitted every 30s while a client is subscribed, so the active
// block's burn rate / projection refresh even with no new file activity.
export const blockTickEventSchema = z.object({
  timestamp: z.string(),
});

// `usage:sample` — emitted once per successful 1/min usage poll (ADR-0023/0024).
// Carries the authoritative live value so the renderer's rings update without
// polling the sidecar. null means a successful poll found no window in flight.
export const usageSampleEventSchema = usageSampleSchema.nullable();

// How a pricing refresh attempt failed (ADR-0053). Classified inside
// `refreshPricing` at the seam that failed, so the renderer can say something
// true about the cause instead of relaying a raw `Error.message`:
//   offline  the fetch itself rejected — no network, DNS, TLS, connection reset
//   timeout  our own AbortSignal.timeout fired (the only signal we pass)
//   http     the response arrived with a non-2xx status
//   payload  the body wasn't readable JSON, or held no Claude models
//   unknown  the outer catch-all backstop, e.g. the snapshot swap itself
export const pricingFailureKindSchema = z.enum([
  "offline",
  "timeout",
  "http",
  "payload",
  "unknown",
]);

// Pricing provenance + last-attempt outcome (ADR-0053), replacing the
// provenance-blind `pricingFreshAt`. One nested object, deliberately: `source`
// / `capturedAt` / `modelCount` all change at the same instant a refresh
// succeeds, and `patchStatus` spreads shallowly (live-hub.ts), so a nested
// object is replaced WHOLE — it structurally cannot half-update into a state
// that lies (`source: "fetched"` beside a vendored `capturedAt`). Same
// "always patches whole" property ADR-0041 M7 notes for `events`, here as the
// reason for the shape rather than a caveat about it.
export const pricingStatusSchema = z.object({
  // Which snapshot is ACTIVE right now. NOT derivable from `lastAttempt`: a
  // boot fetch that succeeded followed by a failed ~24h tick is `fetched` WITH
  // a failure — live prices, failing refresh.
  source: z.enum(["vendored", "fetched"]),
  // The active snapshot's own `capturedAt`. On `fetched` this equals the fetch
  // time exactly — `transformUpstreamPricing` stamps `capturedAt = fetchedAt`.
  // Its AGE is the real staleness signal (a failure count is a worse proxy).
  capturedAt: z.string(),
  // How many models the active snapshot prices. Must be on the wire: the
  // renderer has no snapshot, so it cannot derive this. Counted off the ACTIVE
  // snapshot, so it includes the ADR-0027 override gap-fill.
  modelCount: z.number().int().nonnegative(),
  // The most recent refresh ATTEMPT, success or failure. `null` = none has
  // settled yet (boot, before the startup refresh resolves). Ticks the ~24h
  // loop drops on its `inFlight` guard are NOT attempts — no fetch is issued,
  // and recording one would make a single hung fetch look like healthy
  // repeated activity.
  lastAttempt: z
    .object({
      at: z.string(),
      // `null` <=> the attempt succeeded. One bit, one representation — an
      // `ok` boolean beside this would be the same fact twice, able to
      // contradict itself.
      failure: z.object({ kind: pricingFailureKindSchema, detail: z.string() }).nullable(),
    })
    .nullable(),
});

// Saturation self-report (issue #116 / F4): the sidecar-owned verdict that
// its own event loop is starved, with the Loop lag window summary behind it.
// `saturated` is the ONLY field consumers may branch on — the renderer never
// re-derives it from the numbers (the trip statistic + hysteresis live with
// the sampler, calibrated against a real incident). `blockedPct` is the
// verdict statistic — the share of the window the loop spent inside
// synchronous blocks; `p50LagMs`/`maxLagMs` make the scheduling spread
// legible in one read (their divergence under a pegged core is the
// duty-cycle signature that retired the p50 as the verdict);
// `cpuPercent` (of one core) is the calibration channel against an external
// process-time reading; `windowMs` makes the numbers self-describing.
// Optional on `statusSnapshotSchema` below, where absent means UNKNOWN (a
// pre-F4 sidecar) — never healthy-by-default, matching `pricing` above — but
// the object always patches whole (the fleetEventsStatus rule), so its
// interior is strict: every field required, lags nonnegative.
//
// Declared here rather than inline in the status object because this IS the
// wire shape: the sidecar's sampler (apps/sidecar/src/saturation.ts) imports
// the inferred type instead of hand-writing a second copy, so an ADDED field
// cannot silently be stripped by this non-strict object on the way to the
// renderer's `safeParse`.
export const saturationSnapshotSchema = z.object({
  saturated: z.boolean(),
  blockedPct: z.number().nonnegative(),
  p50LagMs: z.number().nonnegative(),
  maxLagMs: z.number().nonnegative(),
  cpuPercent: z.number().nonnegative(),
  windowMs: z.number().positive(),
});
export type SaturationSnapshot = z.infer<typeof saturationSnapshotSchema>;

// Boot progress (ADR-0067, amending ADR-0047): what the engine's local boot is
// DOING, beside the `ready` bit that says whether it has finished. ADR-0047
// deliberately published one bit, and one bit is all a gate needs — but the
// splash it gates is the surface a user stares at for the whole cold boot, and
// a bit cannot distinguish "reading 1,253 files, 800 done" from "wedged".
//
// The sidecar reports only what it MEASURES. `filesParsed`/`filesTotal` are the
// initial scan's own counters — the walk already enumerates every file before
// parsing any of them (engine/store.ts), so the denominator costs nothing to
// publish. The renderer's own boot steps (waiting for the sidecar URL, the SSE
// handshake, Live's first paint) are renderer-side facts and are NOT on this
// wire; nothing here is estimated, smoothed, or extrapolated.
//
// One object, replaced WHOLE on every patch (the `pricing` / `fleetEventsStatus`
// rule) — `phase` and the counters change together, so a shallow merge that
// could pair a `merging` phase with a half-finished file count would be a shape
// that lies.
export const bootProgressSchema = z.object({
  // Which local boot source is being worked RIGHT NOW:
  //   scanning  the JSONL corpus walk — `filesParsed`/`filesTotal` are live
  //   merging   the corpus is parsed; the fleet replica file is still loading
  //   done      both local sources settled — rides the same frame as `ready`
  // Deliberately not an `enumerating` phase: the walk's pre-parse enumeration is
  // `scanning` with `filesTotal: 0`, which is the same "no denominator yet"
  // state a genuinely empty corpus is in, and both want the same rendering.
  phase: z.enum(["scanning", "merging", "done"]),
  // Files whose parse has SETTLED (a skipped unreadable file counts — it is
  // done being waited on), and how many the walk found. `filesTotal: 0` means
  // no denominator yet: still enumerating, or nothing to read.
  filesParsed: z.number().int().nonnegative(),
  filesTotal: z.number().int().nonnegative(),
  // Whether this client has a fleet replica to merge at all (ADR-0041) — i.e.
  // whether the `merging` phase will ever happen. Known from settings BEFORE
  // the scan starts and seeded into the boot status literal, so the renderer's
  // step list is complete on the FIRST frame it ever sees; a step that appeared
  // mid-boot would renormalize the bar under the user's eyes.
  mergesFleet: z.boolean(),
});
export type BootProgress = z.infer<typeof bootProgressSchema>;

// `status:changed` event payload AND the `GET /api/status` response body —
// one shape, one schema. `engineVersion` is the app's own version — the usage
// engine runs in-process, so the honest version to surface is the app's. It is
// baked into the renderer at Vite config time but arrives here from the
// sidecar binary, so a disagreement between the two means a stale
// `build:binaries` — which is why Settings' App info shows both.
//
// `hasData` (Part 6, Task 6.5) — whether the engine's event store holds any
// usage events at all, range-independent. The renderer's first-launch empty
// state needs to tell a genuinely empty corpus apart from a corpus whose data
// merely falls outside the current date-range filter; no other endpoint
// exposes an unfiltered signal (`/api/projects` even omits projects with no
// in-window event). It starts `false` on a fresh launch and flips to `true`
// the first time the watcher / initial scan ingests an event — broadcast as a
// `status:changed` frame so the renderer reacts live.
export const statusSnapshotSchema = z.object({
  watchedPaths: z.array(z.string()),
  engineVersion: z.string(),
  hasData: z.boolean(),
  // Pricing provenance (ADR-0053), replacing `pricingFreshAt`.
  //
  // `.optional()` here is FORCED, not stylistic. `handleStatusEvent` drops the
  // ENTIRE frame when this schema rejects it (live-stream.ts), and the boot
  // splash gates on `ready` arriving through that same frame (ADR-0047). A
  // REQUIRED `pricing` would therefore mean a renderer running against a stale
  // sidecar binary — one still emitting `pricingFreshAt` — parses no status
  // frame, never receives `ready`, and sits on the boot splash forever: a
  // bricked app, in exactly the condition Settings' Engine row exists to
  // diagnose. This is not a back-compat shim (the sidecar emits precisely one
  // shape); it is consumer parse tolerance for a skewed producer, word for word
  // what `ready`'s comment below justifies.
  //
  // `.optional()` rather than `.default(...)`: `ready` can default to `false`
  // because a concrete falsy value is honest, but there is no honest default
  // `capturedAt`. Absent must mean UNKNOWN, and the App info row says so.
  //
  // Strictness stops at the object boundary — every field inside is required
  // (with explicit nullables) because one helper inside the same binary builds
  // it. A partial interior is a bug, not version skew.
  pricing: pricingStatusSchema.optional(),
  // Usage-limits connection state for the subtle status indicator (ADR-0023).
  // `disconnected` until a credential is pushed and a poll succeeds.
  usageConnection: usageConnectionSchema,
  // ISO 8601 capturedAt of the last SUCCESSFUL usage poll; null until the first
  // poll succeeds (a later failing poll leaves the prior value in place).
  usageLastSampleAt: z.string().nullable(),
  // Sidecar→hub connection state (ADR-0035). `off` whenever no hub is
  // configured — the strictly-optional default.
  hubConnection: hubConnectionSchema,
  // Fleet replica seeding progress (ADR-0041 M5): non-null EXACTLY while the
  // pull loop is draining from cursor 0 (seeding — first connect, corruption
  // wipe, replica re-toggle, purge epoch bump). `cursor` = max seq applied to
  // the replica so far; `target` = the hub's latest durable watermark (clamped
  // as it moves). Rides existing status:changed frames — loopback-only, the
  // renderer derives its percent as clamp(cursor/target). Routine catch-up
  // never sets it.
  hubSeed: z
    .object({
      cursor: z.number().int().nonnegative(),
      target: z.number().int().nonnegative(),
    })
    .nullable(),
  // Pre-event-sync hub degrade (ADR-0041 M6): true while the CONNECTED hub does
  // not speak event sync (HubStatus.events absent at connect, or a 404 on an
  // event endpoint — the probe-don't-assume rule). Display-only: Settings shows
  // the amber "update MaxPrice Hub" line. Optional, absent-means-false, so every
  // pre-M6 frame and fixture parses unchanged (this is the monorepo-local
  // loopback contract — freely evolvable, the hubSeed channel).
  hubEventsDegraded: z.boolean().optional(),
  // Local-archive degrade (ADR-0069): true while this client's local archive
  // (`local-archive.jsonl`) could not be loaded or written — the app keeps
  // serving reports archive-less, and new history is NOT being made durable.
  // Display-only: Settings › Storage shows the amber line. Optional,
  // absent-means-false (the hubEventsDegraded channel — monorepo-local
  // loopback contract, freely evolvable).
  localArchiveDegraded: z.boolean().optional(),
  // Saturation self-report (issue #116 / F4) — shape and semantics documented
  // on `saturationSnapshotSchema` above. `.optional()` for the same skew
  // tolerance `pricing` carries: absent means UNKNOWN (a pre-F4 sidecar
  // binary), never healthy-by-default.
  saturation: saturationSnapshotSchema.optional(),
  // Boot readiness (ADR-0047): whether the LOCAL engine sources have settled —
  // the initial JSONL scan and the fleet-replica file load — never the network
  // (hub seeding, pricing refresh, and usage-history load stay background).
  // Seeded `false` at boot, patched `true` exactly once when `engineReady`
  // settles, riding a `status:changed` frame; the subscribe-frame carries it,
  // so late subscribers and reconnects get it for free. `ready && !hasData` is
  // the renderer's "scanned, genuinely empty" predicate — before `ready`, a
  // `hasData: false` frame only means the scan hasn't finished. Never cleared:
  // rescans (manual ⇧R, a claudePaths edit) are data updates, not boots.
  // Optional, defaulting to `false` when absent — tolerant like
  // `hubEventsDegraded` above, so a `ready`-less frame (a stale sidecar, a
  // skewed producer, a hand-built fixture) still parses and keeps its other
  // fields instead of being dropped whole.
  ready: z.boolean().default(false),
  // What the boot is doing while `ready` is still false (ADR-0067) — shape and
  // semantics on `bootProgressSchema` above.
  //
  // `.optional()` for the same skew tolerance `pricing` and `saturation` carry,
  // and here it is the field's own safety net as well as the frame's: the splash
  // reads this, so a renderer running against a pre-ADR-0067 sidecar must degrade
  // to ADR-0047's indeterminate splash — the composition that shipped — rather
  // than to a bar frozen at 0% that says the boot is wedged when it is fine.
  // Absent is the ONE input that makes the renderer draw no bar at all.
  bootProgress: bootProgressSchema.optional(),
});

export type UsageEvent = z.infer<typeof usageEventSchema>;
export type BlockTickEvent = z.infer<typeof blockTickEventSchema>;
export type UsageSampleEvent = z.infer<typeof usageSampleEventSchema>;
export type PricingFailureKind = z.infer<typeof pricingFailureKindSchema>;
export type PricingStatus = z.infer<typeof pricingStatusSchema>;
export type StatusSnapshot = z.infer<typeof statusSnapshotSchema>;

// What a PRODUCER must emit, as against what a CONSUMER must tolerate.
// `StatusSnapshot` is the consumer contract, and `pricing` is `.optional()`
// there for genuine version skew (ADR-0053 — see the field comment above: a
// rejected frame is dropped WHOLE and the boot splash gates on `ready` riding
// it). But one shared type serves both ends, so that tolerance would silently
// excuse the sidecar from emitting `pricing` at all: a future edit dropping the
// field from the boot literal would typecheck, pass the suite, and render
// Settings' App info row as an em dash on every shipped install, forever.
//
// So the obligation is stated separately and applied at the one seam that can
// discharge it — `CreateLiveHubOptions.initialStatus` (live-hub.ts), the only
// production site that mints a whole snapshot. Everything downstream is
// `patchStatus(Partial<…>)`, and both wire exits (`GET /api/status` and the
// `status:changed` broadcast) read that one object. `Required<Pick<…>>`'s `-?`
// strips the `| undefined` as well as the `?`, so the field is genuinely forced
// even under this repo's `exactOptionalPropertyTypes: false`.
// `saturation` rides the same producer obligation (issue #116 / F4): optional
// on the consumer type only for skew tolerance, but the boot literal must seed
// it — patchStatus merges, so an unseeded field would be absent from every
// frame until the first verdict edge, and the renderer's whole-frame handling
// would drop it between edges.
// `bootProgress` rides it too (ADR-0067), and for the sharpest version of the
// reason: the field's whole job is to be present BEFORE the first thing worth
// reporting happens, so an unseeded boot literal would leave the splash on its
// no-progress degrade for precisely the launches — the slow ones — the feature
// exists for, and every test would still pass.
export type EmittedStatusSnapshot = StatusSnapshot &
  Required<Pick<StatusSnapshot, "pricing" | "saturation" | "bootProgress">>;
