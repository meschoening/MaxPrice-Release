import { networkInterfaces } from "node:os";
import { isLoopbackHost } from "@maxprice/shared";
import { isBindClassifiable, resolveBindHosts, type Ifaces } from "./bind";

// The bind reconciler (ADR-0074). The hub used to resolve its bind ONCE, at
// startup, and serve whatever that snapshot found — so a hub launched at login
// (ADR-0051's autostart) beat `tailscaled` to the interface, degraded to
// loopback, and stayed unreachable on the tailnet until someone restarted it.
// Every reboot. Instead of a snapshot, the desired host set is now RECONCILED:
// re-resolved every 10s and diffed against what is actually bound, adding
// binds as addresses appear and dropping them when they go.
//
// Reachability by reconciliation rather than by a lucky boot ordering is the
// same shape ADR-0055 gave fleet convergence — the hub owes itself a bind for
// every address it should be serving, and keeps owing it until it holds one.

export const BIND_POLL_MS = 10_000;

// Two consecutive misses before dropping a bind (~20s at BIND_POLL_MS). A
// Tailscale re-auth or a brief interface flap must not tear down a working
// bind — and with it every SSE client on that address — for a blip.
export const DROP_AFTER_MISSES = 2;

// A bind that keeps failing logs at most this often. Logging once would have
// scrolled away by the time anyone looked; logging every tick is 8,640 lines a
// day in a file that rotates at 5 MB (ADR-0056).
export const BIND_FAILURE_LOG_THROTTLE_MS = 60_000;

// The slice of Bun's Server the reconciler owns. Deliberately minimal: it needs
// to stop a server, nothing else. `hostname`/`port` are the reconciler's own
// knowledge, not read back off the server.
export type BoundServer = { stop: (closeActiveConnections?: boolean) => unknown };

type FetchHandler = (request: Request, server: unknown) => Response | Promise<Response>;

export type ServeImpl = (opts: {
  hostname: string;
  port: number;
  fetch: FetchHandler;
  idleTimeout: number;
}) => BoundServer;

export type BindReconcilerOptions = {
  bind: string;
  port: number;
  fetch: FetchHandler;
  // Called ONLY when the reported state changes, so a quiet tick costs no SSE
  // traffic. The patch is exactly the two HubStatus fields the console reads.
  onBoundChange?: (patch: { bindHosts: string[]; bindWarning: string | null }) => void;
  // Transitions only (bound / dropped / bind failed). Wired to the daemon's
  // stdout, which the tray shell tees into a durable hub.log (ADR-0056).
  log?: (line: string) => void;
  serveImpl?: ServeImpl;
  interfacesImpl?: () => Ifaces;
  intervalMs?: number;
  setIntervalImpl?: (callback: () => void, ms: number) => unknown;
  clearIntervalImpl?: (handle: unknown) => void;
  nowImpl?: () => number;
};

export type BindReconciler = {
  // What is bound RIGHT NOW, in resolveBindHosts order (ADR-0074): the console's
  // Listening row must not reshuffle just because a host was dropped and
  // re-added in a different order than it was first resolved.
  hosts: () => string[];
  stop: () => Promise<void>;
};

// Modes whose desired host set is a constant — no interface change can alter
// it, so there is nothing to watch and the timer never starts.
//
// The loopback test here is the RAW string one, while bind.ts classifies on a
// canonical form — so `bind: "::ffff:127.0.0.1"` reads as loopback there and not
// here, and starts a timer that re-resolves a constant set forever. Left as a
// known seam rather than closed: the cost is one wasted comparison every 10s on
// a spelling only a hand-edited hub.json could produce, no behavior differs, and
// closing it would mean either exporting canonicalHost or growing a second copy
// of it in this module.
function isStaticBind(bind: string): boolean {
  return bind === "loopback" || bind === "0.0.0.0" || bind === "::" || isLoopbackHost(bind);
}

