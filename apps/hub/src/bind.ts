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

type Ifaces = ReturnType<typeof networkInterfaces>;

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
// INVARIANT — a loopback-only bind returns a warning ONLY when the loopback was
// NOT what the operator asked for (today: `bind: "tailnet"` that found no
// interface). `isDeliberateLoopback` in apps/hub-desktop/src/lib/presentation.ts
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
        // Names the remedy (F8): resolution is a boot-time snapshot
        // (resolveBindHosts runs ONCE, at startup), so an operator who starts
        // Tailscale after a login race must restart the hub for it to re-bind —
        // the warning has to say so, matching the events-down inset's "Restart
        // the hub."
        warning:
          "No tailnet interface found — the hub bound loopback only. Start Tailscale, then restart the hub.",
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
  const hosts = isWildcard ? [bind] : [...new Set(["127.0.0.1", bind])];
  const warning =
    isLoopbackHost(bind) || isCgnat(bind) || isTailscaleUla(bind)
      ? null
      : `Bound ${bind}, which is not a loopback or tailnet address — traffic is unencrypted and protected only by the hub password (if one is set). Only use this on a trusted interface.`;
  return { hosts, warning };
}
