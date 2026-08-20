import { networkInterfaces } from "node:os";
import { isCgnat, isLoopbackHost, isTailscaleUla } from "@maxprice/shared";

// Tailnet-bound + loopback (ADR-0035): the hub binds its Tailscale address —
// WireGuard provides encryption + machine identity; same-LAN peers still get
// a direct local path — plus 127.0.0.1 for same-machine clients. Tailscale
// assigns BOTH an IPv4 from the CGNAT range 100.64.0.0/10 AND an IPv6 ULA
// from fd7a:115c:a1e0::/48, which is how we find the interface without
// shelling out to the tailscale CLI. Both must be bound (ADR-0038 amendment):
// MagicDNS serves A and AAAA records for the machine name, and a client that
// prefers the AAAA connects to a dead address on a v4-only hub — "works by
// IP, not by hostname".
//
// The CGNAT / Tailscale-ULA / loopback classifiers live in @maxprice/shared
// (the desktop Settings warning and the hub operator console classify a host
// with the same rules); this module re-exports them so existing importers of
// bind.ts keep working.

export { isCgnat, isLoopbackHost, isTailscaleUla } from "@maxprice/shared";

export type Ifaces = ReturnType<typeof networkInterfaces>;

// ── Presence gating (ADR-0074) ───────────────────────────────────────────────
// Bun answers EVERY listen failure with EADDRINUSE — verified: binding an
// address this machine does not have, on a completely free port, throws
// "Failed to start server. Is port N in use?". So a catch can never tell "the
// address isn't here" from "another process owns the port". The interface table
// is the classifier instead: an address the OS doesn't report is not offered for
// binding at all, which leaves a throw from a PRESENCE-GATED host meaning one
// thing — a port conflict, i.e. a second hub instance — and keeps that fatal at
// boot.
//
// That guarantee is exactly as narrow as the gate. Two host shapes are NOT gated
// and so carry none of it: a hostname (never in the interface table, so gating
// it would strand a working config on loopback forever) and a loopback literal
// (exempt for the reason spelled out at the gate itself). A throw from either
// may equally mean "that address isn't here", so a boot bind failure on one of
// those degrades and retries on the reconciler's next tick instead of killing
// the daemon. `isBindClassifiable` below is the predicate the boot path asks to
// tell the two apart.

// `::ffff:a.b.c.d` and its expanded `0:0:0:0:0:ffff:a.b.c.d` spelling. The
// leading zero/compression prefix is matched loosely on purpose — hub.json is
// hand-edited, and every all-zero prefix before `ffff:` means the same address.
const V4_MAPPED = /^[0:]*:ffff:(\d{1,3}(?:\.\d{1,3}){3})$/;

// Canonical form for comparing two spellings of one address. hub.json's `bind`
// is hand-editable, so `FD7A:115C:A1E0:0:0:0:AB12:CD34` must match the
// `fd7a:115c:a1e0::ab12:cd34` that node:os reports, or we'd refuse to bind an
// address that plainly exists. Lowercases, drops any %zone suffix, folds an
// IPv4-mapped form to its dotted quad, expands `::` and strips per-hextet
// leading zeros.
//
// The v4-mapped fold is load-bearing, not a nicety. node:os reports such an
// interface ONLY as a plain dotted quad (`192.168.1.20`, family IPv4) and never
// in the mapped spelling, so without the fold no comparison against the table
// could ever succeed: `bind: "::ffff:192.168.1.20"` — a form Bun binds perfectly
// well (measured on win32, as are `::ffff:100.126.206.97` and
// `::ffff:127.0.0.1`) — would sit on `Waiting for` forever while the reconciler
// re-ran the impossible comparison every 10s. Any OTHER v4-in-v6 form
// (`::a.b.c.d`) is left alone: it has no dotted-quad equivalent in the interface
// table either way, so folding it would buy nothing.
function canonicalHost(host: string): string {
  const h = (host.split("%")[0] ?? "").toLowerCase();
  if (!h.includes(":")) return h;
  const mapped = V4_MAPPED.exec(h);
  if (mapped) return mapped[1]!;
  if (h.includes(".")) return h;
  let parts: string[];
  if (h.includes("::")) {
    const [head = "", tail = ""] = h.split("::");
    const headParts = head === "" ? [] : head.split(":");
    const tailParts = tail === "" ? [] : tail.split(":");
    const missing = 8 - headParts.length - tailParts.length;
    if (missing < 0) return h;
    parts = [...headParts, ...Array<string>(missing).fill("0"), ...tailParts];
  } else {
    parts = h.split(":");
  }
  return parts.map((p) => p.replace(/^0+/, "") || "0").join(":");
}

// Only an IP LITERAL can be presence-checked. A MagicDNS name or any other
// hostname never appears in the interface table, so gating it would degrade a
// working config to loopback forever; those go to the OS as before, where a
// resolution failure is a bind failure like any other.
function isIpLiteral(host: string): boolean {
  return host.includes(":") || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host);
}

function machineHasAddress(host: string, ifaces: Ifaces): boolean {
  const target = canonicalHost(host);
  for (const list of Object.values(ifaces)) {
    for (const iface of list ?? []) {
      if (canonicalHost(iface.address) === target) return true;
    }
  }
  return false;
}

// Can the presence gate vouch for this host — i.e. is a throw from binding it
// NECESSARILY a port conflict? True for a wildcard (gate-exempt in
// `resolveBindHosts`, but genuinely always bindable, so a throw on it really is
// a conflict) and for an IP literal the machine actually reports. False for a
// hostname (never in the table) and for a literal the machine does not have,
// where a throw may equally mean "that address isn't here yet".
//
// The boot path uses it to decide whether a bind failure is fatal: fatal for a
// vouched-for host, degrade-and-retry otherwise. Second-instance detection
// survives that softening because every non-wildcard desired list starts with
// `127.0.0.1` — always in the table, always classifiable, and bound first — so a
// second hub still dies loudly on the port it would have stolen.
export function isBindClassifiable(host: string, ifaces: Ifaces): boolean {
  if (host === "0.0.0.0" || host === "::") return true;
  return isIpLiteral(host) && machineHasAddress(host, ifaces);
}

