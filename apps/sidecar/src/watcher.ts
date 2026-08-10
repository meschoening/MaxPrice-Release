import { type FSWatcher, watch } from "chokidar";
import type { UsageEvent } from "@maxprice/shared";
import { parseLines } from "./engine/jsonl";
import type { UsageRecord } from "./engine/types";
import { identityFromPath } from "./identity";
import { createTailReader, type TailReader } from "./tail-reader";

export type CreateWatcherOptions = {
  roots: string[];
  onEvent: (event: UsageEvent) => void;
  // The incremental-append path into the event store (E4). `flush` calls this
  // with the freshly-parsed usage records from a write-burst *before* it emits
  // the opaque `onEvent` signal — see the append-before-emit invariant in
  // `flush`. Optional so a Part-3-shaped watcher (no store) still works; the
  // sidecar's `main()` always wires it.
  onRecords?: (records: UsageRecord[], projectSlug: string, sessionId: string) => void;
  onError?: (error: unknown) => void;
  // Trailing debounce window per file path. Default 500ms per the Part 3 spec
  // — collapses an editor's burst of writes into a single emit, and absorbs
  // chokidar's tendency to double-fire `change` on macOS.
  debounceMs?: number;
  // Injectable incremental reader — defaults to a fresh createTailReader().
  // Tests pass a stub to exercise the read-failure → onError path.
  tailReader?: TailReader;
};

export type Watcher = {
  close: () => Promise<void>;
};

// Watch the Claude JSONL roots and emit one debounced UsageEvent per file
// write-burst. The event is an opaque signal — project/session come from the
// path, timestamp/count from a cheap tail-read; the renderer treats it as
// "something changed here, refetch".
export async function createWatcher(opts: CreateWatcherOptions): Promise<Watcher> {
  const debounceMs = opts.debounceMs ?? 500;
  const tailReader = opts.tailReader ?? createTailReader();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  const fsWatcher: FSWatcher = watch(opts.roots, {
    ignoreInitial: true,
    // Stay inside the resolved Claude roots: don't follow symlinks out of the
    // tree (keeps identityFromPath's relative-path assumption valid), and cap
    // recursion at the deepest layout Claude Code writes — subagent transcripts
    // live at <root>/<slug>/<session>/subagents/agent-*.jsonl, four levels
    // below each root (flat sessions are two).
    followSymlinks: false,
    depth: 4,
    // Ignore non-.jsonl files once a stat confirms they are files. During the
    // initial scan chokidar may call this without `stats`; `schedule()` is the
    // authoritative event-level filter (it re-checks the suffix), so a brief
    // pre-stat match here emits nothing.
    ignored: (path, stats) => stats?.isFile() === true && !path.endsWith(".jsonl"),
  });

  function schedule(path: string): void {
    if (!path.endsWith(".jsonl")) return;
    const existing = timers.get(path);
    if (existing) clearTimeout(existing);
    timers.set(
      path,
      setTimeout(() => {
        timers.delete(path);
        // A transient read failure (file vanished mid-read, EACCES, disk
        // error) must stay local — an unhandled rejection here escalates to a
        // full sidecar shutdown via process.on('unhandledRejection').
        flush(path).catch((err: unknown) => opts.onError?.(err));
      }, debounceMs),
    );
  }

  // Per-path flush ordering is best-effort: a flush already past its
  // `setTimeout` (awaiting `tailReader.read`) can still be running when this
  // path's next timer fires and starts a second flush. Event *correctness*
  // does not depend on flush serialization — the tail-reader's `inFlight` map
  // keeps offset reads atomic so no event is lost or double-counted, and the
  // store dedups — only the relative ordering of two `onEvent` signals for the
  // same path is unguaranteed (a cosmetic refresh-pill staleness at worst).
  async function flush(path: string): Promise<void> {
    const { count, lines, latestTimestamp } = await tailReader.read(path);
    const { projectSlug, sessionId } = identityFromPath(path, opts.roots);

    // Append-before-emit (Part 4.5 correctness invariant): the freshly-parsed
    // usage records land in the event store *before* the opaque SSE
    // `UsageEvent` fires. The renderer's post-invalidation refetch must never
    // observe a store missing the very events that triggered it. So: parse the
    // newly-appended lines, append, *then* emit. `parseLines` applies the E2
    // parser's whole-file skip rules; the store dedups, so a truncation
    // re-read replaying old lines is safe.
    if (opts.onRecords) {
      opts.onRecords(parseLines(lines), projectSlug, sessionId);
    }

    opts.onEvent({
      project: projectSlug,
      sessionId,
      // A write with no parseable timestamp (or a deletion) falls back to the
      // observed-at time — honest about when the sidecar noticed the change.
      timestamp: latestTimestamp ?? new Date().toISOString(),
      count,
    });
  }

  fsWatcher.on("add", schedule);
  fsWatcher.on("change", schedule);
  fsWatcher.on("unlink", (path) => {
    tailReader.forget(path);
    schedule(path);
  });
  fsWatcher.on("error", (err) => opts.onError?.(err));

  await new Promise<void>((resolve) => {
    fsWatcher.once("ready", () => resolve());
  });

  return {
    close: async () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      await fsWatcher.close();
    },
  };
}
