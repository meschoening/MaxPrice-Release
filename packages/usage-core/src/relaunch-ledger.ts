// What `serve` does when launchd supervises it (ADR-0143 §5–§6), which it
// knows by `MAXPRICE_SUPERVISOR=launchd` (./launchd-agent's SUPERVISOR):
// its relaunch ledger and the rotation of its log.
//
// launchd has no StartLimitBurst and cannot exclude an exit code from
// `KeepAlive {SuccessfulExit: false}`, so the daemon bounds its own
// relaunches. The ledger holds the start times of the last 15 minutes and
// the cause of the last stop it declined; `serve` declines a relaunch by
// recording why and exiting 0, the one exit launchd does not relaunch. The
// daemon is still relaunched by its init, never by itself (ADR-0120): the
// ledger only declines.
//
// The file is JSON, written beside itself and renamed over, so a reader
// never finds half of it: `{"starts":["2026-11-19T07:58:52.000Z",…],
// "cause":{"kind":"crashes","at":"…"}}`.
//
// Reachable only via the "./relaunch-ledger" subpath, never index.ts.

import {
  copyFileSync,
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

/** ADR-0120's StartLimitIntervalSec=15min. */
export const WINDOW_MS = 15 * 60 * 1000;
/** ADR-0120's StartLimitBurst=5: the sixth start within the window is declined. */
export const START_LIMIT = 5;
/** serve.log is rotated at boot past 10 MB (§6). */
export const LOG_LIMIT_BYTES = 10 * 1024 * 1024;

/** Why the last stop was declined: what `service status` reports for it. */
export type StopCause =
  // A sixth start within 15 minutes.
  | { kind: "crashes"; at: string }
  // Another `serve` held the data dir: exit 5's cause, with its pid if known.
  | { kind: "locked"; at: string; pid: number | null }
  // A refusal a relaunch cannot fix, by the exit it stands for: 6, settings.json.
  | { kind: "refused"; at: string; exit: number };

export type Ledger = { starts: string[]; cause: StopCause | null };

const EMPTY: Ledger = { starts: [], cause: null };

function isCause(value: unknown): value is StopCause {
  if (typeof value !== "object" || value === null) return false;
  const cause = value as Record<string, unknown>;
  if (typeof cause.at !== "string") return false;
  if (cause.kind === "crashes") return true;
  if (cause.kind === "locked") return cause.pid === null || Number.isInteger(cause.pid);
  return cause.kind === "refused" && Number.isInteger(cause.exit);
}

// The ledger at `path`; an absent, unreadable or malformed file is an empty
// one, so a damaged ledger never stops the daemon: at worst one burst of
// crashes runs five more starts before the bound holds again.
export function readLedger(path: string): Ledger {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return EMPTY;
  }
  if (typeof parsed !== "object" || parsed === null) return EMPTY;
  const { starts, cause } = parsed as Record<string, unknown>;
  return {
    starts: Array.isArray(starts)
      ? starts.filter((at): at is string => typeof at === "string" && !isNaN(Date.parse(at)))
      : [],
    cause: isCause(cause) ? cause : null,
  };
}

function writeLedger(path: string, ledger: Ledger): void {
  const temporary = join(dirname(path), `.relaunch.${process.pid}.tmp`);
  writeFileSync(temporary, JSON.stringify(ledger) + "\n", { mode: 0o600 });
  renameSync(temporary, path);
}

// The starts within the window ending at `now`, oldest first.
export function recentStarts(ledger: Ledger, now: Date): string[] {
  const since = now.getTime() - WINDOW_MS;
  return ledger.starts.filter((at) => {
    const ms = Date.parse(at);
    return ms > since && ms <= now.getTime();
  });
}

// A start: its time joins the window, which drops what is older than 15
// minutes. The sixth start within the window records the crashes cause and
// is declined. Every start counts, a hand `launchctl kickstart` and
// `update`'s restart included, as systemd counts them.
export function recordStart(path: string, now: Date): { declined: boolean; starts: number } {
  const ledger = readLedger(path);
  const starts = [...recentStarts(ledger, now), now.toISOString()];
  const declined = starts.length > START_LIMIT;
  writeLedger(path, {
    starts,
    cause: declined ? { kind: "crashes", at: now.toISOString() } : ledger.cause,
  });
  return { declined, starts: starts.length };
}

// A stop the daemon declines for a cause a relaunch cannot fix.
export function recordCause(path: string, cause: StopCause): void {
  writeLedger(path, { ...readLedger(path), cause });
}

// A start that took the lock and accepted its settings: the cause is gone,
// and the start times stay.
export function clearCause(path: string): void {
  const ledger = readLedger(path);
  if (ledger.cause !== null) writeLedger(path, { ...ledger, cause: null });
}

// `service install` clears the whole ledger, as `reset-failed` clears
// systemd's count.
export function clearLedger(path: string): void {
  rmSync(path, { force: true });
}

// At boot, before the daemon logs anything: past `limit` bytes the log is
// copied to `<log>.1`, replacing the old copy, and then truncated. launchd
// holds the file open for append, so its next write lands at the new end.
// Returns whether it rotated; a log that does not exist is left alone.
export function rotateLog(path: string, limit: number = LOG_LIMIT_BYTES): boolean {
  if (!existsSync(path) || statSync(path).size <= limit) return false;
  copyFileSync(path, `${path}.1`);
  truncateSync(path, 0);
  return true;
}
