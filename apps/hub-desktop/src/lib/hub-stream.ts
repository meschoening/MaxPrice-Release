import { HUB_SSE_EVENT, splitSseFrames } from "@maxprice/shared";
import { hubFetch } from "./hub-api";

export function nextHubReconnectDelay(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, 30_000);
}

// Backoff sleep seam (mirrors usage-core's hub-client setTimeoutImpl injection):
// production awaits a real timer; tests inject a controllable delay to drive the
// reconnect loop without real sleeps.
export type HubStreamDelay = (ms: number) => Promise<void>;
const realDelay: HubStreamDelay = (ms) => new Promise((r) => setTimeout(r, ms));

export type HubStreamHandlers = {
  onStatus: () => void;
  onMachines?: () => void;
  // Fired once per LOST connection, just before the reconnect backoff — both
  // when the read threw (the daemon died, the connect was refused, a non-2xx)
  // and when the daemon ended the stream cleanly. Deliberately NOT fired by the
  // returned unsubscribe fn: that is a teardown, not a fault. ADR-0049 makes
  // this news — the console's status query is the tray tooltip's only source.
  onDisconnect?: () => void;
};

// Fetch-based SSE subscriber — native EventSource can't carry the bearer that
// gates /api/stream, so we read the ReadableStream ourselves. Dispatches
// `onStatus()` on every hub:status / hub:sample frame (both change fields the
// status query owns: connection, sampleCount, usageLastSampleAt). Reconnects
// with backoff; the returned fn aborts the in-flight read and stops the loop.
export function subscribeHubStream(
  handlers: HubStreamHandlers,
  fetchImpl: typeof hubFetch = hubFetch,
  delayImpl: HubStreamDelay = realDelay,
): () => void {
  let stopped = false;
  let attempt = 0;
  let controller: AbortController | null = null;

  const run = async (): Promise<void> => {
    while (!stopped) {
      controller = new AbortController();
      try {
        const res = await fetchImpl("/api/stream", {
          signal: controller.signal,
          headers: { accept: "text/event-stream" },
        });
        if (!res.ok || !res.body) throw new Error(`hub stream ${res.status}`);
        attempt = 0;
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let carry = "";
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done || stopped) break;
            const split = splitSseFrames(carry, decoder.decode(value, { stream: true }));
            carry = split.remainder;
            for (const f of split.frames) {
              if (f.event === HUB_SSE_EVENT.status || f.event === HUB_SSE_EVENT.sample) {
                handlers.onStatus();
              }
              if (f.event === HUB_SSE_EVENT.machines) handlers.onMachines?.();
            }
          }
        } finally {
          reader.cancel().catch(() => {});
        }
      } catch {
        // fall through to backoff
      }
      if (stopped) break;
      // The channel is down. Announce it BEFORE sleeping — the backoff below
      // runs to 30s and a hidden window has nothing else to go on (ADR-0049).
      // Exactly one call per backoff cycle, and the backoff is the rate limit:
      // 1s, 2s, 4s, 8s, 16s, then 30s forever (attempt caps at 5), so a daemon
      // that stays down settles into one notification every 30s, never a spin.
      handlers.onDisconnect?.();
      await delayImpl(nextHubReconnectDelay(attempt));
      attempt = Math.min(attempt + 1, 5);
    }
  };
  void run();

  return () => {
    stopped = true;
    controller?.abort();
  };
}
