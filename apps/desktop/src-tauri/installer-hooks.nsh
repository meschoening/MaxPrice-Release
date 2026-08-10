; MaxPrice - NSIS installer hooks (ADR-0072).
;
; Keep this file pure ASCII.
;
; The generated installer kills only ${MAINBINARYNAME}.exe before extracting,
; and then overwrites every externalBin with a bare `File /a`.
; maxprice-sidecar.exe is externalBin, so a running sidecar means a locked
; write - which raises a real ABORTRETRYIGNORE modal even under the updater's
; `passive` mode, stalling the install behind a click (issue #144).
;
; The job object in the Rust shell covers every path where the shell is the one
; that goes away. This half covers the two it structurally cannot:
;
;   1. an installer the user double-clicked while the app runs normally, and
;   2. an orphan left behind by a version that predates the job object - which
;      is exactly what the first install of this fix will meet. The client has
;      shipped v0.1.0 and v0.2.0 with NO Windows watchdog at all, so that
;      orphan is not hypothetical.
;
; KillProcess is called DIRECTLY rather than through the template's
; CheckIfAppIsRunning macro: that macro puts up an MB_OKCANCEL whenever
; $PassiveMode != 1, i.e. on every hand-run install, and Cancel aborts. The
; trade recorded in ADR-0072: our hook runs BEFORE the main binary's own check,
; so cancelling at that prompt aborts with the sidecar already terminated
; (recovery is quit-and-relaunch).
;
; The INSTALLMODE split mirrors the template's own; currentUser is the live
; branch for this app today.
;
; --- the legacy branch --------------------------------------------------
;
; Up to and including v0.2.0 the sidecar was the generically-named
; `sidecar.exe`. Killing THAT by name is what an installer must never do: the
; name is not ours, so any unrelated current-user process holding it would be
; terminated silently. The binary was therefore renamed to
; `maxprice-sidecar.exe`, and the legacy kill survives only behind proof that a
; pre-rename MaxPrice was installed into THIS directory.
;
; The legacy orphan still has to be cleared even though the rename means it no
; longer locks anything (different filename - the old exe is simply left on
; disk). The reason is coexistence, not file locking: the likeliest upgrade path
; MANUFACTURES the orphan seconds before this hook runs, because
; tauri-plugin-updater exits via std::process::exit(0), which skips
; kill_sidecar entirely, and no pre-v0.2.0 build had a Windows watchdog. Left
; alive, that old sidecar runs beside the new one against the same app-data
; dir - both appending local-archive.jsonl, both rotating sidecar.log.
;
; Deleting the stale exe after the kill makes the branch self-retiring: the
; IfFileExists guard is false on every subsequent install. Plain Delete, not
; Delete /REBOOTOK - the latter needs HKLM PendingFileRenameOperations and
; would fail silently on this unelevated per-user install. A failed kill leaves
; the file, hence the guard true, hence a retry next install.
;
; The guard jumps to a named label rather than a relative `+N`: a plugin call
; with an argument compiles to more than one instruction, so a relative count
; is both wrong-looking and silently wrong if an argument is ever added. Only
; one arm of the !if is compiled, so the label name cannot collide with itself.

!macro NSIS_HOOK_PREINSTALL
  !if "${INSTALLMODE}" == "currentUser"
    nsis_tauri_utils::KillProcessCurrentUser "maxprice-sidecar.exe"
    Pop $0

    IfFileExists "$INSTDIR\sidecar.exe" 0 maxprice_no_legacy_sidecar
      nsis_tauri_utils::KillProcessCurrentUser "sidecar.exe"
      Pop $0
      Delete "$INSTDIR\sidecar.exe"
    maxprice_no_legacy_sidecar:
  !else
    nsis_tauri_utils::KillProcess "maxprice-sidecar.exe"
    Pop $0

    IfFileExists "$INSTDIR\sidecar.exe" 0 maxprice_no_legacy_sidecar
      nsis_tauri_utils::KillProcess "sidecar.exe"
      Pop $0
      Delete "$INSTDIR\sidecar.exe"
    maxprice_no_legacy_sidecar:
  !endif

  ; The same grace the template allows itself after its own KillProcess: the
  ; handle is not closed the instant TerminateProcess returns.
  Sleep 500
!macroend
