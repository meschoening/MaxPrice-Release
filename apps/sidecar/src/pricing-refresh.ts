// Runtime pricing lifecycle (ADR-0085, ADR-0096). Load a newer cached fetch
// after the LISTENING handshake, then refresh in the background. Successful
// fetches swap active prices and persist the raw snapshot; failures retain
// active prices. Disk and network work never gate the handshake or reports.
//
// Startup, daily, manual and unknown-model discovery share one in-flight
// attempt and ten-second cooldown. Unknown-model retries back off from one
// minute to one hour. All activations publish through the existing status /
// report-cache invalidation path. The shared fetch module owns payload limits,
// timeouts, transform validation and the bundled completeness floor.

import {
  setActivePricingSnapshot,
  activePricingSnapshot,
  pricingSnapshot,
  unresolvedModels,
  type PricingRefreshResponse,
  type PricingStatus,
  fetchPricingSnapshot,
  type RefreshPricingResult,
  type RefreshPricingOptions,
} from "@maxprice/shared";

import type { EventStore, StoreChange } from "./engine/store";

export { type RefreshPricingResult } from "@maxprice/shared";
import { loadPricingCache, savePricingCache } from "./pricing-cache";

export const DEFAULT_REFRESH_COOLDOWN_MS = 10_000;

export async function refreshPricing(
  opts: RefreshPricingOptions & { cachePath?: string } = {},
): Promise<RefreshPricingResult> {
  const result = await fetchPricingSnapshot(opts);
  if (!result.ok) {
    console.warn(
      `[sidecar] pricing refresh skipped (${result.kind}: ${result.detail}); retaining active prices`,
    );
    return result;
  }
  setActivePricingSnapshot(result.snapshot);
  if (opts.cachePath) await savePricingCache(opts.cachePath, result.snapshot);
  return { ok: true, fetchedAt: result.fetchedAt };
}

// The ONE construction site for the wire's pricing status (ADR-0053). Every
// settled attempt patches through this — as does the boot seed — so `source` /
// `capturedAt` / `modelCount` can never disagree with each other or with the
// snapshot actually pricing reports.
//
// `result === null` means no attempt has settled yet: that is the boot seed,
// where prices may come from the bundled floor or a persisted fetch and
// this process has not attempted a network refresh yet.
//
// `source` needs no branch on the result. `withPricingOverrides` is documented
// as identity-preserving precisely so this identity check holds (overrides.ts),
// and the refresh suite asserts `activePricingSnapshot() === pricingSnapshot` on
// every failure path — so this is a tested property, not just a documented one.
// It is also correct on the case a result-based branch would get wrong: a failed
// ~24h tick after a successful boot fetch stays `"fetched"`, because live prices
// are still active.
export function buildPricingStatus(
  result: RefreshPricingResult | null,
  models: Iterable<string>,
  nowImpl: () => string = () => new Date().toISOString(),
): PricingStatus {
  const active = activePricingSnapshot();
  return {
    source: active === pricingSnapshot ? "vendored" : "fetched",
    capturedAt: active.capturedAt,
    // Off the ACTIVE snapshot, so the count includes the ADR-0027 override
    // gap-fill — the honest answer to "how many models can this app price".
    modelCount: Object.keys(active.models).length,
    unpricedModels: unresolvedModels(models),
    lastAttempt:
      result === null
        ? null
        : result.ok
          ? // On success the fetch time IS the attempt time and the new
            // snapshot's `capturedAt`, so the healthy row's two timestamps
            // agree by construction.
            { at: result.fetchedAt, failure: null }
          : { at: nowImpl(), failure: { kind: result.kind, detail: result.detail } },
  };
}

// The handle a scheduled refresh loop hands back — `stop()` cancels the timer.
export type PricingRefreshLoop = { stop: () => void };

// ADR-0041 (T14): the ~24h BEST-EFFORT pricing re-fetch. Startup-only refresh
// left always-on machines frozen at boot-day prices, making cross-machine cost
// convergence hollow — so the same attempt re-runs on a daily interval.
//
// A PLAIN TICKER since ADR-0085: it calls `attempt` and nothing else. The
// overlap guard that used to live here (`inFlight`) moved into the single-flight
// attempt `wirePricingRefresh` builds, because a manual `refreshNow` needed the
// same guard and two copies of it would have raced each other. A tick landing
// during an in-flight attempt JOINS it — no fetch is issued, so `lastAttempt`
// is not advanced and a single hung fetch still cannot look like healthy
// repeated activity. Never throws, never gates anything.
export function schedulePricingRefresh(opts: {
  attempt: () => Promise<unknown>;
  intervalMs?: number;
  setIntervalImpl?: (cb: () => void, ms: number) => unknown;
  clearIntervalImpl?: (handle: unknown) => void;
}): PricingRefreshLoop {
  const intervalMs = opts.intervalMs ?? 24 * 60 * 60 * 1000;
  const setIntervalImpl = opts.setIntervalImpl ?? ((cb, ms) => setInterval(cb, ms));
  const clearIntervalImpl =
    opts.clearIntervalImpl ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));
  const handle = setIntervalImpl(() => {
    // `refreshPricing` never rejects by contract; the attempt rejects only if
    // the status patch throws. Either way a timer callback must not surface it
    // — `index.ts` turns an unhandled rejection into a sidecar shutdown.
    void opts.attempt().catch((err: unknown) => {
      console.warn("[sidecar] periodic pricing refresh failed:", err);
    });
  }, intervalMs);
  return { stop: () => clearIntervalImpl(handle) };
}