export function tailnetIPv4(ifaces: Ifaces = networkInterfaces()): string | null {
  for (const list of Object.values(ifaces)) {
    for (const iface of list ?? []) {
      if (iface.family === "IPv4" && !iface.internal && isCgnat(iface.address)) {
        return iface.address;
      }
    }
  }
  return null;
}

export function tailnetIPv6(ifaces: Ifaces = networkInterfaces()): string | null {
  for (const list of Object.values(ifaces)) {
    for (const iface of list ?? []) {
      if (iface.family === "IPv6" && !iface.internal && isTailscaleUla(iface.address)) {
        return iface.address;
      }
    }
  }
  return null;
}

// The returned `warning` is USER-FACING copy since ADR-0049: it rides
// `HubStatus.bindWarning` and the operator console renders it verbatim in a
// warning inset (as well as going to stderr). Write full sentences here; don't
// regress these to log-fragment style.
//
// This is a PURE function of (config, interface table) and is re-evaluated on
// every reconciler tick (ADR-0074) — it is no longer the boot-time snapshot it
// was through ADR-0038. Keep it pure: it runs ~8,640 times a day.
//
// INVARIANT — a loopback-only bind returns a warning ONLY when the loopback was
// NOT what the operator asked for (today: `bind: "tailnet"` that found no
// interface, or an explicit IP the machine does not have yet).
// `isDeliberateLoopback` in apps/hub-desktop/src/lib/presentation.ts
// infers "chosen loopback vs failed tailnet" from the mere PRESENCE of a
// warning, so a new warning on an intentionally loopback-only bind would repaint
// a chosen state with a fault color. Adding one means updating that function too.
export function resolveBindHosts(
  bind: string,
  ifaces: Ifaces = networkInterfaces(),
): { hosts: string[]; warning: string | null } {
  if (bind === "loopback") return { hosts: ["127.0.0.1"], warning: null };
  if (bind === "tailnet") {
    const v4 = tailnetIPv4(ifaces);
    const v6 = tailnetIPv6(ifaces);
    if (v4 === null && v6 === null) {
      return {
        hosts: ["127.0.0.1"],
        // Names the remedy (F8) — and since ADR-0074 the remedy is nothing at
        // all: the bind reconciler re-resolves every 10s and binds Tailscale
        // the moment it appears, so this copy must never again tell the
        // operator to restart the hub. ONE string covers both "Tailscale hasn't
        // come up yet" (the login race an autostarted hub loses on every
        // reboot) and "Tailscale went away", because the remedy is identical.
        warning:
          "No tailnet interface — the hub is serving loopback only. It will bind Tailscale automatically as soon as it connects.",
      };
    }
    // Either family alone is a working tailnet (some tailnets disable v6) —
    // no warning; MagicDNS only serves records for addresses that exist.
    return {
      hosts: ["127.0.0.1", ...(v4 !== null ? [v4] : []), ...(v6 !== null ? [v6] : [])],
      warning: null,
    };
  }
  // Explicit IP. A wildcard bind (0.0.0.0 / ::) already covers loopback, so
  // prepending 127.0.0.1 would make two Bun.serve binds fight over one port
  // (EADDRINUSE) and crash the unguarded bind loop at boot — bind only the
  // wildcard. Any other explicit IP is deduped against the always-present
  // loopback.
  const isWildcard = bind === "0.0.0.0" || bind === "::";
  // Every classification below is on the CANONICAL form, while the host STRING
  // that gets bound stays the operator's verbatim spelling (Bun accepts both).
  // isLoopbackHost / isCgnat / isTailscaleUla are pure string tests, so without
  // this a genuine tailnet address written `::ffff:100.126.206.97` would be told
  // its traffic is unencrypted, and a mapped loopback would be presence-gated.
  const canon = canonicalHost(bind);
  // Presence-gate the explicit address (ADR-0074). A wildcard is exempt because
  // it is always bindable, and a hostname because it can never be checked (see
  // isIpLiteral). Loopback literals are exempt for a subtler reason: 127/8
  // ALIASES bind successfully while being ABSENT from the interface table —
  // measured, `127.0.0.1` and `::1` DO appear (as internal:true) but `127.0.0.2`
  // does not, and on Linux the whole 127/8 range binds — so gating them would
  // strand a working `bind: "127.0.0.2"` on a permanent `Waiting for`.
  //
  // Before this gate, an explicit tailnet IP made the unguarded boot bind THROW
  // when an autostarted hub beat Tailscale to the interface — the daemon exited
  // 1 at login rather than degrading. Now it degrades like the tailnet branch,
  // and the reconciler binds the address when it shows up.
  if (
    !isWildcard &&
    !isLoopbackHost(canon) &&
    isIpLiteral(bind) &&
    !machineHasAddress(bind, ifaces)
  ) {
    return {
      hosts: ["127.0.0.1"],
      warning: `Waiting for ${bind} — the hub is serving loopback only until that address exists.`,
    };
  }
  const hosts = isWildcard ? [bind] : [...new Set(["127.0.0.1", bind])];
  const warning =
    isLoopbackHost(canon) || isCgnat(canon) || isTailscaleUla(canon)
      ? null
      : `Bound ${bind}, which is not a loopback or tailnet address — traffic is unencrypted and protected only by the hub password (if one is set). Only use this on a trusted interface.`;
  return { hosts, warning };
}
