import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { insideTauri } from "./tauri";
import { saveWindowGeometry } from "./window-state";

// Tauri updater wiring (Task 6.8). `check()` hits the `plugins.updater`
// endpoint in tauri.conf.json — a GitHub `latest.json` — and verifies the
// bundle signature against the configured pubkey. Both `check()` and
// `relaunch()` throw outside a Tauri host (standalone Vite dev), so every
// entry point guards on `insideTauri()`.

// Result of a non-installing update probe. The launch check uses this to
// decide whether to surface a prompt; the Settings section reuses it for the
// "up to date" message.
export type UpdateProbe =
  | { status: "unsupported" } // not inside Tauri, or a platform this channel does not serve
  | { status: "up-to-date" }
  | { status: "available"; version: string; update: Update };

/** Pure half, so the rule is pinnable without a Tauri host. */
export function updatesSupportedOn(inTauri: boolean, platform: string): boolean {
  // ALLOWLIST, not a Linux denylist — the hub's shape (hub-desktop/src/lib/updater.ts:34).
  // ADR-0071 §5 excludes Linux from both channels on purpose (Tauri v2 can only
  // update an AppImage; this ships a .deb), and tauri-plugin-updater 2.10.1 calls
  // get_urls BEFORE the should-update branch (updater.rs:536), so a manifest with
  // no `linux-x86_64` key REJECTS the check with TargetsNotFound rather than
  // resolving "up to date". Without this gate every Linux check lands in the error
  // state forever, on a machine whose network and channel are both fine.
  return inTauri && /Mac|Win/i.test(platform);
}

export function updatesSupported(): boolean {
  if (typeof navigator === "undefined") return false;
  return updatesSupportedOn(insideTauri(), navigator.platform);
}

// Probe for an update without installing anything. Lets the launch check show
// a non-blocking prompt *before* the download starts.
export async function detectUpdate(): Promise<UpdateProbe> {
  if (!updatesSupported()) return { status: "unsupported" };

  const update = await check();
  if (!update) return { status: "up-to-date" };
  return { status: "available", version: update.version, update };
}

// Download + install a previously-probed update, then relaunch. The relaunch
// terminates the process, so callers should treat the resolved promise as the
// last statement they will run.
//
// The geometry flush leads because on Windows `downloadAndInstall` does not
// return: the updater hands the installer to ShellExecuteW and calls
// `std::process::exit(0)`, so `relaunch()` below is macOS-only in practice and
// the window-state plugin's save hooks never run (map #151, T8). This is the
// same abrupt exit ADR-0072 confines the sidecar to a job object for.
export async function applyUpdate(update: Update): Promise<void> {
  await saveWindowGeometry();
  await update.downloadAndInstall();
  await relaunch();
}

// There is deliberately no probe-and-install convenience here. One existed —
// `checkForUpdate()`, used by the Settings section, which read a click on
// "Check for updates" as consent to install whatever it found. That fused the
// only two moments a user needs kept apart: being told a version exists, and
// agreeing to take it. Every caller now probes with `detectUpdate`, shows what
// it found, and calls `applyUpdate` on a second, explicit click (#150).
