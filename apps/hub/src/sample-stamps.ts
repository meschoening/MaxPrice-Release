import { closeSync, fsyncSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { HubStatus } from "@maxprice/shared";
import type { HubFanout } from "./fanout";

// The Hub's `samplesStampedAt` (ADR-0139 §8, #634): when its Usage history
// last gained an Account stamp on a sample it already held — by its own move
// stamping its Account-less samples (hub-keys.ts), or by a merge in which an
// Account-stamped copy replaced an Account-less one (createMergeSamples). A
// client runs its cursorless sample exchange (hub-client.ts) whenever this
// differs from the value it recorded at its last one, so a stamp on an old
// sample, which no since-cursor passes, still reaches every client.
//
// Durable in `sample-stamps.json`, `{ samplesStampedAt }`, beside the history:
// read once at boot into the initial status (readSampleStampedAt), rewritten whole (a synced temp
// and a rename) at each mark. A file missing or unreadable reads as null; a
// failed write keeps the new value in the status for this run and says so —
// after a restart the value falls back, and a client that recorded the newer
// one runs one exchange more, never one fewer than it needs. `restore` does
// not copy it (restore.ts): a restored Hub starts at null, which every client
// that recorded a stamp time differs from, so each re-exchanges once.

export const SAMPLE_STAMPS_FILE = "sample-stamps.json";

export type HubSampleStamps = {
  // The history just gained an Account stamp: now, persisted and patched
  // into the status.
  stamped: () => void;
};

export function readSampleStampedAt(path: string): string | null {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { samplesStampedAt?: unknown };
    const value = raw?.samplesStampedAt;
    return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : null;
  } catch {
    return null;
  }
}

export function createHubSampleStamps(opts: {
  path: string;
  fanout: Pick<HubFanout, "patchStatus">;
  now?: () => number;
}): HubSampleStamps {
  const now = opts.now ?? Date.now;
  function persist(stampedAt: string): void {
    const tmp = `${opts.path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ samplesStampedAt: stampedAt })}\n`);
    const fd = openSync(tmp, "r+");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, opts.path);
  }
  return {
    stamped: () => {
      const value = new Date(now()).toISOString();
      try {
        persist(value);
      } catch (err) {
        console.warn("[hub] sample-stamps.json write failed; kept for this run:", err);
      }
      opts.fanout.patchStatus({ samplesStampedAt: value } satisfies Partial<HubStatus>);
    },
  };
}
