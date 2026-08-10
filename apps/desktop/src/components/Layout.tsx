import { useEffect, useRef } from "react";
import { Outlet } from "react-router-dom";
import { useLiveStream } from "@/lib/live-stream";
import { useManualRefreshHotkey } from "@/state/use-manual-refresh-hotkey";
import { readCredential, pushCredentialToSidecar } from "@/lib/usage-credential";
import { readHubPassword, pushHubConfigToSidecar } from "@/lib/hub-config";
import { useSettings } from "@/state/use-settings";
import { insideTauri } from "@/lib/tauri";
import { useBootPhase } from "@/lib/boot-phase";
import { BootGate } from "./BootSplash";
import { Sidebar } from "./Sidebar";
import { Topbar } from "./Topbar";
import { UpdateGate } from "./UpdateGate";
import { ToastHost } from "./toast";

export function Layout() {
  useLiveStream();
  useManualRefreshHotkey();
  const { data: settings } = useSettings();

  // Push the stored credential to the sidecar once on mount so the usage
  // poller can start immediately without waiting for the Settings page to open
  // (ADR-0023). `pushCredentialToSidecar` awaits `getSidecarUrl` internally,
  // so this resolves once the sidecar is ready. Failures are swallowed — a
  // down sidecar at boot is non-fatal; the poller idles until the credential
  // is pushed later from the Settings page.
  useEffect(() => {
    void readCredential()
      .then((c) => pushCredentialToSidecar(c))
      .catch(() => {
        /* sidecar may not be up yet at boot; poller idles until pushed */
      });
  }, []);

  // Push the configured hub URL + stored keychain password to the sidecar ONCE
  // the settings first load (ADR-0035/0037), so the sidecar's hub connection
  // starts without waiting for the Settings page to open. This is BOOT-ONLY
  // (F35): hub-section's connect/disconnect/auto-heal own every subsequent push,
  // so a later Settings change must NOT re-push here — two racing configure()
  // calls per Settings action tore the hub connection down and rebuilt it. The
  // run-once ref is set BEFORE the empty-URL bail, so a fresh boot with no hub
  // that later connects from Settings never triggers a surprise second push from
  // this effect. Only under Tauri (the keychain read needs the host); a fresh
  // boot with no hub URL must NOT push (the sidecar defaults to `off`). Failures
  // are swallowed — a down sidecar at boot is non-fatal.
  const pushedHubConfig = useRef(false);
  useEffect(() => {
    if (pushedHubConfig.current || !insideTauri() || settings === undefined) return;
    pushedHubConfig.current = true;
    if (settings.hubUrl === "") return;
    void readHubPassword()
      .then((password) => pushHubConfigToSidecar(settings.hubUrl, password, settings.hubAutoHeal))
      .catch(() => {
        /* sidecar may not be up yet at boot; hub stays off until pushed */
      });
  }, [settings]);
  // The glass frame (glass.html .app): panels float on the body's wash with
  // ≥16px gaps. The sidebar is a detached frosted column; the main column is
  // the pill topbar over the routed page. Unlike the mock (whose whole page
  // scrolls), <main> stays the definite-height scroll container — the
  // un-migrated list pages' `h-full` layouts depend on it, and the topbar
  // staying put costs nothing at rest. StatusBar's diagnostics moved into the
  // sidebar's foot (relocation only — M2).
  //
  // BootGate holds the whole frame behind the full-window splash at launch —
  // the hooks above still run from first paint (the SSE stream is how `ready`
  // arrives). Two stages: `ready` MOUNTS the frame (hidden, so Live's queries
  // run during the hold — ADR-0066), and Live's first paint reveals it wearing
  // `.boot-frame`'s one-shot rise.
  return (
    <BootGate>
      <AppFrame />
    </BootGate>
  );
}

// The glass frame itself, split out so it can read the boot phase (ADR-0066).
// It is mounted — and its queries running — throughout the hold, so anything
// that paints or self-dismisses on a mount-time timer must wait for the reveal
// or it happens behind an opaque splash and is missed: UpdateGate's OTA probe
// and dialog, and ToastHost's dismiss timers. `data-boot` drives both the
// hidden hold and the rise (which would otherwise be spent while hidden and
// leave the frame popping in flat).
function AppFrame(): React.ReactElement {
  const phase = useBootPhase();
  return (
    <div
      data-boot={phase}
      aria-hidden={phase === "hold" || undefined}
      className="boot-frame h-screen w-screen flex gap-5 p-4 max-w-[1500px] mx-auto text-text"
    >
      {phase === "reveal" ? (
        <>
          <UpdateGate />
          <ToastHost />
        </>
      ) : null}
      <Sidebar />
      <div className="flex-1 min-w-0 flex flex-col gap-[18px]">
        <Topbar />
        <main className="thin-scroll flex-1 min-h-0 overflow-auto -m-2 p-2">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
