import { invoke } from "@tauri-apps/api/core";
import { insideTauri } from "./tauri";

let cached: string | null = null;
let pending: Promise<string> | null = null;

// Rust's get_sidecar_url has exactly two Err shapes (SidecarState): this
// Pending sentinel while the LISTENING handshake is in flight, and a
// SidecarStatus::Failed message (spawn failure / process death) for
// everything else.
const SIDECAR_PENDING_MESSAGE = "sidecar not ready";

// True for the one retryable get_sidecar_url error. Tauri rejects invoke
// with the command's Err value — a plain string here.
export function isSidecarPendingError(err: unknown): boolean {
  return String(err) === SIDECAR_PENDING_MESSAGE;
}

// A failed sidecar URL resolution, classified for the boot splash (T4):
// `terminal` means retrying cannot help within this launch — the sidecar
// process failed or died and the Rust shell never respawns in place, so only
// an app relaunch reruns the boot sequence. Non-terminal = the handshake
// just hasn't completed within the backoff window.
export class SidecarStartupError extends Error {
  readonly terminal: boolean;

  constructor(message: string, terminal: boolean) {
    super(message);
    this.name = "SidecarStartupError";
    this.terminal = terminal;
  }
}

// Resolve the sidecar base URL once per process. Rust exposes
// `get_sidecar_url` once it has read the LISTENING line from the sidecar's
// stdout (ADR-0002). The command may transiently return Err("sidecar not
// ready") between window creation and the handshake; we poll with backoff
// for up to ~6s before giving up. A SidecarStatus::Failed error short-circuits
// the poll instead of burning the deadline — the process is gone, and the
// splash's error card should say so now, not in six seconds.
async function resolveFromTauri(): Promise<string> {
  const deadline = Date.now() + 6_000;
  let delay = 50;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      return await invoke<string>("get_sidecar_url");
    } catch (err) {
      if (!isSidecarPendingError(err)) {
        throw new SidecarStartupError(String(err), true);
      }
      lastErr = err;
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 1.5, 400);
    }
  }
  throw new SidecarStartupError(`sidecar URL unavailable: ${String(lastErr)}`, false);
}

export async function getSidecarUrl(): Promise<string> {
  if (cached) return cached;
  if (pending) return pending;

  pending = (async () => {
    if (insideTauri()) {
      const url = await resolveFromTauri();
      cached = url;
      return url;
    }
    const fallback = import.meta.env.VITE_SIDECAR_URL;
    if (fallback) {
      cached = fallback;
      return fallback;
    }
    throw new SidecarStartupError(
      "Sidecar URL unavailable — not running inside Tauri and VITE_SIDECAR_URL is unset.",
      true,
    );
  })();

  try {
    return await pending;
  } finally {
    pending = null;
  }
}

// Discards the cached URL so the next getSidecarUrl() re-queries the Rust shell.
// Use after a fetch fails with ECONNREFUSED or when a sidecar restart is signalled
// — without this, a sidecar that restarts on a new port leaves callers with a
// stale base URL.
export function resetSidecarUrl(): void {
  cached = null;
  pending = null;
}

export async function sidecarFetch(path: string, init?: RequestInit): Promise<Response> {
  const base = await getSidecarUrl();
  const url = path.startsWith("http") ? path : `${base.replace(/\/$/, "")}${path}`;
  return fetch(url, init);
}
