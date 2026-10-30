import type { Context } from "hono";
import { canonicalHost, isLoopbackHost } from "./bind";

// Who is on the other end of a request's socket: the one read of it, shared by
// the client roster's remoteAddr (server.ts, ADR-0036) and the Hub page's
// loopback guard (page.ts, ADR-0124 §2).
//
// Bun passes its Server as the Hono fetch `env`; `requestIP` resolves the
// client's socket address. Absent under Hono's app.request() test harness (→
// null), and any failure degrades to null. The roster's remoteAddr is
// best-effort (tailnet/loopback IP when resolvable); the page guard refuses a
// null peer.
export function socketPeerAddress(c: Context): string | null {
  const server = c.env as { requestIP?: (req: Request) => { address: string } | null } | undefined;
  try {
    return server?.requestIP?.(c.req.raw)?.address ?? null;
  } catch {
    return null;
  }
}

// True only when the socket peer is this machine (ADR-0124 §2). An unknown
// peer (null, undefined, empty) is refused. The address is canonicalised first,
// as bind.ts compares addresses: a dual-stack `::` listener reports an IPv4 peer
// as `::ffff:127.0.0.1`, which isLoopbackHost alone does not recognise.
export function isLoopbackPeer(address: string | null | undefined): boolean {
  if (address === null || address === undefined || address === "") return false;
  return isLoopbackHost(canonicalHost(address));
}
