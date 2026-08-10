import { check, type Update } from "@tauri-apps/plugin-updater";
import { platform } from "@tauri-apps/plugin-os";
import { insideTauri } from "@/lib/tauri";

// The hub's updater wiring (map #143). A DUPLICATE of the client's
// `apps/desktop/src/lib/updater.ts`, deliberately not shared: `packages/shared`
// carries exactly one dependency (zod), zero Tauri, and is imported by the
// headless Bun sidecar — a Tauri plugin dep there would be a category error.
// The repo already settled this shape once, with `lib/theme.ts` duplicated in
// both apps while only its pure helper lives in shared.
//
// It is not a straight copy, and the difference is the point:
//
//  - The client FUSES probe and install (`checkForUpdate`), because a click in
//    its Settings page is itself consent — relaunching the client inconveniences
//    only the person clicking. Here the operator acts on behalf of a fleet: the
//    daemon holds the claude.ai poll and every connected client's HTTP+SSE
//    connection, so "the hub will restart" is a fact to read BEFORE it happens.
//    Probe and install are therefore SEPARATELY callable and never fused.
//  - The platform gate is STATIC. `check()` returns null for BOTH "you are up to
//    date" and "the manifest has no entry for your platform", indistinguishably,
//    so a manifest-driven answer would print "Up to date" to a macOS host a
//    version behind. `platform()` cannot make that mistake.
//
// Both `check()` and the plugin calls throw outside a Tauri host (standalone
// Vite dev), so every entry point guards on `insideTauri()` first.

// Whether this host can take an automatic update AT ALL.
//
// Windows-only BY SCOPE, NOT BY BUG: ADR-0050 scopes the packaged tray app to
// Windows, and `compose-updater-manifest.ts` asserts the hub's platform coverage
// as `windows-x86_64` alone (ADR-0071). Linux hub hosts never see the answer —
// they run headless `maxprice-hub serve` and have no console to put a card in.
export function updatesSupported(): boolean {
  if (!insideTauri()) return false;
  return platform() === "windows";
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
 * The NSIS updater ends this process itself (#144: the plugin exits the shell
 * with `std::process::exit(0)`, then the installer relaunches via `/R`), so a
 * caller should treat the resolved promise as the last statement it will run.
 * Deliberately no `relaunch()` call of the client's kind: the installer owns the
 * restart on Windows, which is the only platform that reaches this function.
 */
export async function applyUpdate(update: Update): Promise<void> {
  await update.downloadAndInstall();
}
