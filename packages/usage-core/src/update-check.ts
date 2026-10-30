// The daemon's update check, shared by the headless products (ADR-0123 §8,
// ADR-0129 §6–§7). `serve` checks its product's channel at boot and every 6 h,
// the Desktop client's cadence, writes `<data dir>/update-check.json`
// (`{checkedAt, current, latest, error}`) and logs once when a new version
// appears; `status` reads the file back as its Update row. The check runs in
// `serve`'s own process, outside the sidecar, and never installs anything:
// only the product's `update` command does (self-update.ts).
//
// Reachable only via the "./update-check" subpath, never index.ts: the sidecar
// never checks, since the Desktop client's shell has Tauri's updater.

import {
  closeSync,
  fchmodSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import {
  SelfUpdateError,
  checkForUpdate,
  isNewerVersion,
  type SelfUpdateProduct,
} from "./self-update";

export const UPDATE_CHECK_FILE = "update-check.json";
export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // the Desktop client's cadence

export function updateCheckPath(dataDir: string): string {
  return join(dataDir, UPDATE_CHECK_FILE);
}

/**
 * One check's outcome. `latest` is x.y.z or null: a check that failed has
 * `latest` null and `error` set; one that succeeded has `error` null.
 */
export const updateCheckRecordSchema = z.object({
  checkedAt: z.string(), // ISO 8601
  current: z.string(), // the version the checking daemon ran
  latest: z
    .string()
    .regex(/^\d+\.\d+\.\d+$/)
    .nullable(),
  error: z.string().nullable(),
});
export type UpdateCheckRecord = z.infer<typeof updateCheckRecordSchema>;

export type UpdateCheckOptions = {
  product: SelfUpdateProduct;
  currentVersion: string;
  dataDir: string;
  /** One line per event, without a prefix; the caller adds its own (serve: "[serve] "). */
  log: (line: string) => void;
  /** Tests; UPDATE_CHECK_INTERVAL_MS by default. */
  intervalMs?: number;
  /** Tests. */
  now?: () => Date;
  /** Tests; checkForUpdate by default. */
  check?: typeof checkForUpdate;
};

/**
 * One check, recorded. Never throws: a failed check is a record with `latest`
 * null and the reason in `error`, and a failed write is logged, so that an
 * air-gapped server or a full disk never takes the daemon down. Returns the
 * record either way.
 */
export async function runUpdateCheck(opts: UpdateCheckOptions): Promise<UpdateCheckRecord> {
  const { product, currentVersion, dataDir, log } = opts;
  const now = opts.now ?? (() => new Date());
  const check = opts.check ?? checkForUpdate;
  let record: UpdateCheckRecord;
  try {
    const { latest } = await check(product, currentVersion);
    record = { checkedAt: now().toISOString(), current: currentVersion, latest, error: null };
  } catch (err) {
    record = {
      checkedAt: now().toISOString(),
      current: currentVersion,
      latest: null,
      error: err instanceof SelfUpdateError ? err.message : String(err),
    };
  }
  writeRecord(updateCheckPath(dataDir), record, log);
  return record;
}

export type UpdateChecks = {
  /** Settles once the boot check's record is written (or its write failed). */
  first: Promise<void>;
  /** No check starts after this; an in-flight one finishes and schedules nothing. */
  stop(): void;
};

/**
 * The boot check at once, then each next one `intervalMs` after the previous
 * settles: a chained setTimeout, never setInterval, so a check slower than
 * the interval never overlaps the next. Each timer is unref'd, so a pending
 * check never keeps a stopping process alive.
 *
 * Logs a version once, when it is the newest yet seen to be newer than
 * `currentVersion`: a newer one later logs again; the same one, an older one,
 * a current result or a failed check logs nothing.
 */
export function startUpdateChecks(opts: UpdateCheckOptions): UpdateChecks {
  const { product, currentVersion, log } = opts;
  const intervalMs = opts.intervalMs ?? UPDATE_CHECK_INTERVAL_MS;
  const name = product.binaryName;
  let announced: string | null = null;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const once = async (): Promise<void> => {
    const { latest } = await runUpdateCheck(opts);
    if (latest === null || !isNewerVersion(latest, currentVersion)) return;
    if (announced !== null && !isNewerVersion(latest, announced)) return;
    announced = latest;
    log(`${name} ${latest} is available (this is ${currentVersion}); run '${name} update'`);
  };
  const next = (): void => {
    if (stopped) return;
    timer = setTimeout(() => void once().then(next), intervalMs);
    timer.unref();
  };

  const first = once();
  void first.then(next);
  return {
    first,
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
  };
}

/**
 * The file as `status` reads it: null when there is none, the record, or why
 * it cannot be used, which the Update row shows as a failed check.
 */
export type UpdateCheckRead = UpdateCheckRecord | { unreadable: string } | null;

export function readUpdateCheck(dataDir: string): UpdateCheckRead {
  let text: string;
  try {
    text = readFileSync(updateCheckPath(dataDir), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    return { unreadable: `cannot read ${UPDATE_CHECK_FILE}: ${messageOf(err)}` };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { unreadable: `${UPDATE_CHECK_FILE} is not JSON` };
  }
  const parsed = updateCheckRecordSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    const where = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
    return { unreadable: `${UPDATE_CHECK_FILE} is not a check record (${where}${issue.message})` };
  }
  return parsed.data;
}

export type UpdateRow = { mark: "ok" | "warn" | "off"; detail: string; remedy?: string };

/**
 * The Update row's forms (ADR-0123 §8). `version` is the binary `status`
 * runs, not the record's `current`: comparing `latest` with it means a stale
 * file never announces an update already installed. `command` is the remedy,
 * such as "maxprice update". A failed check is "off", never a failure mark,
 * since an air-gapped server is not broken.
 */
export function updateRow(read: UpdateCheckRead, version: string, command: string): UpdateRow {
  if (read === null) return { mark: "off", detail: "not checked yet" };
  if ("unreadable" in read) return { mark: "off", detail: `check failed: ${read.unreadable}` };
  if (read.error !== null) return { mark: "off", detail: `check failed: ${read.error}` };
  if (read.latest !== null && isNewerVersion(read.latest, version)) {
    return { mark: "warn", detail: `${read.latest} available`, remedy: command };
  }
  return { mark: "ok", detail: "current" };
}

// ---------------------------------------------------------------------------

/**
 * A temp file in the data dir, 0600, fsynced, then renamed over the path, so
 * `status` reads the old record or the new one and never a part of either.
 */
function writeRecord(path: string, record: UpdateCheckRecord, log: (line: string) => void): void {
  const temp = `${path}.${process.pid}.tmp`;
  try {
    // A crash's leftover is replaced; rmSync removes a symlink itself, and the
    // exclusive create never follows one.
    rmSync(temp, { force: true });
    const fd = openSync(temp, "wx", 0o600);
    try {
      fchmodSync(fd, 0o600); // the exact mode, whatever the umask
      writeFileSync(fd, `${JSON.stringify(record, null, 2)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, path);
  } catch (err) {
    try {
      rmSync(temp, { force: true });
    } catch {
      // The write's failure is what gets logged; the next check replaces a leftover.
    }
    log(`cannot write ${path}: ${messageOf(err)}`);
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
