// Exported via a package.json subpath solely for the sidecar fleet test rig (apps/sidecar/src/test-hub.ts) — keep signatures stable, a cross-app test contract.
import { Hono } from "hono";
import type { Context } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { streamSSEPump } from "@maxprice/usage-core";
import {
  EVENT_PULL_LIMIT_MAX,
  HUB_SSE_EVENT,
  PROJECT_IDENTITY_PATH,
  hubEventsForgetRequestSchema,
  hubEventsPushRequestSchema,
  hubMachineMergeRequestSchema,
  hubMachineRenameRequestSchema,
  hubPasswordSetRequestSchema,
  hubProjectIdentityPushRequestSchema,
  hubSamplesPushRequestSchema,
  sessionPairKey,
  usageCredentialSchema,
  type CredentialAck,
  type ErrorResponse,
  type HubClientsResponse,
  type HubEventsForgetResponse,
  type HubEventsPullResponse,
  type HubEventsPushResponse,
  type HubMachinesResponse,
  type HubProjectIdentityResponse,
  type HubSamplesResponse,
  type HubSamplesPushResponse,
  type HubStatus,
  type UsageCredential,
  type UsageSample,
} from "@maxprice/shared";
import type { FleetEventStore, IdentityDirectory } from "@maxprice/usage-core";
import { createClientRegistry, type ClientRegistry } from "./clients";
import type { HubFanout } from "./fanout";
import type { MachineDirectory } from "./machine-directory";

// The hub's HTTP surface (ADR-0035). Optional-password gated (ADR-0037) except
// /healthz — transport encryption + machine identity come from the tailnet
// (WireGuard); the password is defense-in-depth. No Host-header guard: unlike
// the sidecar's loopback-only DNS-rebinding posture, the hub serves non-loopback
// interfaces by design and the auth gate already covers every data route. A
// default-open hub still binds loopback, though, so a CSRF Origin guard (below)
// rejects the cross-origin browser POST/PUT/DELETE/PATCH the open auth gate can't.
export type BuildHubAppDeps = {
  // Auth gate (ADR-0037): optional-password verify — see auth.ts. Tests inject
  // a createHubAuth instance directly.
  auth: { verify: (authorizationHeader: string | undefined) => Promise<boolean> };
  // Applies a password set/clear end-to-end: hash + persist + gate swap +
  // status patch. index.ts owns that wiring.
  setPassword: (password: string | null) => Promise<void>;
  fanout: HubFanout;
  samples: () => UsageSample[];
  // Push-up merge (ADR-0035 M2): capturedAt-keyed set union into the hub's
  // store; returns how many were new. The impl (index.ts) also patches the
  // fanout status so subscribers see the store grow.
  mergeSamples: (incoming: UsageSample[]) => number;
  usage: {
    setCredential: (c: UsageCredential | null) => void;
    pollOnce: () => Promise<void>;
  };
  // Writes through the credstore (OS keychain via the Rust helper). Failures
  // surface as a 500 — the caller (a Settings push) should see them.
  persistCredential: (c: UsageCredential | null) => Promise<void>;
  // Connected-client registry (ADR-0036). Optional: buildHubApp constructs its
  // own if omitted, so existing tests/call sites stay green. index.ts passes the
  // production instance.
  registry?: ClientRegistry;
  // Browser CORS allowlist for the operator webview (ADR-0036, overview §9).
  // Optional: omitted/empty ⇒ NO CORS mounted (headless serve, remote sidecars —
  // non-browser, unchanged). index.ts populates it only when embedded.
  allowedOrigins?: string[];
  // Boot-readiness gate (F1): a promise that resolves once the hub's on-disk
  // history is loaded, the persisted credential is seeded, and the poller is
  // started. When supplied, EVERY /api/* route awaits it before running, so
  // clients never see a half-loaded store or a not-yet-seeded credential during
  // the boot window. Optional: omitted (tests, remote sidecars) ⇒ no gate,
  // pre-F1 behavior. index.ts guarantees it never rejects.
  ready?: Promise<void>;
  // Fleet event archive (ADR-0041, M4). Optional: absent ⇒ the event routes
  // are not mounted and probing clients get the pre-event-sync 404 degrade
  // (the samples-push precedent) — existing tests/call sites stay green.
  fleetEvents?: FleetEventStore;
  // Archive HEALTH, evaluated PER REQUEST (F3). A failed `fleetEvents.load()` is
  // logged and swallowed at boot (the daemon must still poll usage limits), and
  // serve() builds this app BEFORE that load has even been attempted — so
  // "the store exists but is unusable" cannot be expressed by withholding
  // `fleetEvents`, and must be asked at request time. False ⇒ the /api/events
  // push+pull and every ARCHIVE MUTATION (machine rename/merge/purge, compact)
  // answer 503. That is the load-bearing half: `rewrite()` writes RAM's
  // survivors over the on-disk log, so a compact or a purge against a store
  // that never loaded is a truncation. 503 (health), NOT 404 (capability) —
  // the route still EXISTS, i.e. this daemon speaks event sync, which is
  // ADR-0041's contract and exactly what the client's 404 degrade reads.
  // Optional: omitted ⇒ always usable (tests, remote sidecars).
  eventsUsable?: () => boolean;
  // Machine directory (ADR-0041, M4). Optional like fleetEvents: absent ⇒ no
  // /api/machines surface (pre-event-sync shape) and no implicit registration.
  machineDirectory?: MachineDirectory;
  // Identity directory (ADR-0062). Optional like machineDirectory — absent ⇒ the
  // routes 404 and a pre-identity client just stays local-only. CALLER
  // OBLIGATION: pass it only while `usable()` — a store whose file did not fully
  // load (unreadable OR corrupt) holds a FRAGMENT in RAM, and serving that as
  // the union is what every client's pull reads as a purge. That is why this is
  // a build-time gate and not a request-time predicate like eventsUsable():
  // nothing re-attempts the load, so the answer cannot change within a run.
  // serve() makes the call.
  identityDirectory?: IdentityDirectory;
  // …and this is how serve() tells us WHY it withheld the store. Withholding is
  // overloaded — a pre-identity-shaped caller (every older test hub) legitimately
  // passes nothing — so `identityDirectory === undefined` alone cannot
  // distinguish "this hub does not do identity" from "this hub's identity file
  // is broken". Only the machine-purge cascade needs the difference, and only to
  // log it. Absent ⇒ not degraded, i.e. genuinely capability-free.
  identityDegraded?: () => boolean;
  // Wall-clock for the lastPushAt stamps (M7). Injectable for tests; the
  // stamps are in-memory since-daemon-start, the roster's exact posture.
  nowImpl?: () => string;
};

