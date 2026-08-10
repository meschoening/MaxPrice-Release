import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

// Tauri host detection. The renderer can run standalone under Vite with no
// Tauri host, where `invoke` throws. Every entry point that touches a Tauri
// API guards on this first (mirrors apps/desktop/src/lib/tauri.ts).
export function insideTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

// Which window this bundle woke up in (ADR-0050): ONE dist serves both the
// console (label `main`) and the tray popout (label `popout`); main.tsx mounts
// the matching root component. Outside Tauri, `?window=popout` selects the
// popout for browser-driven debug (Vite + Playwright).
//
// Both `window` reads are guarded. `insideTauri()` already short-circuits on a
// missing global, so a Tauri-LESS BROWSER — the documented Vite/Playwright debug
// path — takes the query-string branch with a perfectly good `window`. The one
// host with no `window` at all is `bun test` (this app has no SSR and no
// workers); it can't be a popout, so it falls through to the console default
// rather than throwing.
export function currentWindowLabel(): "main" | "popout" {
  let label: string | null = null;
  if (insideTauri()) label = getCurrentWebviewWindow().label;
  else if (typeof window !== "undefined")
    label = new URLSearchParams(window.location.search).get("window");
  return label === "popout" ? "popout" : "main";
}

// Resolve a string-returning Tauri command with backoff. The command may
// transiently return Err (e.g. "hub not ready") between window creation and
// the daemon's stdout handshake; we poll for up to ~6s before giving up.
async function resolveFromTauri(command: string, label: string): Promise<string> {
  const deadline = Date.now() + 6_000;
  let delay = 50;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      return await invoke<string>(command);
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 1.5, 400);
    }
  }
  throw new Error(`${label} unavailable: ${String(lastErr)}`);
}

// Both daemon secrets — the base URL and the operator token — resolve the same
// way: a memoized single-flight around a string-returning Tauri command, with a
// Vite env-var fallback for standalone (non-Tauri) runs. `envFallback` is a
// THUNK so Vite's static `import.meta.env.VITE_*` replacement still fires at the
// call site while the read stays deferred to resolution time.
function makeCachedResolver(
  command: string,
  label: string,
  envFallback: () => string | undefined,
): () => Promise<string> {
  let cached: string | null = null;
  let pending: Promise<string> | null = null;
  return async () => {
    if (cached) return cached;
    if (pending) return pending;
    pending = (async () => {
      if (insideTauri()) {
        const value = await resolveFromTauri(command, label);
        cached = value;
        return value;
      }
      const fallback = envFallback();
      if (fallback) {
        cached = fallback;
        return fallback;
      }
      throw new Error(`${label} unavailable — not inside Tauri and its env fallback is unset.`);
    })();
    try {
      return await pending;
    } finally {
      pending = null;
    }
  };
}

// The embedded hub daemon's base URL ("http://127.0.0.1:<port>"), from the Rust
// `get_hub_url` command once it has read the LISTENING line (contract §6).
export const getHubUrl = makeCachedResolver(
  "get_hub_url",
  "hub URL",
  () => import.meta.env.VITE_HUB_URL,
);

// The embedded hub daemon's per-launch operator secret (ADR-0037), from the
// Rust `get_operator_token` command once it has captured the OPERATOR_TOKEN
// line. The webview attaches it as `Authorization: Bearer <secret>` to every
// /api/* call (Phase 3); it always passes the daemon's auth gate.
export const getOperatorToken = makeCachedResolver(
  "get_operator_token",
  "operator token",
  () => import.meta.env.VITE_HUB_OPERATOR_TOKEN,
);

// Set the tray icon's tooltip — a plain one-shot call, not a cached resolver:
// it is a write, it runs on every status change, and there is nothing to
// memoize. The renderer composes the whole string (ADR-0049); Rust sets it
// verbatim. Outside Tauri there is no tray, so this is a no-op — the guard
// lives here rather than at each call site. The returned promise REJECTS when
// the command fails (a missing tray, a platform error from `set_tooltip`);
// callers must handle it, because while the window is hidden the tooltip is
// the only hub UI there is.
export async function setTrayTooltip(tooltip: string): Promise<void> {
  if (!insideTauri()) return;
  await invoke("set_tray_tooltip", { tooltip });
}

// The popout's three actions (ADR-0050). All window manipulation lives in
// Rust — these are one-shot commands, no-ops outside Tauri like the tooltip.
// open_main_window hides the popout and shows the console in ONE command so
// the blur-hide debounce can't race a second IPC round-trip; quit_app is
// literally app.exit(0) — the single teardown chokepoint; hide_popout is the
// Esc dismissal (blur dismissal never leaves Rust).
export async function openMainWindow(): Promise<void> {
  if (!insideTauri()) return;
  await invoke("open_main_window");
}
export async function quitApp(): Promise<void> {
  if (!insideTauri()) return;
  await invoke("quit_app");
}
export async function hidePopout(): Promise<void> {
  if (!insideTauri()) return;
  await invoke("hide_popout");
}
