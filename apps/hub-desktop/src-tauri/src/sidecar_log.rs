// Durable sidecar log (issue #116 / F4): the Rust half of the fix for
// "sidecar logs go nowhere in a packaged build". The CommandEvent loop in
// lib.rs tees every forwarded line here alongside its `eprintln!` — a packaged
// Windows GUI build has no console, so without this file every abandon
// warning, skipped file, and termination notice vanished in exactly the
// configuration users run.
//
// Bounded by construction: a 5 MB cap with ONE rotated generation (`.log` →
// `.log.1`, clobbering the previous `.1`) — disk is ≤ 2×cap, and rotation is a
// rename + reopen at a line boundary, never a copy. Single-file truncation was
// rejected because it destroys history at exactly the moment the file is full
// of the incident that filled it.
//
// Every line is stamped UTC RFC3339-millis: the raw `eprintln!` lines carry no
// timestamps at all, and a forensic log that cannot order events against an
// incident timeline reproduces the #85 problem in miniature.
//
// Writes swallow IO errors (`let _ =`): the log must never take down — or even
// error — the pipe-forwarding loop it observes. This module has an identical
// twin in the other shell crate (apps/desktop ↔ apps/hub-desktop, which spawns
// its daemon as a Tauri sidecar the same way); keep the twins in step.

use parking_lot::Mutex;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

/// 5 MB per generation; two generations on disk worst-case.
pub const LOG_CAP_BYTES: u64 = 5 * 1024 * 1024;

pub struct RotatingLog {
    inner: Mutex<Inner>,
}

struct Inner {
    file: Option<File>,
    path: PathBuf,
    bytes: u64,
    cap: u64,
}

// One record is one physical line. `line`'s callers embed foreign text — the
// ADR-0059 renderer feeder passes `String(err)`, and Zod 3 renders a ZodError
// as pretty-printed multi-line JSON — and a raw newline there would write
// extra physical lines carrying no timestamp and no prefix, which a forensic
// read misattributes to whoever wrote the lines around them. That defeats the
// ordering guarantee this file exists for (ADR-0056).
//
// Escape rather than split: the contract is one stamped record per event, and
// splitting would multiply one runaway message into N records past the
// 1000-char budget `append_client_line` enforces. Borrowed on the common path
// so the stdout tee — whose lines are already one-per-line, so this is a
// no-op for them — allocates nothing extra.
fn escape_controls(msg: &str) -> std::borrow::Cow<'_, str> {
    if !msg.bytes().any(|b| b < 0x20 || b == 0x7f) {
        return std::borrow::Cow::Borrowed(msg);
    }
    let mut out = String::with_capacity(msg.len() + 8);
    for c in msg.chars() {
        match c {
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if c.is_control() => out.push_str(&format!("\\u{{{:04x}}}", c as u32)),
            c => out.push(c),
        }
    }
    std::borrow::Cow::Owned(out)
}

impl RotatingLog {
    /// Open (append) the log at `path`, creating parent directories. Seeds the
    /// size accounting from the existing file so the cap survives relaunches,
    /// then writes one stamped `header` line marking this launch.
    pub fn open(path: &Path, cap: u64, header: &str) -> std::io::Result<Self> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let file = open_append(path)?;
        let bytes = file.metadata().map(|m| m.len()).unwrap_or(0);
        let log = RotatingLog {
            inner: Mutex::new(Inner {
                file: Some(file),
                path: path.to_path_buf(),
                bytes,
                cap,
            }),
        };
        log.line("", header);
        Ok(log)
    }

    /// Append one stamped line: `{timestamp} {prefix} {msg}`. Rotates first if
    /// the line would push the current generation past the cap. Never errors —
    /// a failing log write is swallowed, not propagated into the loop. Control
    /// characters in `msg` are escaped, so one record is always exactly one
    /// physical line.
    pub fn line(&self, prefix: &str, msg: &str) {
        let msg = escape_controls(msg);
        let rendered = if prefix.is_empty() {
            format!("{} {}\n", timestamp(), msg)
        } else {
            format!("{} {} {}\n", timestamp(), prefix, msg)
        };
        let mut inner = self.inner.lock();
        if inner.bytes > 0 && inner.bytes + rendered.len() as u64 > inner.cap {
            inner.rotate();
        }
        if let Some(file) = inner.file.as_mut() {
            if file.write_all(rendered.as_bytes()).is_ok() {
                inner.bytes += rendered.len() as u64;
            }
        }
    }
}

impl Inner {
    // Rename the full generation to `.1` (clobbering the previous one) and
    // start fresh. The handle is dropped BEFORE the rename — Windows renames
    // of an open file depend on share-mode details, and a closed handle is
    // unambiguous on every platform. On any failure the log keeps appending to
    // whatever file it can reopen: a soft cap beats a dead log.
    fn rotate(&mut self) {
        self.file = None;
        let rotated = rotated_path(&self.path);
        let _ = fs::remove_file(&rotated);
        let _ = fs::rename(&self.path, &rotated);
        self.file = open_append(&self.path).ok();
        self.bytes = self
            .file
            .as_ref()
            .and_then(|f| f.metadata().ok())
            .map(|m| m.len())
            .unwrap_or(0);
    }
}

fn open_append(path: &Path) -> std::io::Result<File> {
    OpenOptions::new().create(true).append(true).open(path)
}

