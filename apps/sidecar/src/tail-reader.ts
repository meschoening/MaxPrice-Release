import { statSync } from "node:fs";

const NEWLINE = 0x0a;

export type TailChunkResult = {
  // Number of complete (newline-terminated, non-blank) lines in the chunk.
  count: number;
  // The complete (newline-terminated, non-blank) lines themselves, in file
  // order. The event store (E4) parses these through the E2 parser; the opaque
  // SSE `UsageEvent` only ever needs `count`/`latestTimestamp`, so this field
  // is additive — Part 3 consumers ignore it.
  lines: string[];
  // Most-recent `timestamp` field among the parsed lines, or null if none had
  // one. JSONL is append-ordered, so the last line with a timestamp wins.
  latestTimestamp: string | null;
  // Bytes up to and including the last newline — a partial trailing line is
  // left unconsumed so the next read picks it up whole.
  consumedBytes: number;
};

// Pure: given a byte chunk, find the complete lines and best-effort-extract a
// timestamp. Byte-based (not character-based) so multibyte content can't throw
// the file offset off.
export function parseTailChunk(chunk: Uint8Array): TailChunkResult {
  let lastNewline = -1;
  for (let i = chunk.length - 1; i >= 0; i--) {
    if (chunk[i] === NEWLINE) {
      lastNewline = i;
      break;
    }
  }
  if (lastNewline === -1) {
    return { count: 0, lines: [], latestTimestamp: null, consumedBytes: 0 };
  }

  const consumedBytes = lastNewline + 1;
  const text = new TextDecoder().decode(chunk.subarray(0, consumedBytes));
  const lines = text.split("\n").filter((line) => line.trim() !== "");

  let latestTimestamp: string | null = null;
  for (const line of lines) {
    const ts = extractTimestamp(line);
    if (ts !== null) latestTimestamp = ts;
  }
  return { count: lines.length, lines, latestTimestamp, consumedBytes };
}

// Opaque: a best-effort timestamp, not a validated record. A non-JSON or
// timestamp-less line is fine — Part 5's parser owns the real schema.
function extractTimestamp(line: string): string | null {
  try {
    const obj: unknown = JSON.parse(line);
    if (obj !== null && typeof obj === "object" && "timestamp" in obj) {
      const ts = (obj as { timestamp: unknown }).timestamp;
      if (typeof ts === "string") return ts;
    }
  } catch {
    // not JSON — the opaque reader shrugs and moves on
  }
  return null;
}

export type TailResult = {
  count: number;
  // The complete newly-appended lines, in file order. The watcher's `flush`
  // feeds these through the E2 parser into the event store before emitting the
  // opaque SSE `UsageEvent`. Empty on a no-change / truncation-to-empty read.
  lines: string[];
  latestTimestamp: string | null;
};

export type TailReader = {
  read: (path: string) => Promise<TailResult>;
  forget: (path: string) => void;
};

// Incremental JSONL reader. Tracks a byte offset per file so each call reads
// only newly-appended bytes; a partially-written final line stays unconsumed
// until it is newline-terminated. Detects truncation (file smaller than the
// stored offset) and re-reads from the top. Part 3 uses this opaquely (just
// "something happened, here's roughly when"); Part 5 builds the real parser.
export function createTailReader(): TailReader {
  const offsets = new Map<string, number>();
  // One in-flight read per path. A new read for a path chains after it so the
  // offset read-modify-write in `doRead` can't interleave across the `await`.
  const inFlight = new Map<string, Promise<void>>();

  async function doRead(path: string): Promise<TailResult> {
    let size: number;
    try {
      size = statSync(path).size;
    } catch {
      // File vanished between the watch event and this read — nothing to do.
      return { count: 0, lines: [], latestTimestamp: null };
    }

    let prevOffset = offsets.get(path) ?? 0;
    if (size < prevOffset) prevOffset = 0; // truncated / rotated
    if (size <= prevOffset) {
      offsets.set(path, size);
      return { count: 0, lines: [], latestTimestamp: null };
    }

    const chunk = new Uint8Array(await Bun.file(path).slice(prevOffset).arrayBuffer());
    const { count, lines, latestTimestamp, consumedBytes } = parseTailChunk(chunk);
    offsets.set(path, prevOffset + consumedBytes);
    return { count, lines, latestTimestamp };
  }

  // Serialize reads per path: a read for a path already being read waits for
  // the in-flight one to settle, so it observes the offset that read left.
  function read(path: string): Promise<TailResult> {
    const prev = inFlight.get(path) ?? Promise.resolve();
    const result = prev.then(() => doRead(path));
    // The chain link must never reject, or one failed read would poison every
    // later read of the same path. The caller still receives `result` (which
    // may reject), so a read failure propagates exactly as it does today.
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    inFlight.set(path, settled);
    void settled.then(() => {
      if (inFlight.get(path) === settled) inFlight.delete(path);
    });
    return result;
  }

  function forget(path: string): void {
    offsets.delete(path);
  }

  return { read, forget };
}
