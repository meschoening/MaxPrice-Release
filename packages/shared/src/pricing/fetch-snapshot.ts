// Shared validated fetch for runtime refresh and release preparation. No active-state mutation.
import { transformUpstreamPricing, UPSTREAM_PRICING_URL } from "./snapshot-transform";
import { pricingSnapshot } from "./resolve";
import type { PricingSnapshot } from "./snapshot";
import type { PricingFailureKind } from "../live";

// The fetch signature we depend on — a structural subset of the global
// `fetch`. Injected in tests so they stay deterministic and offline.
export type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;

export type RefreshPricingOptions = {
  // Injected for tests; defaults to the global `fetch`.
  fetchImpl?: FetchLike;
  // Abort the fetch after this many ms. Defaults to 10s — generous for a
  // ~1.4 MB JSON file, tight enough that a hung connection can't linger.
  timeoutMs?: number;
};

// The outcome of a refresh attempt. Either the fetch time of a successful swap,
// or a CLASSIFIED failure (ADR-0053) — the failure arm used to be an opaque
// `reason` string that every call site discarded; now it reaches the live status
// so the App info row can say something true about why prices are stale.
export type RefreshPricingResult =
  | { ok: true; fetchedAt: string }
  | { ok: false; kind: PricingFailureKind; detail: string };

const DEFAULT_TIMEOUT_MS = 10_000;

// Hard ceiling on the upstream body, in bytes — enforced by counting DECODED
// bytes as they arrive (see `readCappedBody`). The real file is ~1.4 MB, so
// 32 MB is ~23x headroom: legitimate upstream growth can never trip it, while a
// hostile or corrupt response can't buffer the sidecar out of memory.
const MAX_BODY_BYTES = 32 * 1024 * 1024;

// The minimum share of the VENDORED model count a fetched snapshot must carry
// before it is allowed to replace it.
//
// 50% is a CATASTROPHIC-RESTRUCTURE bar, not a quality bar. It fires only when
// upstream has lost most of its Claude keys at once — a rename or restructure
// slipping past `transformUpstreamPricing`'s `/claude/i` filter — and stays
// quiet through any plausible legitimate pruning of retired models. A stricter
// bar would eventually pin the app to an ever-staler vendored floor as upstream
// genuinely drops old Claude keys, which is the failure this check exists to
// prevent, only slower.
//
// Compared against the VENDORED count, never `activePricingSnapshot()`: the
// active one ratchets upward with each successful fetch, so using it would turn
// the floor into a monotonic high-water mark that refuses legitimate prunings.
const MIN_MODEL_RATIO = 0.5;