// The FULL HubStatus.events object (ADR-0041 M7). fanout.patchStatus merges
// shallowly at the TOP level — a nested `events` patch REPLACES the whole
// object — so every events patch must go through this composer or the
// {epoch, seq} capability gate corrupts (MERGE, never replace).
export function fleetEventsStatus(store: FleetEventStore): NonNullable<HubStatus["events"]> {
  return {
    epoch: store.epoch(),
    seq: store.durableSeq(),
    eventCount: store.size(),
    fileBytes: store.fileBytes(),
    garbageLines: store.garbageLines(),
    reclaimableBytes: store.reclaimableBytes(),
    unreadableLines: store.unreadableLines(),
    lastAppendAt: store.lastAppendAt(),
  };
}

// Bun passes its Server as the Hono fetch `env`; `requestIP` resolves the
// client's socket address. Absent under Hono's app.request() test harness (→
// null), and any failure degrades to null — the roster's remoteAddr is
// best-effort (tailnet/loopback IP when resolvable).
function remoteAddrOf(c: Context): string | null {
  const server = c.env as { requestIP?: (req: Request) => { address: string } | null } | undefined;
  try {
    return server?.requestIP?.(c.req.raw)?.address ?? null;
  } catch {
    return null;
  }
}

// Shared by the self-rename PUT and the console rename POST: trim, reject
// empty, cap at cleanHostname's 63-char registration ceiling. Returns the
// cleaned name or null (⇒ 400).
function parseRenameName(raw: unknown): string | null {
  const parsed = hubMachineRenameRequestSchema.safeParse(raw);
  const name = parsed.success ? parsed.data.name.trim() : "";
  if (name === "" || name.length > 63) return null;
  return name;
}

