import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { insideTauri } from "./tauri";

// Tauri updater wiring (Task 6.8). `check()` hits the `plugins.updater`
// endpoint in tauri.conf.json — a GitHub `latest.json` — and verifies the
// bundle signature against the configured pubkey. Both `check()` and
// `relaunch()` throw outside a Tauri host (standalone Vite dev), so every
// entry point guards on `insideTauri()`.

// Result of a non-installing update probe. The launch check uses this to
// decide whether to surface a prompt; the Settings section reuses it for the
// "up to date" message.
export type UpdateProbe =
  | { status: "unsupported" } // not running inside Tauri
  | { status: "up-to-date" }
  | { status: "available"; version: string; update: Update };

// Probe for an update without installing anything. Lets the launch check show
// a non-blocking prompt *before* the download starts.
export async function detectUpdate(): Promise<UpdateProbe> {
  if (!insideTauri()) return { status: "unsupported" };

  const update = await check();
  if (!update) return { status: "up-to-date" };
  return { status: "available", version: update.version, update };
}

// Download + install a previously-probed update, then relaunch. The relaunch
// terminates the process, so callers should treat the resolved promise as the
// last statement they will run.
export async function applyUpdate(update: Update): Promise<void> {
  await update.downloadAndInstall();
  await relaunch();
}

// Convenience for the manual "Check for updates" button: probe and, if an
// update exists, immediately apply it (a manual click is itself the consent).
// Resolves to the new version when an update was applied.
export type UpdateOutcome =
  | { status: "unsupported" }
  | { status: "up-to-date" }
  | { status: "updated"; version: string };

export async function checkForUpdate(): Promise<UpdateOutcome> {
  const probe = await detectUpdate();
  if (probe.status !== "available") return probe;
  await applyUpdate(probe.update);
  return { status: "updated", version: probe.version };
}
