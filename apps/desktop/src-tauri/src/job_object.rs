//! Kernel-enforced sidecar lifetime on Windows (ADR-0072).
//!
//! The two layers CLAUDE.md describes — Tauri's `CloseRequested` /
//! `ExitRequested` calling `kill_sidecar`, and the sidecar's own libc-`getppid`
//! watchdog — both have a hole on Windows. The watchdog simply isn't there
//! (`bun:ffi` has no `libc.<suffix>` to dlopen), and `kill_sidecar` only runs
//! when the event loop gets to run: `tauri-plugin-updater` ends the shell with
//! `std::process::exit(0)`, so `ExitRequested` never fires and the sidecar is
//! left running with no parent (issue #144) — for the hub daemon, still holding
//! its port. A panic, a crash, or End task in Task Manager land in exactly the
//! same place.
//!
//! A job object closes all of them at once, because the kernel does the work:
//! the sidecar joins a job created with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`,
//! and when the last handle to that job goes away — including implicitly, as
//! the OS tears down the handle table of a process that exited by any route at
//! all — every process in the job is terminated.
//!
//! Nested jobs are supported on Windows 8+, so a sidecar that is already in
//! someone else's job (a CI runner, a debugger) joins ours without error.

use std::io;

use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, JOBOBJECT_BASIC_LIMIT_INFORMATION,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE};

/// An owned handle to the job the sidecar lives in.
///
/// **Keeping this alive IS the mechanism.** `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`
/// fires when the last handle to the job closes, so dropping this value
/// terminates the sidecar on the spot. It belongs in `SidecarState` for the
/// whole process lifetime and must never be taken back out; on the normal path
/// it is never dropped in Rust at all — the kernel closes it during process
/// teardown, which is precisely what lets it outflank `std::process::exit(0)`.
pub struct JobHandle(HANDLE);

// The handle is an opaque kernel object and the only things done with it are
// handing it back to the kernel and closing it, neither of which is
// thread-affine. Tauri's managed state requires `Send + Sync`.
unsafe impl Send for JobHandle {}
unsafe impl Sync for JobHandle {}

impl Drop for JobHandle {
    fn drop(&mut self) {
        // SAFETY: `self.0` is a live handle from `CreateJobObjectW`, owned by
        // this value and closed exactly once.
        unsafe { CloseHandle(self.0) };
    }
}

/// Confine the process `pid` to a fresh kill-on-close job owned by this one.
///
/// The returned handle must be stored for the lifetime of the process — see
/// [`JobHandle`]. An `Err` is a degrade, not a fatal: teardown falls back to the
/// pre-ADR-0072 layers, which is to say the orphan becomes possible again.
pub fn confine(pid: u32) -> Result<JobHandle, String> {
    // SAFETY: every call below is a plain Win32 FFI call with owned arguments;
    // handles are checked for null before use and closed exactly once.
    unsafe {
        let raw = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if raw.is_null() {
            return Err(format!(
                "CreateJobObjectW failed: {}",
                io::Error::last_os_error()
            ));
        }
        // Owned from here on, so every early return below closes the job. That
        // is harmless while nothing has been assigned to it yet.
        let job = JobHandle(raw);

        let info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
            BasicLimitInformation: JOBOBJECT_BASIC_LIMIT_INFORMATION {
                LimitFlags: JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
                ..Default::default()
            },
            ..Default::default()
        };
        if SetInformationJobObject(
            job.0,
            JobObjectExtendedLimitInformation,
            std::ptr::from_ref(&info).cast(),
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        ) == 0
        {
            return Err(format!(
                "SetInformationJobObject failed: {}",
                io::Error::last_os_error()
            ));
        }

        // PROCESS_SET_QUOTA | PROCESS_TERMINATE is exactly what
        // AssignProcessToJobObject demands, and no more.
        let process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
        if process.is_null() {
            return Err(format!(
                "OpenProcess({pid}) failed: {}",
                io::Error::last_os_error()
            ));
        }
        let assigned = AssignProcessToJobObject(job.0, process);
        let assign_err = io::Error::last_os_error();
        CloseHandle(process);
        if assigned == 0 {
            return Err(format!("AssignProcessToJobObject failed: {assign_err}"));
        }

        Ok(job)
    }
}