// `sidecar.log` → `sidecar.log.1` (NOT `sidecar.1`): the rotated generation
// keeps the `.log` in its name so it stays double-click-openable.
fn rotated_path(path: &Path) -> PathBuf {
    let mut name = path
        .file_name()
        .map(|n| n.to_os_string())
        .unwrap_or_default();
    name.push(".1");
    path.with_file_name(name)
}

// UTC RFC3339 with exactly 3 subsecond digits: `2026-07-31T22:41:03.123Z`.
// Hand-formatted from components — `time`'s Rfc3339 formatter varies its
// subsecond width, and a fixed-width stamp keeps the file visually column-
// aligned and trivially parseable.
fn timestamp() -> String {
    let t = time::OffsetDateTime::now_utc();
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        t.year(),
        u8::from(t.month()),
        t.day(),
        t.hour(),
        t.minute(),
        t.second(),
        t.millisecond()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read(path: &Path) -> String {
        fs::read_to_string(path).unwrap_or_default()
    }

    // `2026-07-31T22:41:03.123Z` — 24 chars, always-3-digit millis.
    fn assert_stamped(line: &str) {
        let ts = line.split(' ').next().unwrap_or("");
        assert_eq!(ts.len(), 24, "timestamp `{ts}` should be RFC3339 millis");
        assert!(ts.ends_with('Z'), "timestamp `{ts}` should be UTC");
        assert_eq!(&ts[10..11], "T");
    }

    #[test]
    fn writes_stamped_prefixed_lines_after_a_launch_header() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("logs").join("sidecar.log");
        let log =
            RotatingLog::open(&path, LOG_CAP_BYTES, "--- launched v0.0.0 (pid 1) ---").unwrap();

        log.line("[sidecar]", "hello");

        let body = read(&path);
        let lines: Vec<&str> = body.lines().collect();
        assert_eq!(lines.len(), 2);
        assert!(lines[0].contains("--- launched v0.0.0 (pid 1) ---"));
        assert!(lines[1].contains(" [sidecar] hello"));
        assert_stamped(lines[0]);
        assert_stamped(lines[1]);
    }

    #[test]
    fn an_embedded_newline_stays_one_stamped_record() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sidecar.log");
        let log = RotatingLog::open(&path, LOG_CAP_BYTES, "header").unwrap();

        // What a version-skewed sidecar actually produces today: the renderer
        // feeder passes `String(err)`, and Zod renders a ZodError as pretty-
        // printed multi-line JSON. Unescaped, the tail lines would land in the
        // file carrying no timestamp and no prefix.
        log.line(
            "[renderer]",
            "manual-refresh: [\r\n  {\r\n    \"code\": \"x\"\r\n  }\r\n]",
        );

        let body = read(&path);
        let lines: Vec<&str> = body.lines().collect();
        assert_eq!(lines.len(), 2, "header + exactly one record, got {lines:?}");
        assert_stamped(lines[1]);
        assert!(
            lines[1].contains(" [renderer] manual-refresh: ["),
            "the record keeps its prefix: {}",
            lines[1]
        );
        assert!(
            lines[1].contains("\\r\\n"),
            "both escapes visible: {}",
            lines[1]
        );
        assert!(
            !lines[1].contains('\r'),
            "no raw control chars survive: {:?}",
            lines[1]
        );
    }

    #[test]
    fn rotation_renames_at_the_cap_and_starts_fresh() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sidecar.log");
        // Cap small enough that a handful of lines trips rotation.
        let log = RotatingLog::open(&path, 300, "header").unwrap();

        for i in 0..10 {
            log.line("[sidecar]", &format!("line {i}"));
        }

        let rotated = read(&path.with_extension("log.1"));
        let current = read(&path);
        // The rotated generation holds the header + early lines; the current
        // file holds the latest line and stays under the cap.
        assert!(
            rotated.contains("header"),
            "rotated file should hold the early lines"
        );
        assert!(
            current.contains("line 9"),
            "current file should hold the latest line"
        );
        assert!(!current.contains("header"));
        assert!(fs::metadata(&path).unwrap().len() <= 300);
    }

    #[test]
    fn a_second_rotation_clobbers_the_previous_generation() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sidecar.log");
        let log = RotatingLog::open(&path, 200, "header").unwrap();

        for i in 0..40 {
            log.line("[sidecar]", &format!("line {i:02}"));
        }

        // Exactly two files ever exist: current + one rotated generation.
        let names: Vec<String> = fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            names.len(),
            2,
            "exactly two generations on disk, got {names:?}"
        );
        // The first generation (with the header) is gone — clobbered by a
        // later rotation.
        assert!(!read(&path.with_extension("log.1")).contains("header"));
    }

    #[test]
    fn open_seeds_the_size_accounting_from_the_existing_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sidecar.log");
        {
            let log = RotatingLog::open(&path, 10_000, "first launch").unwrap();
            for i in 0..5 {
                log.line("[sidecar]", &format!("pre-existing {i}"));
            }
        }
        let preexisting = fs::metadata(&path).unwrap().len();

        // Reopen with a cap the existing content already exceeds: the next
        // line must rotate rather than growing the file unboundedly — which
        // only happens if open() seeded `bytes` from a stat, not from zero.
        let log = RotatingLog::open(&path, preexisting + 10, "second launch").unwrap();
        log.line("[sidecar]", "post-relaunch");

        assert!(
            path.with_extension("log.1").exists(),
            "relaunch write should have rotated based on pre-existing size"
        );
    }
}
