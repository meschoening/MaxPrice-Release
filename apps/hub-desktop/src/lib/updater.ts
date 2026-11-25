import { check, type Update } from "@tauri-apps/plugin-updater";
import { platform, type Platform } from "@tauri-apps/plugin-os";
import { insideTauri, relaunchApp } from "@/lib/tauri";

// The hub's updater wiring (map #143). A DUPLICATE of the client's
// `apps/desktop/src/lib/updater.ts`, deliberately not shared: `packages/shared`
// carries exactly one dependency (zod), zero Tauri, and is imported by the
// headless Bun sidecar — a Tauri plugin dep there would be a category error.
// The repo already settled this shape once, with `lib/theme.ts` duplicated in
// both apps while only its pure helper lives in shared.
//
// It is not a straight copy, and the difference is the point:
//
//  - Probe and install are SEPARATELY callable and never fused. The client
//    reached the same shape later (#150), so this is no longer a difference —
//    but the reason here is stronger and worth keeping stated: the operator acts
//    on behalf of a fleet. The daemon holds the claude.ai poll and every
//    connected client's HTTP+SSE connection, so "the hub will restart" is a fact
//    to read BEFORE it happens, not a consequence to discover.
//  - The platform gate is STATIC, and allows the platforms hub-latest.json
//    carries: Windows and macOS (ADR-0148 §7), as the client's allows Mac +
//    Windows. A manifest-driven answer could not do the job: `check()` returns
//    null for BOTH "you are up to date" and "the manifest has no entry for your
//    platform", indistinguishably, so it would print "Up to date" to a host a
//    version behind. `platform()` cannot make that mistake.
//  - `applyUpdate` restarts through the shell's `relaunch_app`, not the process
//    plugin's `relaunch()`: on macOS the hub's daemon must end before the new
//    app binds its fixed port, and `relaunch_app` exits through the one
//    teardown chokepoint that ends it (ADR-0112). On Windows the NSIS installer
//    owns the restart (see below).
//
// Both `check()` and the plugin calls throw outside a Tauri host (standalone
// Vite dev), so every entry point guards on `insideTauri()` first.

/**
 * Whether a host on `os` (plugin-os's `platform()`) can take an automatic
 * update AT ALL. Pure half, so the rule is pinnable without a Tauri host.
 *
 * The platforms hub-latest.json carries (ADR-0148 §7): `compose-updater-
 * manifest.ts` asserts the hub's coverage as `darwin-aarch64` and
 * `windows-x86_64`. An ALLOWLIST, the client's shape: a host the manifest has
 * no key for would have every check rejected with TargetsNotFound. Linux hub
 * hosts never see the answer — they run headless `maxprice-hub serve` and have
 * no console to put a card in; only a tray app run from source does.
 */
export function updatesSupportedOn(os: Platform): boolean {
  return os === "windows" || os === "macos";
}

export function updatesSupported(): boolean {
  if (!insideTauri()) return false;
  return updatesSupportedOn(platform());
}

// Result of a non-installing probe. `update` is the plugin handle the install
// step needs, so the caller must hold onto it — re-probing to install would
// double the round-trips and could answer differently in between.
export type UpdateProbe =
  | { status: "unsupported" }
  | { status: "up-to-date" }
  | { status: "available"; version: string; update: Update };

/**
 * Probe for an update without installing anything. Step 1 of the two-step.
 *
 * Rejects on a channel failure (a 404, a dead network, an unparseable manifest)
 * — the caller decides whether that is a state worth showing. It is when a human
 * asked; it is not on the launch probe.
 */
export async function detectUpdate(): Promise<UpdateProbe> {
  if (!updatesSupported()) return { status: "unsupported" };

  const update = await check();
  if (!update) return { status: "up-to-date" };
  return { status: "available", version: update.version, update };
}

/**
 * Download + install a previously-probed update. Step 2 of the two-step.
 *
 * On Windows the NSIS updater ends this process itself (#144: the plugin exits
 * the shell with `std::process::exit(0)`, then the installer relaunches via
 * `/R`), so the install never returns there. On macOS it returns once the new
 * .app has replaced the old one, and `relaunch_app` ends the daemon and starts
 * the new app (ADR-0112's Restart hub). Either way a caller should treat the
 * resolved promise as the last statement it will run.
 */
export async function applyUpdate(
  update: Pick<Update, "downloadAndInstall">,
  host: InstallHost = { os: platform, relaunch: relaunchApp },
): Promise<void> {
  await update.downloadAndInstall();
  if (host.os() === "macos") await host.relaunch();
}

/** What `applyUpdate` asks of the host: its OS, and the shell's `relaunch_app`. */
export type InstallHost = { os: () => Platform; relaunch: () => Promise<void> };
