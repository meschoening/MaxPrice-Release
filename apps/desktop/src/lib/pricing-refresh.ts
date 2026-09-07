import { PRICING_REFRESH_PATH, pricingRefreshResponseSchema } from "@maxprice/shared";
import type { PricingRefreshResponse } from "@maxprice/shared";
import { logClientEvent } from "@/lib/client-log";
import { sidecarFetch } from "@/lib/sidecar";
import { usageAuthHeaders } from "@/lib/usage-credential";

// The manual pricing refresh request (ADR-0085) — POST /api/pricing/refresh,
// the Settings › Pricing chip's one network call. The rescan gesture's request
// shape (`state/use-manual-refresh.ts::performRescan`): the per-launch auth
// header, an abort ceiling, a Zod parse, and a durable log line on every
// failure path. Deliberately NOT a store: the section holds its own transient
// phase (like Updates), and the provenance the row shows comes from the
// live-status store over SSE, which the sidecar patches on every settled
// attempt whether or not this response arrives.
//
// This function does NOT invalidate report caches. The sidecar's status
// broadcast carries the new `capturedAt`, and `handleStatusEvent` (#108)
// requests the round on that change — one trigger, one place.

// A refresh that never answers. The sidecar's own upstream fetch is bounded at
// 10 s (`DEFAULT_TIMEOUT_MS` in the sidecar), and a request that JOINS an
// in-flight attempt inherits at most that, so 20 s is twice the legitimate
// worst case: the only way to reach it is a wedged sidecar. Not the rescan's
// 120 s — that one guards a disk walk with real work behind it.
export const PRICING_REFRESH_TIMEOUT_MS = 20_000;

let nowImpl: () => number = () => Date.now();
export function setNowImplForTests(next: (() => number) | null): void {
  nowImpl = next ?? (() => Date.now());
}

// Test seam: fire the in-flight request's ceiling now. `null` when none is
// pending. Timers are not fakeable under bun:test without spending 20 real
// seconds, and the classification is the thing worth pinning.
let pendingTimeout: (() => void) | null = null;
export function fireTimeoutForTests(): void {
  pendingTimeout?.();
}

// Distinguishes the ceiling's abort from every other rejection, set in the
// timeout callback rather than inferred from a bare AbortError (the DOMException
// name is not ours).
export class PricingRefreshTimeoutError extends Error {
  constructor(readonly elapsedMs: number) {
    super(`${PRICING_REFRESH_PATH} timed out after ${elapsedMs}ms`);
    this.name = "PricingRefreshTimeoutError";
  }
}

export async function performPricingRefresh(): Promise<PricingRefreshResponse> {
  const controller = new AbortController();
  const startedAt = nowImpl();
  let timedOut = false;
  const onTimeout = (): void => {
    timedOut = true;
    controller.abort();
  };
  const timeout = setTimeout(onTimeout, PRICING_REFRESH_TIMEOUT_MS);
  pendingTimeout = onTimeout;
  try {
    const res = await sidecarFetch(PRICING_REFRESH_PATH, {
      method: "POST",
      headers: await usageAuthHeaders(),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`${PRICING_REFRESH_PATH} ${res.status}: ${await res.text()}`);
    return pricingRefreshResponseSchema.parse(await res.json());
  } catch (err) {
    const elapsedMs = nowImpl() - startedAt;
    if (timedOut) {
      logClientEvent(`pricing-refresh: timed out after ${elapsedMs}ms`);
      throw new PricingRefreshTimeoutError(elapsedMs);
    }
    logClientEvent(`pricing-refresh: failed after ${elapsedMs}ms: ${String(err)}`);
    throw err;
  } finally {
    clearTimeout(timeout);
    pendingTimeout = null;
  }
}
