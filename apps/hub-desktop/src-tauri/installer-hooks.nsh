; MaxPrice Hub - NSIS installer hooks (ADR-0072).
;
; Keep this file pure ASCII.
;
; The generated installer kills only ${MAINBINARYNAME}.exe before extracting,
; and then overwrites every externalBin with a bare `File /a`. Our two sidecar
; exes are externalBin, so a running maxprice-hub.exe or maxprice-credstore.exe
; means a locked write - which raises a real ABORTRETRYIGNORE modal even under
; the updater's `passive` mode, leaving an unattended host with no hub running
; until a human clicks (issue #144).
;
; The job object in the Rust shell covers every path where the shell is the one
; that goes away. This half covers the two it structurally cannot:
;
;   1. an installer the user double-clicked while the app runs normally, and
;   2. an orphan left behind by a version that predates the job object - which
;      is exactly what the first install of this fix will meet.
;
; KillProcess is called DIRECTLY rather than through the template's
; CheckIfAppIsRunning macro: that macro puts up an MB_OKCANCEL whenever
; $PassiveMode != 1, i.e. on every hand-run install, and Cancel aborts. Reusing
; it here would have put up to three abortable prompts naming raw exe names in
; front of every hand-run install. The trade recorded in ADR-0072: our hook runs
; BEFORE the main binary's own check, so cancelling at that prompt aborts with
; the daemon already terminated (recovery is quit-and-relaunch).
;
; The INSTALLMODE split mirrors the template's own. The hub installs per-user
; (ADR-0038), so currentUser is the live branch.

!macro NSIS_HOOK_PREINSTALL
  !if "${INSTALLMODE}" == "currentUser"
    nsis_tauri_utils::KillProcessCurrentUser "maxprice-hub.exe"
    Pop $0
    nsis_tauri_utils::KillProcessCurrentUser "maxprice-credstore.exe"
    Pop $0
  !else
    nsis_tauri_utils::KillProcess "maxprice-hub.exe"
    Pop $0
    nsis_tauri_utils::KillProcess "maxprice-credstore.exe"
    Pop $0
  !endif

  ; The same grace the template allows itself after its own KillProcess: the
  ; handle is not closed the instant TerminateProcess returns.
  Sleep 500
!macroend
