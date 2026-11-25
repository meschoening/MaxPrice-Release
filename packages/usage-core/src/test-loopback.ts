// What a test's loopback fake or stub records and counts (#596). A fresh
// loopback listener is not the client's alone: any process may connect to it,
// as T3 Code's `t3 serve` sends `GET /` to each listener its tree opens. So a
// recorder keeps only requests its client could send, a path under the fake's
// API base or one the test hands the client, and a connection counter counts
// only connections whose first request line names the path the test handed
// out. Everything else is answered as before but never recorded or counted.
// `bun scripts/loopback-prober.ts -- bun run test` is the proof harness.
// NOT exported from the package barrel — import via
// "@maxprice/usage-core/test-loopback" so compiled binaries never bundle it.
import type { Socket } from "node:net";

/** The pathname of a request, a URL, or an origin- or absolute-form target. */
function pathnameOf(target: Request | URL | string): string {
  if (target instanceof Request) return new URL(target.url).pathname;
  if (target instanceof URL) return target.pathname;
  return new URL(target, "http://loopback.invalid").pathname;
}

/**
 * Whether a request is one the client under test could send: its path is one
 * of `bases`, or lies under one that ends in a slash (`/api/` covers
 * `/api/status`, `/healthz` only itself). The query string never counts.
 */
export function clientPath(target: Request | URL | string, bases: readonly string[]): boolean {
  const path = pathnameOf(target);
  return bases.some((base) => (base.endsWith("/") ? path.startsWith(base) : path === base));
}

/**
 * Whether a request a stand-in proxy received is one the client routed
 * through it: a request for another origin. A request for the proxy's own
 * origin (a prober's `GET /`) was never the client's.
 */
export function proxiedElsewhere(request: Request, proxyPort: number | undefined): boolean {
  return new URL(request.url).port !== String(proxyPort);
}

/**
 * The target of an HTTP request line (`GET /x HTTP/1.1` gives `/x`), or null
 * for anything that is not one.
 */
export function requestTarget(line: string): string | null {
  const m = /^[A-Z]+ (\S+) HTTP\/1\.[01]$/.exec(line.replace(/\r?\n$/, "").replace(/\r$/, ""));
  return m ? m[1]! : null;
}

/**
 * Waits for a raw connection's first request line and says whether it names
 * one of `bases` (by `clientPath`'s rule). Null when the connection closes or
 * errors before a whole line arrives. The bytes read stay with the caller:
 * `head` is everything received up to the decision, so a stub can go on
 * parsing what it already took off the socket. The socket is paused once the
 * line is in; a caller that reads on calls `socket.resume()`.
 */
export function firstLine(
  socket: Socket,
  bases: readonly string[],
): Promise<{ ours: boolean; head: Buffer } | null> {
  return new Promise((resolve) => {
    let head = Buffer.alloc(0);
    const done = (result: { ours: boolean; head: Buffer } | null) => {
      socket.pause();
      socket.off("data", onData);
      socket.off("close", onClose);
      socket.off("error", onClose);
      resolve(result);
    };
    const onData = (chunk: Buffer) => {
      head = Buffer.concat([head, chunk]);
      const eol = head.indexOf("\n");
      if (eol === -1) return;
      const target = requestTarget(head.subarray(0, eol + 1).toString("latin1"));
      done({ ours: target !== null && clientPath(target, bases), head });
    };
    const onClose = () => done(null);
    socket.on("data", onData);
    socket.on("close", onClose);
    socket.on("error", onClose);
  });
}

/** A foreign raw connection's answer: a 404, then the connection closed. */
export function refuseForeign(socket: Socket): void {
  socket.end("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
}

/**
 * Sends `origin` the request T3 Code's port probe sends, `GET /` with UA
 * `node` and a `traceparent` header, and gives the answer's status: the
 * foreign request a fake's own case answers without recording.
 */
export async function foreignProbe(origin: string): Promise<number> {
  const response = await fetch(new URL("/", origin), {
    headers: {
      "user-agent": "node",
      traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    },
    signal: AbortSignal.timeout(5_000),
  });
  await response.arrayBuffer();
  return response.status;
}