// Best-effort fetch and validation of upstream LiteLLM pricing. Resolves to a
// result describing the outcome — it never rejects.
//
// The nested try/catch structure exists so each `PricingFailureKind` is
// reachable at the seam that actually failed: a flat single `try` can only
// report "something threw", which is how the old opaque `reason` came about.
export async function fetchPricingSnapshot(
  opts: RefreshPricingOptions = {},
): Promise<PricingFetchResult> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  try {
    // Constructed OUTSIDE the fetch's own try on purpose: a `timeoutMs` the
    // platform rejects is a programmer error, and reporting it as `offline`
    // would blame the network for our own bad argument. It falls to the
    // backstop below instead.
    const signal = AbortSignal.timeout(timeoutMs);

    let response: Response;
    try {
      response = await fetchImpl(UPSTREAM_PRICING_URL, { signal });
    } catch (err) {
      return fail(classify(err, "offline"), detailOf(err));
    }

    if (!response.ok) {
      // Nothing reads an error body, and an undrained, uncancelled one holds
      // its connection open until GC gets round to it. The `.catch` is
      // mandatory rather than cosmetic: `index.ts` handles `unhandledRejection`
      // by shutting the sidecar down, so a bare `void`ed rejecting cancel would
      // turn a 404 from upstream into a dead sidecar.
      response.body?.cancel().catch(() => {});
      return fail("http", `HTTP ${response.status}`);
    }

    let fetchedAt: string;
    let snapshot: ReturnType<typeof transformUpstreamPricing>;
    try {
      // NOT `response.json()` — the body goes through a counting reader so an
      // oversized payload is refused rather than buffered (see MAX_BODY_BYTES).
      const body = await readCappedBody(response, MAX_BODY_BYTES);
      const upstream: unknown = JSON.parse(body);
      // The fetch time IS the snapshot's capture time — a runtime refresh is, by
      // definition, captured now.
      fetchedAt = new Date().toISOString();
      snapshot = transformUpstreamPricing(upstream, fetchedAt);
    } catch (err) {
      // Deliberately no `body.cancel()` on this arm: every path that reaches it
      // has already locked (and usually consumed) the stream, and `cancel()` on
      // a locked stream returns a REJECTED promise which this `catch` — already
      // unwinding — would not catch. It would reach `unhandledRejection`, i.e.
      // sidecar shutdown, which is strictly worse than the socket it saves.
      return fail(classify(err, "payload"), detailOf(err));
    }

    // The completeness floor — the last gate before the swap. See
    // MIN_MODEL_RATIO for why the bar is where it is, and why it is measured
    // against the bundled snapshot. Runtime and release preparation share it.
    const fetchedModels = Object.keys(snapshot.models).length;
    const vendoredModels = Object.keys(pricingSnapshot.models).length;
    if (fetchedModels < vendoredModels * MIN_MODEL_RATIO) {
      return fail(
        "payload",
        `fetched snapshot carries ${fetchedModels} of the vendored ${vendoredModels} models — ` +
          `under the ${Math.ceil(vendoredModels * MIN_MODEL_RATIO)}-model completeness floor`,
      );
    }

    return { ok: true, fetchedAt, snapshot };
  } catch (err) {
    // Classify unexpected programmer or runtime errors separately from network failures.
    return fail(classify(err, "unknown"), detailOf(err));
  }
}

// Read a response body to text through a running byte counter, refusing to
// buffer past `maxBytes`. Throws on an oversized body — the caller classifies
// that as `payload` — and propagates a mid-read abort untouched so `classify`
// can call it the `timeout` it actually is.
async function readCappedBody(response: Response, maxBytes: number): Promise<string> {
  const body = response.body;
  // A 200 carrying no body at all is unparseable: the payload's fault, not the
  // network's. `undefined` as well as `null`, because a non-standard Response
  // may simply not carry the property.
  if (body === null || body === undefined) {
    throw new Error("upstream pricing response had no body");
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      // Stop pulling and drop the connection rather than draining the rest of
      // an unbounded body. `.catch` for the same reason the non-2xx arm has
      // one — a rejecting cancel must never reach `unhandledRejection`.
      void reader.cancel().catch(() => {});
      throw new Error(`upstream pricing payload exceeded the ${maxBytes}-byte ceiling`);
    }
    chunks.push(value);
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

// An abort ALWAYS means our own timeout fired. `refreshPricing` passes exactly
// one signal — `AbortSignal.timeout(timeoutMs)` — so there is no other abort
// source to confuse it with. Both DOMException names denote that same
// condition: `AbortSignal.timeout()` fires `TimeoutError` in production, and
// `AbortError` is how a hand-driven abort of the same signal presents (which is
// what the timeout test injects). Checked at every seam rather than only the
// fetch one, because a body read can abort mid-flight too — reporting that as
// `payload` would blame the data for a stalled network.
function classify(err: unknown, otherwise: PricingFailureKind): PricingFailureKind {
  const aborted =
    err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
  return aborted ? "timeout" : otherwise;
}

function detailOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Callers decide how to report a failed fetch; active prices are never changed here.
function fail(kind: PricingFailureKind, detail: string): PricingFetchResult {
  return { ok: false, kind, detail };
}

export type PricingFetchResult =
  | { ok: true; fetchedAt: string; snapshot: PricingSnapshot }
  | Extract<RefreshPricingResult, { ok: false }>;
