import { invoke } from "@tauri-apps/api/core";
import { insideTauri } from "@/lib/tauri";

// A relaunch the user asked for (ADR-0112 §5): the Boot gate's "Try again",
// the Engine stop card's Relaunch and the popout's. It goes through the
// shell's `relaunch_app`, which restarts the app with the launch's own
// arguments minus `--hidden`, so the window comes back even after a login
// launch. plugin-process's `relaunch()` re-passes them all and would bring a
// login launch back tray-only; it stays the updater's (lib/updater.ts), whose
// relaunch keeps the launch's arguments on purpose. Outside Tauri, a reload
// stands in. A rejection reaches the caller, which logs it.
export async function relaunchApp(): Promise<void> {
  if (!insideTauri()) {
    window.location.reload();
    return;
  }
  await invoke("relaunch_app");
}