export function buildHubApp(deps: BuildHubAppDeps): Hono {
  const app = new Hono();
  const registry = deps.registry ?? createClientRegistry();
  const nowIso = deps.nowImpl ?? (() => new Date().toISOString());
  // Archive health predicate + its pinned 503 envelope (F3). Absent dep ⇒
  // always usable. The copy names the remedy: nothing re-attempts the load, so
  // a restart is the only cure (the same contract as the console's inset).
  const eventsUsable = deps.eventsUsable ?? (() => true);
  const identityDegraded = deps.identityDegraded ?? (() => false);
  const ARCHIVE_UNAVAILABLE: ErrorResponse = {
    error: "fleet event archive failed to load — restart the hub",
  };
  // machineId → ISO of its last POST /api/events THIS daemon run (M7). Never on
  // the frozen /api/clients wire; joined onto GET /api/machines. In-memory by
  // design — null after a restart until the machine pushes again (the console
  // copy is honest about that: posture derives from it plus eventCount).
  const lastPushByMachine = new Map<string, string>();

  // Browser preflight must clear BEFORE the auth gate — an OPTIONS preflight
  // carries no Authorization header, so the auth middleware would 401 it. Only
  // mounted when the embedding shell supplied origins; absent ⇒ no CORS, the
  // pre-M3 behavior (overview §9). Auth is untouched: CORS governs the browser
  // preflight, not the auth check.
  const allowedOrigins = deps.allowedOrigins ?? [];
  if (allowedOrigins.length > 0) {
    app.use(
      "/api/*",
      cors({
        origin: allowedOrigins,
        allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
        allowHeaders: [
          "Authorization",
          "content-type",
          "x-maxprice-machine",
          "x-maxprice-hostname",
        ],
      }),
    );
  }

  // CSRF Origin guard (Finding #1): a default-open hub (auth.ts returns true
  // when no password is set) binds loopback + tailnet, so a web page the
  // operator merely visits could fire CORS-simple cross-origin POSTs at a
  // mutating route that needs no custom header (POST /api/credential,
  // /api/password, /api/samples — none preflight-shielded). Reject any
  // STATE-CHANGING request carrying a browser `Origin` NOT in the operator
  // allowlist. A request with NO Origin passes: every non-browser fleet client
  // (server-side fetch) and the sidecar auto-heal POST /api/credential
  // (x-maxprice-machine, no Origin). The operator console's own origin is in
  // `allowedOrigins`. GET/HEAD/OPTIONS are never guarded — OPTIONS is the CORS
  // preflight (already handled above) and reads carry no side effect. Runs
  // before auth so a cross-origin attempt is a clean 403 whatever the gate.
  const STATE_CHANGING = new Set(["POST", "PUT", "DELETE", "PATCH"]);
  app.use("/api/*", async (c, next) => {
    const origin = c.req.header("origin");
    if (
      origin !== undefined &&
      STATE_CHANGING.has(c.req.method) &&
      !allowedOrigins.includes(origin)
    ) {
      const body: ErrorResponse = { error: "cross-origin request rejected" };
      return c.json(body, 403);
    }
    return next();
  });

  app.get("/healthz", (c) => c.json({ ok: true, service: "maxprice-hub" }));

  // Optional-password auth on everything else (ADR-0037; see auth.ts): open
  // hub ⇒ every request passes, presented credentials ignored; protected hub ⇒
  // Bearer <password> or the console's operator secret.
  app.use("/api/*", async (c, next) => {
    if (!(await deps.auth.verify(c.req.header("authorization")))) {
      const body: ErrorResponse = { error: "unauthorized" };
      return c.json(body, 401);
    }
    return next();
  });

  // Boot-readiness gate (F1): every authenticated /api/* handler — /api/status
  // included — parks here until the hub has loaded its history and seeded the
  // credential. This is what closes the auto-heal race: the seed's keychain
  // read (inside `ready`) always precedes any heal POST's credential write,
  // because that POST cannot enter its handler until `ready` resolves. Mounted
  // only when serve() supplies `ready`; absent ⇒ no gate (tests, remote
  // sidecars). `ready` never rejects (index.ts wraps it), so this never throws.
  const ready = deps.ready;
  if (ready !== undefined) {
    app.use("/api/*", async (_c, next) => {
      await ready;
      return next();
    });
  }

  // Record every AUTHENTICATED /api/* request that identifies its machine (this
  // runs after the auth guard, so only valid clients enter the roster). A
  // fleet client is defined by its x-maxprice-machine id; a header-less request —
  // the operator console's own loopback calls, or an ad-hoc curl — is
  // authenticated but is NOT a fleet member, so it never enters the roster. The
  // x-maxprice-hostname label and the socket IP are best-effort. ADR-0036.
  app.use("/api/*", async (c, next) => {
    const machineId = c.req.header("x-maxprice-machine");
    if (machineId) {
      const hostname = c.req.header("x-maxprice-hostname") ?? null;
      registry.recordRequest(machineId, hostname, remoteAddrOf(c));
      // Implicit directory registration (ADR-0041): any authenticated contact
      // from an unknown machine writes an entry — name frozen at first sight.
      // Only a NEW registration pokes (the directory is otherwise unchanged).
      if (deps.machineDirectory?.ensureRegistered(machineId, hostname) === true) {
        deps.fanout.emitMachinesPoke();
      }
    }
    return next();
  });

  app.onError((err, c) => {
    console.error("[hub] route error:", err);
    const body: ErrorResponse = { error: "internal" };
    return c.json(body, 500);
  });

  app.get("/api/status", (c) => c.json(deps.fanout.getStatus()));

  // Connected-clients roster (ADR-0036) — bearer-gated like every /api/*. live
  // first, then most-recently-seen (the registry sorts; the console re-sorts).
  app.get("/api/clients", (c) => {
    const body: HubClientsResponse = { clients: registry.list() };
    return c.json(body);
  });

  // Set / clear the hub password (ADR-0037). Gated like every /api/* route: on
  // an open hub anyone who can reach it can set a password (tailnet-trust, the
  // same as every other write); on a protected hub the current password or the
  // operator secret is required. The console is the intended writer; the value
  // is write-only — status only ever reports passwordProtected.
  app.post("/api/password", async (c) => {
    const raw: unknown = await c.req.json().catch(() => null);
    const parsed = hubPasswordSetRequestSchema.safeParse(raw);
    if (!parsed.success) {
      const body: ErrorResponse = { error: "invalid password payload" };
      return c.json(body, 400);
    }
    await deps.setPassword(parsed.data.password);
    return c.json({ ok: true } satisfies CredentialAck);
  });

  // Backfill: every sample strictly after `since` (capturedAt), ascending.
  // The store keeps its array sorted, so this is a filter, not a sort.
  app.get("/api/samples", (c) => {
    const since = c.req.query("since");
    if (since !== undefined && Number.isNaN(Date.parse(since))) {
      const body: ErrorResponse = { error: `invalid since (expected ISO timestamp): ${since}` };
      return c.json(body, 400);
    }
    const all = deps.samples();
    // capturedAt is canonical ISO-8601 UTC and the store keeps the array sorted
    // by it, so a lexicographic compare is order-equivalent to a numeric one —
    // without re-parsing every sample on each backfill. But `since` may arrive
    // in a non-canonical-but-valid form (an offset like 22:00+02:00 == 20:00Z),
    // which would compare WRONG lexicographically, so canonicalize it to the
    // same toISOString() shape first (a no-op for already-canonical input) (F15).
    const canonical = since === undefined ? undefined : new Date(since).toISOString();
    const body: HubSamplesResponse = {
      samples: canonical === undefined ? all : all.filter((s) => s.capturedAt > canonical),
    };
    return c.json(body);
  });

  // Push-up merge (ADR-0035 M2): the client's half of the two-way sync. The
  // store dedups on capturedAt, so replays and overlaps are harmless.
  // Deliberately NOT fanned out to live SSE clients: pushed batches are
  // historical (each machine's own fallback samples cover the same wall-clock
  // period its peers covered for themselves), and a large seed push would blow
  // the SSE write-chain bound. Other replicas converge on coverage, not on
  // byte-identical sample sets.
  app.post("/api/samples", async (c) => {
    const raw: unknown = await c.req.json().catch(() => null);
    const parsed = hubSamplesPushRequestSchema.safeParse(raw);
    if (!parsed.success) {
      const body: ErrorResponse = { error: "invalid samples payload" };
      return c.json(body, 400);
    }
    const body: HubSamplesPushResponse = { added: deps.mergeSamples(parsed.data.samples) };
    return c.json(body);
  });

  // Fleet event sync (ADR-0041, M4): push/pull against the hub's archive of
  // record. Both routes exist only when serve() supplied the store — a
  // pre-event-sync-shaped hub (tests, degrade probes) 404s them.
  const fleetEvents = deps.fleetEvents;
  if (fleetEvents !== undefined) {
    // Push: ≤1000 NATIVE rows in; the hub mints seq + machineId at the accept
    // point (a client structurally cannot mis-attribute rows), acks only
    // after fsync (the store's contract), losers stamped with the incumbent's
    // seq. The status patch + SSE poke fire post-flush and only when the
    // store actually grew (mirrors mergeSamples' added>0 gate).
    app.post("/api/events", async (c) => {
      if (!eventsUsable()) return c.json(ARCHIVE_UNAVAILABLE, 503);
      const machineId = c.req.header("x-maxprice-machine");
      if (machineId === undefined || machineId === "") {
        const body: ErrorResponse = {
          error: "missing x-maxprice-machine header (the hub mints machineId from it)",
        };
        return c.json(body, 400);
      }
      const raw: unknown = await c.req.json().catch(() => null);
      const parsed = hubEventsPushRequestSchema.safeParse(raw);
      if (!parsed.success) {
        const body: ErrorResponse = { error: "invalid events payload" };
        return c.json(body, 400);
      }
      const ack = await fleetEvents.push(parsed.data.events, machineId);
      // Any successful ack proves this machine is sharing — losers included.
      lastPushByMachine.set(machineId, nowIso());
      if (ack.added > 0) {
        deps.fanout.patchStatus({ events: fleetEventsStatus(fleetEvents) });
        deps.fanout.emitEventsPoke(fleetEvents.durableSeq());
      }
      return c.json(ack satisfies HubEventsPushResponse);
    });

    // Pull: one cursor-paged loop client-side — seq-ascending rows strictly
    // after `since`, up to the DURABLE watermark only, `limit` clamped.
    // Caught-up = a short page; the epoch rides every envelope (the resync
    // sentinel).
    app.get("/api/events", (c) => {
      if (!eventsUsable()) return c.json(ARCHIVE_UNAVAILABLE, 503);
      const sinceRaw = c.req.query("since");
      const since = sinceRaw === undefined ? 0 : Number(sinceRaw);
      if (!Number.isInteger(since) || since < 0) {
        const body: ErrorResponse = { error: `invalid since (expected seq >= 0): ${sinceRaw}` };
        return c.json(body, 400);
      }
      const limitRaw = c.req.query("limit");
      const limit = limitRaw === undefined ? EVENT_PULL_LIMIT_MAX : Number(limitRaw);
      if (!Number.isInteger(limit) || limit < 1) {
        const body: ErrorResponse = { error: `invalid limit (expected int >= 1): ${limitRaw}` };
        return c.json(body, 400);
      }
      const body: HubEventsPullResponse = fleetEvents.page(
        since,
        Math.min(limit, EVENT_PULL_LIMIT_MAX),
      );
      return c.json(body);
    });

    // Client-initiated forgetting (ADR-0063): a machine drops its OWN rows for
    // sessions its local corpus no longer backs. The first archive mutation not
    // driven by the operator — deliberately here, beside push and pull, rather
    // than among the operator-token console routes under /api/machines.
    // Deliberately NOT gated on machineDirectory: forget mutates no directory
    // state, and a hub whose directory file failed to load should not 404 it.
    app.post("/api/events/forget", async (c) => {
      // (1) 503 before ANY work — rewrite() writes RAM's survivors over the log,
      //     so forgetting against a store that failed to load would truncate it.
      //     Identical hazard to DELETE /api/machines/:id and POST /api/store/compact.
      if (!eventsUsable()) return c.json(ARCHIVE_UNAVAILABLE, 503);
      // (2) attribution — mirrors POST /api/events. No directory-membership
      //     check: the recordRequest middleware implicitly registers any
      //     authenticated contact, so the caller is in the directory by
      //     construction (the purge's 404 exists because ITS :id is an
      //     arbitrary operator-supplied id, not a connection property).
      const machineId = c.req.header("x-maxprice-machine");
      if (machineId === undefined || machineId === "") {
        const body: ErrorResponse = {
          error: "missing x-maxprice-machine header (forget is scoped to the caller)",
        };
        return c.json(body, 400);
      }
      // (3) body. Over-cap is a schema failure ⇒ 400 with nothing rewritten,
      //     never a truncation of the caller's intent.
      const raw: unknown = await c.req.json().catch(() => null);
      const parsed = hubEventsForgetRequestSchema.safeParse(raw);
      if (!parsed.success) {
        const body: ErrorResponse = { error: "invalid forget payload" };
        return c.json(body, 400);
      }
      // Scope is a BYTE comparison against the id the hub itself minted at push
      // time — never alias-resolved. M7 merge is metadata-only (no event is ever
      // rewritten), so a merged-away machine's rows keep their original
      // machineId forever and are reachable only by the operator purge.
      // Alias-closure would make delete authority a function of mutable
      // directory state an operator edits from a console — exactly the
      // widening this guard exists to prevent.
      const named = new Set(
        parsed.data.sessions.map((s) => sessionPairKey(s.projectSlug, s.sessionId)),
      );
      // Pre-scan before rewriting: rewrite({ newEpoch: true }) mints a fresh
      // epoch unconditionally, and an epoch bump forces EVERY client in the
      // fleet to unlink its replica and reseed from seq 0. A forget that
      // matches nothing is a NORMAL outcome (ADR-0063's Consequences names
      // "rows were already gone" as an expected race), so it must cost the
      // fleet nothing: no rewrite, no epoch, no status patch — the CURRENT
      // epoch and two zeroes. Costs one extra O(archive) scan on the matching
      // path, which then rewrites the whole archive anyway.
      //
      // The window between this scan and the rewrite is unlocked: a matching
      // row pushed in between is missed and survives. That is the SAME race
      // `removed` already reports against — a forget is a point-in-time
      // statement about rows the caller had already stopped backing — so it
      // wants this comment rather than a lock. The client re-forgets on its
      // next pass.
      const matched = new Set<string>();
      let matchedRows = 0;
      for (const row of fleetEvents.all()) {
        if (row.machineId !== machineId) continue;
        const key = sessionPairKey(row.projectSlug, row.sessionId);
        if (!named.has(key)) continue;
        matched.add(key);
        matchedRows += 1;
      }
      if (matchedRows === 0) {
        const body: HubEventsForgetResponse = {
          epoch: fleetEvents.epoch(),
          removed: 0,
          sessionsMatched: 0,
        };
        return c.json(body);
      }
      const { droppedRows } = await fleetEvents.rewrite({
        keep: (row) => {
          if (row.machineId !== machineId) return true;
          return !named.has(sessionPairKey(row.projectSlug, row.sessionId));
        },
        newEpoch: true,
      });
      // No emitEventsPoke: the poke carries the durable watermark, which a
      // forget leaves unchanged or LOWERS, and ADR-0055's clients pull only when
      // the advertised seq is HIGHER — a poke would be a wire event every peer
      // correctly ignores. Peers converge on the 5-min sweep, exactly as they
      // already do after a purge. No identity cascade either: forget removes
      // HISTORY for sessions whose checkout may still exist and still be probed.
      deps.fanout.patchStatus({ events: fleetEventsStatus(fleetEvents) });
      const body: HubEventsForgetResponse = {
        epoch: fleetEvents.epoch(),
        removed: droppedRows,
        sessionsMatched: matched.size,
      };
      return c.json(body);
    });
  }

  // Machine directory (ADR-0041, M4): the fleet roster of record. Mounted only
  // when serve() supplied the directory — a pre-event-sync-shaped hub (tests,
  // degrade probes) 404s these, and implicit registration is likewise off.
  const machineDirectory = deps.machineDirectory;
  if (machineDirectory !== undefined) {
    // The directory view, joined (M7): directory ∪ roster (live/lastSeenAt) ∪
    // store aggregates (eventCount/lastEventAt) ∪ lastPushAt. One row per
    // directory entry; every join field is .optional() on hubMachineSchema so
    // an M4/M5 consumer parses unchanged. fleetEvents.all() returns internal
    // refs — read-only here, never mutated.
    //
    // The per-machine stats map is an O(archive) scan, and this route is hit
    // every 5s by the console AND by every sidecar on each hub:machines poke, so
    // memoize it (Finding #7) keyed on `${epoch}:${durableSeq}`. durableSeq
    // ALONE was wrong: it only moves when the TAIL changes, so any rewrite that
    // drops older rows and leaves the max-seq row standing served stale
    // eventCounts — the shipped purge whenever the purged machine was not the
    // latest pusher, and every ADR-0063 forget by a machine that is not (a
    // forget targets rows old enough to have lost their transcripts, so this is
    // the COMMON case, not the rare one). The composite key is correct for all
    // three mutations: forget and purge bump the epoch (bust), compact preserves
    // epoch AND durableSeq and genuinely leaves live rows untouched (valid).
    // lastPushAt is joined LIVE below and is never part of this cached map.
    let statsMemo: {
      key: string;
      stats: Map<string, { count: number; lastEventAt: string }>;
    } | null = null;
    app.get("/api/machines", (c) => {
      const roster = new Map(registry.list().map((r) => [r.machineId, r]));
      let stats = new Map<string, { count: number; lastEventAt: string }>();
      if (fleetEvents !== undefined) {
        const key = `${fleetEvents.epoch()}:${fleetEvents.durableSeq()}`;
        if (statsMemo === null || statsMemo.key !== key) {
          const rebuilt = new Map<string, { count: number; lastEventAt: string }>();
          for (const row of fleetEvents.all()) {
            const s = rebuilt.get(row.machineId);
            if (s === undefined)
              rebuilt.set(row.machineId, { count: 1, lastEventAt: row.timestamp });
            else {
              s.count += 1;
              if (row.timestamp > s.lastEventAt) s.lastEventAt = row.timestamp;
            }
          }
          statsMemo = { key, stats: rebuilt };
        }
        stats = statsMemo.stats;
      }
      const body: HubMachinesResponse = {
        machines: machineDirectory.list().map((m) => {
          const r = roster.get(m.machineId);
          const s = stats.get(m.machineId);
          return {
            ...m,
            live: r?.live ?? false,
            lastSeenAt: r?.lastSeenAt ?? null,
            eventCount: s?.count ?? 0,
            lastEventAt: s?.lastEventAt ?? null,
            lastPushAt: lastPushByMachine.get(m.machineId) ?? null,
          };
        }),
      };
      return c.json(body);
    });

    // Self-rename (ADR-0041): a machine renames only ITSELF — the hub
    // enforces :id = the connection's x-maxprice-machine (console rename-any
    // is M7's POST /api/machines/:id/name). Uniqueness is write-time and
    // case-insensitive → 409 pinned envelope on collision.
    app.put("/api/machines/:id", async (c) => {
      const machineId = c.req.header("x-maxprice-machine");
      const id = c.req.param("id");
      if (machineId === undefined || machineId === "" || machineId !== id) {
        const body: ErrorResponse = { error: "forbidden: not this connection's machine" };
        return c.json(body, 403);
      }
      // Trim + empty/63-char ceiling via the shared helper (cleanHostname's
      // registration cap) — one source of truth with the console rename POST.
      // The wire schema stays a locked z.string().min(1); the ceiling lives here.
      const name = parseRenameName(await c.req.json().catch(() => null));
      if (name === null) {
        const body: ErrorResponse = { error: "invalid rename payload" };
        return c.json(body, 400);
      }
      const result = machineDirectory.rename(id, name);
      if (result === "collision") {
        const body: ErrorResponse = { error: `name already in use: ${name}` };
        return c.json(body, 409);
      }
      if (result === "unknown") {
        // Defensive — the registration middleware enrolled this machine on
        // this very request, so this is unreachable in practice.
        const body: ErrorResponse = { error: "unknown machine" };
        return c.json(body, 404);
      }
      deps.fanout.emitMachinesPoke();
      return c.json({ ok: true } satisfies CredentialAck);
    });

    // Console rename (M7): rename ANY machine — the operator surface (the PUT
    // above stays the client SELF-rename). Same validation ceiling.
    //
    // The M7 OPERATOR mutations below (rename, merge, and the purge/compact in
    // the next block) all 503 while the archive is unusable (F3): the console's
    // Machines card is a directory ∪ ARCHIVE join, so with no archive loaded the
    // operator would be acting on rows whose event counts all read zero. The M4
    // client self-rename PUT above is deliberately NOT gated — it is directory
    // metadata a machine writes about itself, with no archive in the loop.
    app.post("/api/machines/:id/name", async (c) => {
      if (!eventsUsable()) return c.json(ARCHIVE_UNAVAILABLE, 503);
      const id = c.req.param("id");
      const name = parseRenameName(await c.req.json().catch(() => null));
      if (name === null) {
        const body: ErrorResponse = { error: "invalid rename payload" };
        return c.json(body, 400);
      }
      const result = machineDirectory.rename(id, name);
      if (result === "collision") {
        // Report the EXISTING conflicting name (the one actually in use), not
        // the submitted casing — uniqueness is case-insensitive, so a "STUDIO"
        // that clashes with "studio" should name "studio".
        const inUse =
          machineDirectory
            .list()
            .find((m) => m.machineId !== id && m.name.toLowerCase() === name.toLowerCase())?.name ??
          name;
        const body: ErrorResponse = { error: `name already in use: ${inUse}` };
        return c.json(body, 409);
      }
      if (result === "unknown") {
        const body: ErrorResponse = { error: "unknown machine" };
        return c.json(body, 404);
      }
      deps.fanout.emitMachinesPoke();
      return c.json({ ok: true } satisfies CredentialAck);
    });

    // Console merge (M7): mark :id an alias of `into` — metadata only, no event
    // is ever rewritten; resolution is transitive and renderer-side.
    app.post("/api/machines/:id/merge", async (c) => {
      if (!eventsUsable()) return c.json(ARCHIVE_UNAVAILABLE, 503);
      const id = c.req.param("id");
      const raw: unknown = await c.req.json().catch(() => null);
      const parsed = hubMachineMergeRequestSchema.safeParse(raw);
      if (!parsed.success) {
        const body: ErrorResponse = { error: "invalid merge payload" };
        return c.json(body, 400);
      }
      const result = machineDirectory.merge(id, parsed.data.into);
      if (result === "unknown-source" || result === "unknown-target") {
        const body: ErrorResponse = {
          error: `unknown machine: ${result === "unknown-source" ? id : parsed.data.into}`,
        };
        return c.json(body, 404);
      }
      if (result === "self") {
        const body: ErrorResponse = { error: "cannot merge a machine into itself" };
        return c.json(body, 400);
      }
      if (result === "cycle") {
        const body: ErrorResponse = { error: "merge would create an alias cycle" };
        return c.json(body, 409);
      }
      deps.fanout.emitMachinesPoke();
      return c.json({ ok: true } satisfies CredentialAck);
    });
  }

  // Identity directory (ADR-0062 §4): additive under protocol v1 — clients
  // 404-probe. GET returns the fleet union; POST accepts a machine's OWN rows
  // and assertions (attribution comes from the header, exactly like the events
  // push).
  const identityDirectory = deps.identityDirectory;
  if (identityDirectory !== undefined) {
    app.get(PROJECT_IDENTITY_PATH, (c) => {
      const body: HubProjectIdentityResponse = {
        rows: identityDirectory.list(),
        assertions: identityDirectory.listAssertions(),
      };
      return c.json(body);
    });

    app.post(PROJECT_IDENTITY_PATH, async (c) => {
      const machineId = c.req.header("x-maxprice-machine");
      if (machineId === undefined || machineId === "") {
        const body: ErrorResponse = {
          error: "missing x-maxprice-machine header (identity rows are attributed to the caller)",
        };
        return c.json(body, 400);
      }
      const raw: unknown = await c.req.json().catch(() => null);
      const parsed = hubProjectIdentityPushRequestSchema.safeParse(raw);
      if (!parsed.success) {
        const body: ErrorResponse = { error: "invalid identity payload" };
        return c.json(body, 400);
      }
      // Rows of machine M are authored only by M — foreign rows are dropped, not
      // an error (a client legitimately holds mirrored rows it must never push).
      const own = parsed.data.rows.filter((r) => r.machineId === machineId);
      const ownAssertions = parsed.data.assertions.filter(
        (assertion) => assertion.authorMachineId === machineId,
      );
      identityDirectory.upsert(own);
      identityDirectory.upsertAssertions(ownAssertions);
      return c.json({ merged: own.length + ownAssertions.length });
    });
  }

  // Archive operations (ADR-0041 M7): the explicit operator forgetting surface.
  // Purge = the log rewrite with an epoch bump — every existing invariant then
  // propagates it for free (mismatch → replica unlink + reseed → stamps clear →
  // re-push). Compact = the SAME rewrite, epoch-preserving — invisible on the
  // wire. Mounted only when both the store and the directory exist.
  if (fleetEvents !== undefined && machineDirectory !== undefined) {
    app.delete("/api/machines/:id", async (c) => {
      // 503 before ANY work (F3): rewrite() writes RAM's survivors over the log,
      // so a purge against a store that failed to load would truncate it.
      if (!eventsUsable()) return c.json(ARCHIVE_UNAVAILABLE, 503);
      const id = c.req.param("id");
      if (!machineDirectory.has(id)) {
        const body: ErrorResponse = { error: "unknown machine" };
        return c.json(body, 404);
      }
      // Store first, directory second: if the directory write failed after the
      // rewrite, a zero-row entry survives (benign, re-purgeable) — the inverse
      // order could orphan rows under a name that no longer exists.
      await fleetEvents.rewrite({ keep: (row) => row.machineId !== id, newEpoch: true });
      machineDirectory.remove(id);
      // ADR-0062 §4: purge cascades to identity rows; clients drop them on their
      // next pull. When serve() withheld the store because the identity file did
      // not load, that cascade cannot happen — and the resulting partial state is
      // UNREPAIRABLE, because both purge paths look the machine up in the machine
      // directory first and the lines above have already removed it: once the
      // file is readable again a re-purge answers 404 "unknown machine" while the
      // stale rows keep serving and mirroring fleet-wide. Log-only all the same
      // (the offline CLI's pinned posture): the archive + directory halves DID
      // succeed, and 503-ing after them would leave a worse partial state.
      if (identityDirectory !== undefined) {
        identityDirectory.removeMachine(id);
      } else if (identityDegraded()) {
        console.error(
          `[hub] identity rows for ${id} were NOT purged: identity-directory.json could not be read or was corrupt, so identity sync is disabled this run. They cannot be re-purged either — ${id} is gone from the machine directory both purge paths resolve against. Fix or remove the file, restart the hub, then remove those rows by hand.`,
        );
      }
      deps.fanout.patchStatus({ events: fleetEventsStatus(fleetEvents) });
      deps.fanout.emitMachinesPoke();
      return c.json({ ok: true } satisfies CredentialAck);
    });

    app.post("/api/store/compact", async (c) => {
      // Same truncation hazard as the purge above — refuse before rewriting.
      if (!eventsUsable()) return c.json(ARCHIVE_UNAVAILABLE, 503);
      await fleetEvents.rewrite({ newEpoch: false });
      deps.fanout.patchStatus({ events: fleetEventsStatus(fleetEvents) });
      return c.json({ ok: true } satisfies CredentialAck);
    });
  }

  // Key custody (ADR-0035): persist to the OS keychain via the credstore, then
  // arm the poller — mirroring the sidecar's POST /api/usage/credential
  // (immediate pollOnce for fast first sample). Write-only: the hub never
  // serves the key back out.
  app.post("/api/credential", async (c) => {
    // Parse explicitly so an UNPARSEABLE body (a truncated / proxy-mangled
    // request) is a 400 — NOT folded into the same `null` the documented clear
    // contract uses, which would silently delete the keychain key and disarm
    // the poller on a mangled write (F4). A literal `null` still clears; both
    // shipped callers send the literal body "null".
    let raw: unknown;
    try {
      raw = JSON.parse(await c.req.text());
    } catch {
      const body: ErrorResponse = { error: "invalid credential" };
      return c.json(body, 400);
    }
    if (raw === null) {
      await deps.persistCredential(null);
      deps.usage.setCredential(null);
      // A clear resets provenance AND orgId — there is no longer a key to
      // attribute or an org to show (overview §8).
      deps.fanout.patchStatus({
        credentialPresent: false,
        credentialUpdatedAt: null,
        credentialSource: null,
        orgId: null,
      });
      return c.json({ ok: true } satisfies CredentialAck);
    }
    const parsed = usageCredentialSchema.safeParse(raw);
    if (!parsed.success) {
      const body: ErrorResponse = { error: "invalid credential" };
      return c.json(body, 400);
    }
    // Persist-first is the fail-closed ordering: if the keychain write
    // rejects, the 500 fires before the poller is armed — never a poller
    // running on a credential that didn't persist.
    await deps.persistCredential(parsed.data);
    deps.usage.setCredential(parsed.data);
    // Provenance + display (ADR-0036, overview §8): WHO set/healed the key and
    // WHEN, plus the org (non-secret) for the console to SHOW and prefill. The
    // console's own POST carries no machine header ⇒ "local"; a sidecar
    // auto-heal POST carries its machineId ⇒ that machine is the healer. The
    // session key value is never stored or echoed — write-only stays intact.
    deps.fanout.patchStatus({
      credentialPresent: true,
      credentialUpdatedAt: new Date().toISOString(),
      credentialSource: c.req.header("x-maxprice-machine") ?? "local",
      orgId: parsed.data.orgId,
    });
    await deps.usage.pollOnce();
    return c.json({ ok: true } satisfies CredentialAck);
  });

  // Live stream — bounded write-chain SSE pump (shared with the sidecar). For an
  // identified fleet client the subscription lifetime is its "live" window in
  // the roster: markLive on open, markOffline in finally when the socket severs
  // (the recordRequest middleware already created its row before we get here). A
  // header-less subscriber — the operator console's own SSE — is not a fleet
  // member, so it never touches the roster (don't conjure an "unknown" row).
  app.get("/api/stream", (c) => {
    const machineId = c.req.header("x-maxprice-machine");
    return streamSSE(c, async (stream) => {
      if (machineId) registry.markLive(machineId);
      try {
        await streamSSEPump(stream, deps.fanout.subscribe, HUB_SSE_EVENT.heartbeat);
      } finally {
        if (machineId) registry.markOffline(machineId);
      }
    });
  });

  return app;
}
