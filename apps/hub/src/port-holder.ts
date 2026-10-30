import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import { canonicalHost } from "./bind";

// Who holds a TCP port, for serve's line about a failed first bind (ADR-0127
// §2): the listening socket's inode from /proc/net/tcp and tcp6, then the
// process one of whose fds links to that socket. Linux's /proc only, and best
// effort: another user's processes keep their fds unreadable, so a socket
// they hold names nobody, and off Linux there is no /proc to read.

export type PortHolder = { pid: number; command: string };

// The three reads, injectable so a test can hand over its own /proc.
export type ProcFs = {
  read: (path: string) => string | null;
  list: (path: string) => string[];
  link: (path: string) => string | null;
};

const realProc: ProcFs = {
  read: (path) => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  },
  list: (path) => readdirSync(path),
  link: (path) => {
    try {
      return readlinkSync(path);
    } catch {
      return null;
    }
  },
};

const LISTEN = "0A";
const ANY4 = "0.0.0.0";
const ANY6 = "0:0:0:0:0:0:0:0";

// A /proc/net/tcp{,6} address as canonicalHost writes one: the kernel prints
// each 32-bit word in host (little-endian) byte order.
function procAddress(hex: string): string {
  const words = hex.match(/.{8}/g) ?? [];
  const bytes = words.flatMap((word) => (word.match(/../g) ?? []).reverse());
  if (bytes.length === 4) return bytes.map((byte) => parseInt(byte, 16)).join(".");
  // tcp6 prints mapped IPv4 in hex too, unlike canonicalHost's dotted input.
  if (
    bytes.slice(0, 10).every((byte) => byte === "00") &&
    bytes[10] === "FF" &&
    bytes[11] === "FF"
  ) {
    return bytes
      .slice(12)
      .map((byte) => parseInt(byte, 16))
      .join(".");
  }
  const groups: string[] = [];
  for (let i = 0; i < bytes.length; i += 2) groups.push(`${bytes[i]}${bytes[i + 1]}`);
  return canonicalHost(groups.join(":"));
}

// A wildcard on either side overlaps a specific address in that family.
// IPv6's wildcard may be dual-stack: /proc/net/tcp6 does not expose IPV6_V6ONLY,
// so it is a possible holder for IPv4 too (and conversely when binding ::).
// An IPv4 wildcard never overlaps a native, specific IPv6 address.
function addressesOverlap(local: string, target: string): boolean {
  if (local === target || local === ANY6 || target === ANY6) return true;
  return !local.includes(":") && !target.includes(":") && (local === ANY4 || target === ANY4);
}

// The inodes of sockets whose listening address can overlap the requested bind.
function listeningInodes(proc: ProcFs, host: string, port: number): Set<string> {
  const target = canonicalHost(host);
  const inodes = new Set<string>();
  for (const table of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    for (const line of (proc.read(table) ?? "").split("\n").slice(1)) {
      const fields = line.trim().split(/\s+/);
      const [address, portHex] = (fields[1] ?? "").split(":");
      if (fields[3] !== LISTEN || address === undefined || portHex === undefined) continue;
      if (parseInt(portHex, 16) !== port) continue;
      const local = procAddress(address);
      if (addressesOverlap(local, target)) inodes.add(fields[9] ?? "");
    }
  }
  inodes.delete("");
  inodes.delete("0");
  return inodes;
}

/** The process holding a listening socket on `host`:`port`, or null. */
export function findPortHolder(
  host: string,
  port: number,
  { proc = realProc, self = process.pid }: { proc?: ProcFs; self?: number } = {},
): PortHolder | null {
  const inodes = listeningInodes(proc, host, port);
  if (inodes.size === 0) return null;
  const sockets = new Set([...inodes].map((inode) => `socket:[${inode}]`));
  let pids: string[];
  try {
    pids = proc.list("/proc").filter((name) => /^\d+$/.test(name) && Number(name) !== self);
  } catch {
    return null;
  }
  for (const pid of pids) {
    let fds: string[];
    try {
      fds = proc.list(`/proc/${pid}/fd`);
    } catch {
      continue; // Another user's, or gone.
    }
    if (fds.some((fd) => sockets.has(proc.link(`/proc/${pid}/fd/${fd}`) ?? ""))) {
      const command = (proc.read(`/proc/${pid}/comm`) ?? "").trim();
      return { pid: Number(pid), command };
    }
  }
  return null;
}