export function startBindReconciler(opts: BindReconcilerOptions): BindReconciler {
  const serveImpl: ServeImpl =
    opts.serveImpl ?? ((o) => Bun.serve({ ...o, fetch: o.fetch as never }) as BoundServer);
  const interfacesImpl = opts.interfacesImpl ?? (() => networkInterfaces());
  const setIntervalImpl =
    opts.setIntervalImpl ?? ((cb: () => void, ms: number): unknown => setInterval(cb, ms));
  const clearIntervalImpl =
    opts.clearIntervalImpl ??
    ((handle: unknown): void => clearInterval(handle as ReturnType<typeof setInterval>));
  const now = opts.nowImpl ?? (() => Date.now());
  const log = opts.log ?? ((line: string) => console.log(line));

  // Insertion-ordered: a host bound before its siblings existed keeps its place
  // among the "no longer desired" tail when reporting (see reportedHosts).
  const bound = new Map<string, BoundServer>();
  const misses = new Map<string, number>();
  const lastFailureLogAt = new Map<string, number>();
  let reported: { bindHosts: string[]; bindWarning: string | null } | null = null;
  let lastTickErrorAt: number | null = null;
  let timer: unknown = null;
  let stopped = false;

  // Desired order first (that is the stable, meaningful order), then anything
  // still bound but no longer desired — a host inside its drop grace.
  function reportedHosts(desired: string[]): string[] {
    const inDesiredOrder = desired.filter((host) => bound.has(host));
    const lingering = [...bound.keys()].filter((host) => !desired.includes(host));
    return [...inDesiredOrder, ...lingering];
  }

  // USER-FACING copy (ADR-0049): the operator console renders bindWarning
  // verbatim in a warning inset. Full sentences, naming the address and the
  // fact that nothing needs doing — the reconciler is already retrying.
  function unboundWarning(hosts: string[]): string {
    const seconds = Math.max(1, Math.round((opts.intervalMs ?? BIND_POLL_MS) / 1000));
    const which = hosts.length === 1 ? "that address" : "those addresses";
    return `Could not bind ${hosts.join(", ")} — the hub is not reachable on ${which}. It keeps retrying every ${seconds}s.`;
  }

  function bind(hostname: string, fatal: boolean): void {
    try {
      bound.set(
        hostname,
        serveImpl({ hostname, port: opts.port, fetch: opts.fetch, idleTimeout: 0 }),
      );
      lastFailureLogAt.delete(hostname);
      if (!fatal) log(`[hub] bound ${hostname}:${opts.port}`);
    } catch (err) {
      // Fatality is the CALLER's verdict, and it is decided per host: reconcile
      // passes `fatal` only on the first pass AND only for a host
      // `isBindClassifiable` vouches for (an IP literal the interface table
      // reports, or a wildcard). For such a host a throw can only mean another
      // process owns the port — a second hub instance — which must stay a loud
      // exit 1 rather than a daemon that half-serves. A host the gate cannot
      // vouch for (a hostname, an ungated loopback literal) throws the SAME
      // EADDRINUSE for "that address isn't here", so it degrades onto the retry
      // path below instead. Every later pass retries next tick regardless.
      if (fatal) throw err;
      const last = lastFailureLogAt.get(hostname);
      const t = now();
      if (last === undefined || t - last >= BIND_FAILURE_LOG_THROTTLE_MS) {
        lastFailureLogAt.set(hostname, t);
        log(`[hub] bind failed for ${hostname}:${opts.port}: ${String(err)}`);
      }
    }
  }

  function drop(hostname: string): void {
    const server = bound.get(hostname);
    if (server === undefined) return;
    bound.delete(hostname);
    misses.delete(hostname);
    lastFailureLogAt.delete(hostname);
    // stop(true) — force. The hub holds SSE connections that never complete on
    // their own, so a graceful stop would wait forever; and the address is gone
    // anyway, which makes every connection on it already dead.
    //
    // Bun's Server.stop returns a Promise (BoundServer types it `unknown`, which
    // is why no-floating-promises stays quiet), and index.ts turns ANY unhandled
    // rejection into shutdown(1) — so a rejection here would kill the daemon
    // during exactly the network flap this path exists for. Releasing an address
    // that is already gone is best-effort by definition: log and carry on.
    void Promise.resolve(server.stop(true)).catch((err) =>
      log(`[hub] stop failed for ${hostname}:${opts.port}: ${String(err)}`),
    );
    log(`[hub] dropped ${hostname}:${opts.port} — the address is no longer on this machine`);
  }

  // `fatal` is true ONLY on the first pass, from startBindReconciler's own
  // synchronous call — the boot bind keeps its deliberate unguarded posture
  // (index.ts: "a throw here is a fatal unhandled rejection, loud exit 1, no
  // zombie"), while every timer-driven pass is guarded and retries. Within that
  // first pass it is narrowed per host by `isBindClassifiable`, below.
  function reconcile(fatal: boolean): void {
    if (stopped) return;
    // ONE interface read, used for both the resolution and the classification.
    // That identity is the point: classifying against a table the resolution
    // never saw could call a host unvouched-for that was resolved as present, or
    // the reverse, on any pass where an adapter changed between the two reads.
    const ifaces = interfacesImpl();
    const { hosts: desired, warning } = resolveBindHosts(opts.bind, ifaces);

    for (const hostname of desired) {
      misses.set(hostname, 0);
      // Second-instance detection survives this narrowing, and THAT is what
      // makes it safe: every non-wildcard desired list from resolveBindHosts
      // leads with "127.0.0.1" — always in the interface table, therefore always
      // classifiable — and this loop binds in `desired` order, so a real port
      // conflict still throws fatally on the FIRST attempt in every mode. A
      // wildcard vouches for itself (isBindClassifiable returns true for it).
      if (!bound.has(hostname)) bind(hostname, fatal && isBindClassifiable(hostname, ifaces));
    }

    for (const hostname of [...bound.keys()]) {
      if (desired.includes(hostname)) continue;
      const missed = (misses.get(hostname) ?? 0) + 1;
      misses.set(hostname, missed);
      if (missed >= DROP_AFTER_MISSES) drop(hostname);
    }

    // Patch on change only. The warning has TWO sources:
    //
    //  1. The BIND — a routable host that was resolved but is not bound, i.e.
    //     one whose bind threw and was swallowed above. For a presence-gated
    //     host resolveBindHosts returns `null` precisely when the address IS in
    //     the interface table — the gate's precondition for attempting the bind
    //     at all — so without this the console would see
    //     {bindHosts:["127.0.0.1"], bindWarning:null} and read it as a CHOSEN
    //     loopback bind (isDeliberateLoopback,
    //     apps/hub-desktop/src/lib/presentation.ts), painting a
    //     fleet-unreachable hub as local-only-by-request. Worse on a half-failed
    //     dual stack: v4 bound reads "Online" while AAAA-preferring clients hit
    //     a dead address — the ADR-0038 fault, silently.
    //  2. The resolution — a desired set that fell back to loopback. It tracks
    //     the resolution and not the bind set, so it appears the moment an
    //     address is gone rather than waiting out the drop grace; during that
    //     window the console truthfully shows a still-bound tailnet host
    //     alongside a warning that it has vanished.
    //
    // The bind outranks the resolution, which matters for exactly one overlap:
    // an UNGATED desired host — a hostname, which f5b lets fail without killing
    // the daemon — resolves with the cleartext caveat, "Bound <host>, which is
    // not a loopback or tailnet address…", and that sentence is simply false
    // about a host whose bind failed, while saying nothing about the hub being
    // unreachable. Where such a host really is bound, `unbound` is empty and the
    // caveat shows as before. Every other resolution warning implies a
    // loopback-only desired set, which makes `unbound` empty and the order moot.
    //
    // Reported on the first tick, no debounce — "bindHosts means what is bound
    // right now" is ADR-0074's point, and a ≤1-interval amber flash on a
    // self-healing transient is the accepted cost.
    const unbound = desired.filter((host) => !isLoopbackHost(host) && !bound.has(host));
    const next = {
      bindHosts: reportedHosts(desired),
      bindWarning: unbound.length > 0 ? unboundWarning(unbound) : warning,
    };
    const changed =
      reported === null ||
      reported.bindWarning !== next.bindWarning ||
      reported.bindHosts.length !== next.bindHosts.length ||
      reported.bindHosts.some((host, i) => host !== next.bindHosts[i]);
    reported = next;
    // The first pass patches like any other. It has to: the fanout and this
    // subscriber both exist before startBindReconciler is called, and the boot
    // status can no longer resolve the interface table a SECOND time to seed
    // itself — a tailnet that came up between two reads would leave that
    // snapshot asserting "loopback only, no tailnet interface" for the daemon's
    // whole life, since `reported` would already equal the steady state and no
    // later tick would ever compute `changed`. Patching here is the one
    // resolution. (No socket can accept a request before this synchronous call
    // returns, so an empty subscriber set is guaranteed, not merely likely.)
    if (changed) opts.onBoundChange?.(next);
  }

  reconcile(true);

  // Guard the TIMER CALLBACK, never reconcile()'s body — the fatal first pass
  // is the direct call above, outside the timer, and must keep throwing. There
  // is no `uncaughtException` handler anywhere in the daemon (index.ts registers
  // SIGINT, SIGTERM and `unhandledRejection` only), so a throw out of a tick
  // would abort the process with poller.stop(), the sample flush,
  // fleetEvents.close() and binds.stop() all skipped. Sources that really can
  // throw in here: interfacesImpl() (os.networkInterfaces() under adapter
  // churn), log(), and the synchronous half of server.stop(). One bad tick
  // should cost one tick.
  function guardedTick(): void {
    try {
      reconcile(false);
    } catch (err) {
      try {
        // Throttled like a failing bind: a persistent networkInterfaces() fault
        // would otherwise write 8,640 lines a day into a log that rotates at
        // 5 MB (ADR-0056).
        const t = now();
        if (lastTickErrorAt === null || t - lastTickErrorAt >= BIND_FAILURE_LOG_THROTTLE_MS) {
          lastTickErrorAt = t;
          log(`[hub] bind reconcile tick failed: ${String(err)}`);
        }
      } catch {
        // log() is itself one of the throw sources (a closed stdout pipe). A
        // tick that cannot even report its own failure must still not abort.
      }
    }
  }

  if (!isStaticBind(opts.bind)) {
    timer = setIntervalImpl(guardedTick, opts.intervalMs ?? BIND_POLL_MS);
  }

  return {
    hosts: () => reported?.bindHosts ?? [],
    stop: async () => {
      stopped = true;
      if (timer !== null) {
        clearIntervalImpl(timer);
        timer = null;
      }
      // Per-bind try: one address that refuses to release must not skip the
      // rest of the teardown, nor bound.clear().
      for (const [hostname, server] of bound) {
        try {
          await server.stop(true);
        } catch (err) {
          log(`[hub] stop failed for ${hostname}:${opts.port}: ${String(err)}`);
        }
      }
      bound.clear();
    },
  };
}
