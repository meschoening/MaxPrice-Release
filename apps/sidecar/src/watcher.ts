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
  // How long to wait for chokidar's `ready` before giving up on it and
  // resolving anyway. See WATCHER_READY_TIMEOUT_MS.
  readyTimeoutMs?: number;
  // Injectable chokidar factory — defaults to the real `watch`. The precedent
  // is `settings-watch.ts`'s: it is what lets a test hold `ready` back forever,
  // which is the whole failure mode of issue #182 and is not something a real
  // chokidar can be asked to do.
  watchFactory?: (roots: string[]) => FSWatcher;
  // Fired if `ready` arrives AFTER the timeout already resolved this call —
  // never otherwise (a normal ready resolves the promise instead). The whole
  // point of the self-healing degrade: the caller clears its amber flag.
  // At most once, and never after `close()`.
  onReadyLate?: () => void;
};

// MEASURED, not guessed: a healthy `ready` on the reference machine took
// 2.09 s over two roots (503 project dirs), which is a lot more than the
// sub-second this was first written for — chokidar's initial scan walks the
// whole tree even under `ignoreInitial`. 10 s keeps ~5x headroom over that, so
// a cold or network-backed home does not trip it, while still surfacing the
// degrade while the user is looking at the launch. Nothing downstream races
// it: this is all post-`LISTENING`, so the Rust shell's handshake budget does
// not apply — the only cost of waiting is how long the amber line takes to
// appear. Re-measure before lowering it; the trace prints the real number
// every boot (`watcher settled at +Nms`).
export const WATCHER_READY_TIMEOUT_MS = 10_000;

export type Watcher = {
  close: () => Promise<void>;
  // True when `ready` did not arrive within the timeout (issue #182). The
  // watcher is returned anyway — the known FSEvents failure mode is "`ready`
  // never fires WHILE events still flow", so rejecting would discard a live
  // watcher over a missing signal, and would turn a degrade into a boot-path
  // error branch in two callers. Drives `watcherDegraded` on the status
  // snapshot; cleared again if `onReadyLate` fires.
  readyTimedOut: boolean;
};

// Watch the Claude JSONL roots and emit one debounced UsageEvent per file
// write-burst. The event is an opaque signal — project/session come from the
// path, timestamp/count from a cheap tail-read; the renderer treats it as
// "something changed here, refetch".
export async function createWatcher(opts: CreateWatcherOptions): Promise<Watcher> {
  const debounceMs = opts.debounceMs ?? 500;
  const readyTimeoutMs = opts.readyTimeoutMs ?? WATCHER_READY_TIMEOUT_MS;
  const tailReader = opts.tailReader ?? createTailReader();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  const watchFactory =
    opts.watchFactory ??
    ((roots: string[]): FSWatcher =>
      watch(roots, {
        ignoreInitial: true,
        // Stay inside the resolved Claude roots: don't follow symlinks out of
        // the tree (keeps identityFromPath's relative-path assumption valid),
        // and cap recursion at the deepest layout Claude Code writes — subagent
        // transcripts live at <root>/<slug>/<session>/subagents/agent-*.jsonl,
        // four levels below each root (flat sessions are two).
        followSymlinks: false,
        depth: 4,
        // Ignore non-.jsonl files once a stat confirms they are files. During
        // the initial scan chokidar may call this without `stats`; `schedule()`
        // is the authoritative event-level filter (it re-checks the suffix), so
        // a brief pre-stat match here emits nothing.
        ignored: (path, stats) => stats?.isFile() === true && !path.endsWith(".jsonl"),
      }));
  const fsWatcher: FSWatcher = watchFactory(opts.roots);

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

  // Wait for `ready`, but never forever (issue #182). A hung `ready` used to
  // strand this promise, and with it both callers: `main()`'s boot fan-out, and
  // `settings-watch`'s serialized restart chain — which holds `restarting =
  // true` across the await, so a wedge there silently stops honouring
  // `claudePaths` edits for the rest of the session. Neither has any way to
  // notice, which is the point: bound it here, once, where the signal lives.
  let readyTimedOut = false;
  let closed = false;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      readyTimedOut = true;
      console.warn(
        `[sidecar] watcher 'ready' did not arrive within ${readyTimeoutMs}ms — continuing; file watching may be inactive`,
      );
      resolve();
    }, readyTimeoutMs);
    fsWatcher.once("ready", () => {
      clearTimeout(timer);
      // Ready AFTER the timeout already resolved: the condition healed itself,
      // so say so rather than leaving a stale warning standing. `closed` gates
      // it — a watcher torn down between the timeout and a late ready must not
      // report itself healthy on the way out.
      if (readyTimedOut) {
        // Clear the flag as well as firing the callback, so the handle and the
        // status snapshot agree on what is true NOW rather than one of them
        // still reporting what boot found (ADR-0074's rule for `bindHosts`).
        readyTimedOut = false;
        if (!closed) opts.onReadyLate?.();
        return;
      }
      resolve();
    });
  });

  return {
    get readyTimedOut() {
      return readyTimedOut;
    },
    close: async () => {
      closed = true;
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      await fsWatcher.close();
    },
  };
}