// The handle `main()` keeps: `stop()` cancels both timers; `refreshNow()`
// is what POST /api/pricing/refresh calls (ADR-0085).
export type PricingRefresher = PricingRefreshLoop & {
  refreshNow: () => Promise<PricingRefreshResponse>;
  republish: () => void;
};

// The SINGLE wiring site: `main()` calls this once, after the LISTENING
// handshake, and keeps the returned handle.
//
// Startup, daily, manual and model-discovery callers share ONE attempt
// (ADR-0085, ADR-0096). `attempt()` is single-flight —
// a caller arriving while one is in flight gets the SAME promise, so there is
// never more than one upstream fetch or more than one status patch per
// attempt, and every caller is told the same truth. This is what lets the
// manual button never fail for a reason the user cannot see: pressing it during
// the boot fetch simply waits for that fetch's answer.
//
// This reverses ADR-0053's note that the startup arm did NOT participate in the
// loop's guard. It had to: a manual request racing the boot fetch would
// otherwise have stacked a second fetch and a second swap.
//
// `newModels` is measured across the attempt from the ACTIVE snapshot's key
// set — before the fetch and after the swap — so it counts exactly what this
// attempt made priceable. It is 0 on failure by construction (no swap).
//
// Behind the single-flight guard sits a COOLDOWN (DEFAULT_REFRESH_COOLDOWN_MS):
// a call arriving within the window after the last attempt settled is answered
// with that attempt's `pricing` and `newModels: 0` — not the previous count,
// which was already reported once, by the attempt that earned it. Like a joined
// caller, a cooled caller is not an attempt: no fetch, no status patch,
// `lastAttempt` does not advance. The window opens only on a SETTLED response;
// an attempt whose patch threw never produced one, so it cools nothing and the
// next call retries for real.
export function wirePricingRefresh(opts: {
  patch: (partial: { pricing: PricingStatus }) => void;
  models: () => Iterable<string>;
  refreshImpl?: () => Promise<RefreshPricingResult>;
  cachePath?: string;
  retryBaseMs?: number;
  retryMaxMs?: number;
  setTimeoutImpl?: (cb: () => void, ms: number) => unknown;
  clearTimeoutImpl?: (handle: unknown) => void;
  intervalMs?: number;
  setIntervalImpl?: (cb: () => void, ms: number) => unknown;
  clearIntervalImpl?: (handle: unknown) => void;
  // The cooldown window and the clock it is measured on. Injected for tests,
  // mirroring `buildPricingStatus`'s clock.
  cooldownMs?: number;
  nowImpl?: () => number;
}): PricingRefresher {
  const refreshImpl = opts.refreshImpl ?? (() => refreshPricing({ cachePath: opts.cachePath }));
  const retryBaseMs = opts.retryBaseMs ?? 60_000;
  const retryMaxMs = opts.retryMaxMs ?? 60 * 60_000;
  const setTimeoutImpl =
    opts.setTimeoutImpl ??
    ((cb, ms) => {
      const timer = setTimeout(cb, ms);
      timer.unref();
      return timer;
    });
  const clearTimeoutImpl =
    opts.clearTimeoutImpl ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  let retryTimer: unknown = null;
  let retryDelay = retryBaseMs;
  let nextAutomaticAt = 0;
  let stopped = false;
  let cacheLoaded = !opts.cachePath;
  const cooldownMs = opts.cooldownMs ?? DEFAULT_REFRESH_COOLDOWN_MS;
  const nowImpl = opts.nowImpl ?? Date.now;

  // A model-only publication preserves the settled attempt's timestamp and
  // failure. It must also update cooldown responses, so a manual response can
  // never overwrite newer model discovery with a stale unpriced list.
  let publishedPricing = buildPricingStatus(null, []);
  let inFlight: Promise<PricingRefreshResponse> | null = null;
  let lastSettled: { at: number; response: PricingRefreshResponse } | null = null;
  const attempt = (): Promise<PricingRefreshResponse> => {
    if (inFlight !== null) return inFlight;
    if (lastSettled !== null && nowImpl() - lastSettled.at < cooldownMs) {
      return Promise.resolve({ pricing: publishedPricing, newModels: 0 });
    }
    let before = new Set(Object.keys(activePricingSnapshot().models));
    const run = async (): Promise<RefreshPricingResult> => {
      if (!cacheLoaded && opts.cachePath) {
        cacheLoaded = true;
        await loadPricingCache(opts.cachePath);
        before = new Set(Object.keys(activePricingSnapshot().models));
        publishedPricing = buildPricingStatus(null, opts.models());
        opts.patch({ pricing: publishedPricing });
      }
      return refreshImpl();
    };
    inFlight = run()
      .then((result) => {
        const after = Object.keys(activePricingSnapshot().models);
        const newModels = result.ok ? after.filter((key) => !before.has(key)).length : 0;
        const pricing = buildPricingStatus(result, opts.models());
        // The ONE patch per attempt. If it throws, the promise rejects — the
        // startup arm and the ticker warn, the route answers 500.
        opts.patch({ pricing });
        publishedPricing = pricing;
        const response = { pricing, newModels };
        lastSettled = { at: nowImpl(), response };
        const needsRetry = !result.ok || pricing.unpricedModels.length > 0;
        nextAutomaticAt = nowImpl() + (needsRetry ? retryDelay : cooldownMs);
        retryDelay = needsRetry ? Math.min(retryDelay * 2, retryMaxMs) : retryBaseMs;
        return response;
      })
      .catch((err: unknown) => {
        nextAutomaticAt = nowImpl() + retryDelay;
        retryDelay = Math.min(retryDelay * 2, retryMaxMs);
        throw err;
      })
      .finally(() => {
        inFlight = null;
        scheduleUnknownRefresh();
      });
    return inFlight;
  };

  // Discovery and retries share the same attempt as startup, manual and daily refresh.
  // Failed or still-unpriced attempts back off globally, including when more models arrive.
  function scheduleUnknownRefresh(): void {
    if (retryTimer !== null) clearTimeoutImpl(retryTimer);
    retryTimer = null;
    if (stopped || inFlight !== null || unresolvedModels(opts.models()).length === 0) return;
    const cooldownUntil = lastSettled === null ? 0 : lastSettled.at + cooldownMs;
    const delay = Math.max(0, nextAutomaticAt - nowImpl(), cooldownUntil - nowImpl());
    retryTimer = setTimeoutImpl(() => {
      retryTimer = null;
      if (stopped) return;
      void attempt().catch((err: unknown) => {
        console.warn("[sidecar] automatic pricing refresh failed:", err);
      });
    }, delay);
  }

  // The startup arm. `void`ed so it never gates the handshake / scan / any
  // endpoint; its own `.catch` keeps a throwing `patch` away from
  // `unhandledRejection`, which `index.ts` handles by exiting the process.
  void attempt().catch((err: unknown) => {
    console.warn("[sidecar] pricing refresh status update failed:", err);
  });

  const loop = schedulePricingRefresh({
    attempt,
    intervalMs: opts.intervalMs,
    setIntervalImpl: opts.setIntervalImpl,
    clearIntervalImpl: opts.clearIntervalImpl,
  });
  return {
    stop: () => {
      stopped = true;
      loop.stop();
      if (retryTimer !== null) clearTimeoutImpl(retryTimer);
      retryTimer = null;
    },
    refreshNow: attempt,
    republish: () => {
      const next = unresolvedModels(opts.models());
      if (sameList(publishedPricing.unpricedModels, next)) return;
      const pricing = { ...publishedPricing, unpricedModels: next };
      opts.patch({ pricing });
      publishedPricing = pricing;
      scheduleUnknownRefresh();
    },
  };
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

// Subscribe to a store's change feed and call `republish` the first time any
// raw model string appears in a batch (#110). Cheap by construction: one Set
// lookup per changed row, and `republish` itself only broadcasts when the
// unpriced list actually moved. Returns the unsubscribe; `main()` re-attaches
// on the fleet's store swap, the way the local archive does.
export function watchNewModels(
  store: Pick<EventStore, "onChanged">,
  republish: () => void,
): () => void {
  const seen = new Set<string>();
  return store.onChanged((changes: readonly StoreChange[]) => {
    let fresh = false;
    for (const c of changes) {
      if (!seen.has(c.event.model)) {
        seen.add(c.event.model);
        fresh = true;
      }
    }
    if (fresh) republish();
  });
}
