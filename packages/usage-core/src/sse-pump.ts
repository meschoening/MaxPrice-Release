// The bounded write-chain SSE pump (ADR-0007), shared verbatim between the
// sidecar's `GET /api/stream` (apps/sidecar/src/index.ts) and the hub's
// `GET /api/stream` (apps/hub/src/server.ts). Both fan a pub/sub source out to
// an SSE client; the ONLY differences were the heartbeat discriminant string
// and the subscribe source, so the machinery lives here once.
//
// Transport-agnostic on purpose: usage-core depends only on `shared` + `zod`
// and must NOT pull in Hono. `stream` is typed to the minimal structural shape
// both apps' real Hono `SSEStreamingApi` objects already satisfy.

// The slice of Hono's `SSEStreamingApi` the pump touches. Structurally
// compatible with the real object both apps pass.
export type SSEPumpStream = {
  write: (chunk: string) => Promise<unknown>;
  writeSSE: (message: { event: string; data: string }) => Promise<unknown>;
  onAbort: (cb: () => void) => void;
};

// Fanout messages carry a `type` discriminant; every non-heartbeat message also
// carries a `data` payload (heartbeats lack it — hence the optional field).
export type SSEPumpMessage = { type: string; data?: unknown };

// Drive an SSE connection from a fanout subscription until the socket is
// severed. Writes are serialized through a promise chain so frames never
// interleave; the backlog is bounded so a client that stops draining (a
// backgrounded WebView) can't pile up pending writes plus their captured JSON
// payloads without limit. Past MAX_PENDING_WRITES we drop the subscription and
// end the stream — EventSource reconnects and resyncs from the status frame.
//
// Returns the promise the SSE handler should await: it resolves only when the
// connection aborts (or a write fails / the backlog overflows), at which point
// the subscription is already torn down.
export function streamSSEPump<M extends SSEPumpMessage>(
  stream: SSEPumpStream,
  subscribe: (cb: (message: M) => void) => () => void,
  heartbeatType: string,
): Promise<void> {
  const MAX_PENDING_WRITES = 64;
  let writeChain: Promise<unknown> = Promise.resolve();
  let pendingWrites = 0;
  let ended = false;
  // Assigned below; declared here because `enqueue`'s overflow path and
  // `stream.onAbort` both reference them before subscribe() returns.
  let unsubscribe: () => void = () => {};
  let endStream: () => void = () => {};

  const teardown = (): void => {
    if (ended) return;
    ended = true;
    unsubscribe();
    endStream();
  };

  const enqueue = (write: () => Promise<unknown>): void => {
    if (ended) return;
    if (pendingWrites >= MAX_PENDING_WRITES) {
      // Slow/stuck client — drop it rather than leak memory unboundedly.
      teardown();
      return;
    }
    pendingWrites += 1;
    writeChain = writeChain
      .then(write)
      .catch(() => {
        // Write failed — a single SSE TCP connection is terminal, so drop the
        // subscription and end the stream. Idempotent via the `ended` guard, so
        // racing with `stream.onAbort` is safe.
        teardown();
      })
      .finally(() => {
        pendingWrites -= 1;
      });
  };

  unsubscribe = subscribe((msg) => {
    if (msg.type === heartbeatType) {
      // SSE comment line — keeps proxies / WebView2 from dropping the pipe.
      enqueue(() => stream.write(": heartbeat\n\n"));
    } else {
      enqueue(() => stream.writeSSE({ event: msg.type, data: JSON.stringify(msg.data) }));
    }
  });

  // Park here until the socket is severed. A fanout's `close()` on shutdown
  // only empties the subscriber set — it does not resolve this promise.
  // `server.stop(true)` is what closes the connection, firing `stream.onAbort`
  // → `teardown` → `endStream`.
  return new Promise<void>((resolve) => {
    endStream = resolve;
    stream.onAbort(teardown);
  });
}
