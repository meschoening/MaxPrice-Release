// Tailnet host classification. `isCgnat` / `isTailscaleUla` / `isLoopbackHost`
// are the ONE copy of these rules: they started in apps/hub/src/bind.ts (the hub
// daemon that discovers and binds its Tailscale interface), and living here lets
// the desktop Settings warning and the hub operator console classify a host
// without pulling in the hub package's node:os machinery. bind.ts now imports
// (and re-exports) them from here; so does apps/hub-desktop's presentation.ts.

export function isCgnat(addr: string): boolean {
  const m = /^100\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(addr);
  if (!m) return false;
  const second = Number(m[1]);
  return second >= 64 && second <= 127;
}

// Tailscale's IPv6 ULA range fd7a:115c:a1e0::/48. The first three hextets are
// nonzero, so every textual form of an address in the range carries them
// literally — a string prefix check is exact.
export function isTailscaleUla(addr: string): boolean {
  return addr.toLowerCase().startsWith("fd7a:115c:a1e0:");
}

// The expanded IPv6 loopback: eight hextets, the first seven zero and the last
// one — each written with 1–4 digits, so this covers `0:0:0:0:0:0:0:1`, the
// zero-padded `0000:0000:0000:0000:0000:0000:0000:0001`, and every spelling in
// between. The compressed `::1` is matched separately (no `::` here).
const EXPANDED_IPV6_LOOPBACK = /^0{1,4}(?::0{1,4}){6}:0{0,3}1$/;

// True when `host` — as produced by `new URL(...).hostname` (so an IPv6 literal
// is already bracket-stripped) — names THIS machine and nothing off it:
//   - "localhost" (case-insensitive)
//   - an IPv4 loopback (127.*)
//   - the IPv6 loopback in any spelling (::1, 0:0:0:0:0:0:0:1, zero-padded)
// This is the single loopback rule for the repo: the hub daemon's bind warning
// (apps/hub/src/bind.ts) and the operator console's reachability gates
// (apps/hub-desktop/src/lib/presentation.ts) both call it, so a host can never
// read as loopback in one place and as a reachable address in the other.
export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "localhost") return true;
  if (/^127\./.test(h)) return true;
  if (h === "::1") return true;
  return EXPANDED_IPV6_LOOPBACK.test(h);
}

// True when `host` — as produced by `new URL(...).hostname` (so an IPv6 literal
// is already bracket-stripped) — is a recognizably tailnet or loopback address:
//   - any loopback host (via isLoopbackHost): "localhost", 127.*, ::1 and its
//     expanded spellings
//   - an IPv4 literal in the CGNAT range 100.64.0.0/10 (via isCgnat)
//   - an IPv6 literal in the Tailscale ULA fd7a:115c:a1e0::/48 (via isTailscaleUla)
//   - any subdomain of ts.net — a MagicDNS FQDN (endsWith ".ts.net")
// Everything else returns false, INCLUDING a bare single-label MagicDNS name
// (no ".ts.net" suffix): it can't be positively placed on the tailnet from the
// host string alone. The desktop Settings warning this feeds deliberately warns
// on any host it can't classify, so an unrecognized value is the safe default.
export function isRecognizedTailnetHost(host: string): boolean {
  const h = host.toLowerCase();
  if (isLoopbackHost(h)) return true;
  if (h.endsWith(".ts.net")) return true;
  if (isCgnat(host)) return true;
  if (isTailscaleUla(host)) return true;
  return false;
}
