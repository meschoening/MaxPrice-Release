import { readFile, rename, writeFile } from "node:fs/promises";
import { z } from "zod";
import type { ForgetSessionRef } from "@maxprice/shared";
import type { FleetForgetResult } from "./fleet";

// The one-shot repair of already-synced history (ADR-0098). Once the walk has
// classified sessions as holding foreign events, drop THIS machine's rows for
// those sessions from the hub archive (ADR-0063's forget — the epoch bump
// reseeds every replica) and from the local archive, then rebuild so the engine
// is derived from the pruned copies. The ordinary re-push then restores a mixed
// session's home rows. Safe by construction: a session is on the list only
// because a transcript proved it foreign, so it is backed and re-pushable.
//
// Progress is durable PER TARGET in `organization-repair.json`, so a hub that
// is offline today is retried on a timer without repeating the archive rewrite,
// and a completed repair costs nothing on later boots. The marker is keyed by
// the home organization: a different home is a different classification.

const markerSchema = z.object({
  version: z.literal(2),
  home: z.string(),
  hubTarget: z.string().nullable(),
  archiveDone: z.array(z.string()),
  hubDone: z.array(z.string()),
});
type Marker = z.infer<typeof markerSchema>;

const DEFAULT_RETRY_MS = 300_000;

export type OrganizationRepairDeps = {
  markerPath: string;
  homeOrganization: () => string | null;
  foreignSessions: () => ForgetSessionRef[];
  hubTarget: () => string | null;
  // Automatic fleet forget is independent of replica attachment. Transport,
  // server and receipt failures carry retryable=true; permanent refusals don't.
  forgetOnHub: (
    sessions: readonly ForgetSessionRef[],
    target: string,
  ) => Promise<FleetForgetResult>;
  forgetLocalArchive: (sessions: readonly ForgetSessionRef[]) => Promise<void>;
  // fleet.rebuildEngine — after an archive-only forget.
  rebuild: () => Promise<void>;
  retryMs?: number;
  setIntervalImpl?: (cb: () => void, ms: number) => unknown;
  clearIntervalImpl?: (handle: unknown) => void;
};

export type OrganizationRepair = {
  // Idempotent; concurrent calls coalesce into the in-flight run — but a call
  // that arrives mid-run schedules one more pass after the in-flight one
  // settles, so its own request (e.g. a session that became foreign, or a
  // home organization change, during the in-flight run) is actually served
  // before the returned promise resolves, not silently dropped.
  run: () => Promise<void>;
  // Live evidence may classify another row in a previously repaired session.
  invalidate: (sessions: readonly ForgetSessionRef[]) => Promise<void>;
  stop: () => void;
};

function pairKey(s: ForgetSessionRef): string {
  return `${s.projectSlug}\u0000${s.sessionId}`;
}

export function createOrganizationRepair(deps: OrganizationRepairDeps): OrganizationRepair {
  const retryMs = deps.retryMs ?? DEFAULT_RETRY_MS;
  const setIntervalImpl = deps.setIntervalImpl ?? ((cb, ms) => setInterval(cb, ms));
  const clearIntervalImpl =
    deps.clearIntervalImpl ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));
  let inflight: Promise<void> | null = null;
  let retry: unknown = null;
  let stopped = false;
  let rerun = false;
  const invalidated = new Set<string>();

  async function loadMarker(home: string, hubTarget: string | null): Promise<Marker> {
    try {
      const parsed = markerSchema.safeParse(JSON.parse(await readFile(deps.markerPath, "utf8")));
      if (parsed.success && parsed.data.home === home) {
        return {
          ...parsed.data,
          hubTarget,
          hubDone: parsed.data.hubTarget === hubTarget ? parsed.data.hubDone : [],
        };
      }
    } catch {
      // Absent or unreadable: nothing has been repaired under this home.
    }
    return { version: 2, home, hubTarget, archiveDone: [], hubDone: [] };
  }

  async function saveMarker(marker: Marker): Promise<void> {
    const tmp = `${deps.markerPath}.tmp`;
    await writeFile(tmp, JSON.stringify(marker));
    await rename(tmp, deps.markerPath);
  }

  function armRetry(): void {
    if (retry !== null || stopped) return;
    retry = setIntervalImpl(() => void run(), retryMs);
  }

  function disarmRetry(): void {
    if (retry === null) return;
    clearIntervalImpl(retry);
    retry = null;
  }

  async function runInner(): Promise<void> {
    const home = deps.homeOrganization();
    if (home === null) {
      disarmRetry();
      return;
    }
    const sessions = deps.foreignSessions();
    if (sessions.length === 0) {
      disarmRetry();
      return;
    }
    const hubTarget = deps.hubTarget()?.replace(/\/+$/, "") ?? null;
    const marker = await loadMarker(home, hubTarget);
    const archiveDone = new Set(marker.archiveDone);
    const hubDone = new Set(marker.hubDone);
    if (invalidated.size > 0) {
      const pendingInvalidations = [...invalidated];
      for (const key of pendingInvalidations) {
        archiveDone.delete(key);
        hubDone.delete(key);
      }
      await saveMarker({
        version: 2,
        home,
        hubTarget,
        archiveDone: [...archiveDone],
        hubDone: [...hubDone],
      });
      for (const key of pendingInvalidations) invalidated.delete(key);
    }
    let changed = false;
    let hubPending = false;

    if (hubTarget !== null) {
      const pendingHub = sessions.filter((s) => !hubDone.has(pairKey(s)));
      if (pendingHub.length > 0) {
        const result = await deps.forgetOnHub(pendingHub, hubTarget);
        if (result.ok) {
          // fleet.forget rewrote the local archive and resynced the engine too.
          for (const s of pendingHub) {
            hubDone.add(pairKey(s));
            archiveDone.add(pairKey(s));
          }
          changed = true;
        } else if (
          result.reason === "unavailable" ||
          result.reason === "busy" ||
          result.retryable === true
        ) {
          // Transient: the hub disconnected, the replica detached, or another
          // forget on this machine is already doing the work. Retry later.
          hubPending = true;
          console.warn(
            `[sidecar] organization repair: hub forget deferred (${result.reason}: ${result.detail})`,
          );
        } else {
          // A permanent refusal (e.g. an unsupported endpoint) is retried
          // only on an explicit transition/run, never by the timer.
          console.warn(
            `[sidecar] organization repair: hub forget deferred (${result.reason}: ${result.detail})`,
          );
        }
      }
    }

    const pendingArchive = sessions.filter((s) => !archiveDone.has(pairKey(s)));
    if (pendingArchive.length > 0) {
      await deps.forgetLocalArchive(pendingArchive);
      for (const s of pendingArchive) archiveDone.add(pairKey(s));
      changed = true;
      await deps.rebuild();
    }

    if (changed) {
      await saveMarker({
        version: 2,
        home,
        hubTarget,
        archiveDone: [...archiveDone],
        hubDone: [...hubDone],
      });
    }
    if (hubPending) armRetry();
    else disarmRetry();
  }

  function run(): Promise<void> {
    if (inflight !== null) {
      // A request arrived mid-run: its state (foreignSessions/homeOrganization)
      // was not read by the run already in flight, so schedule one more pass
      // once it settles rather than serving this caller a stale answer.
      rerun = true;
      return inflight;
    }
    inflight = (async () => {
      do {
        rerun = false;
        await runInner().catch((err: unknown) =>
          console.error("[sidecar] organization repair failed:", err),
        );
      } while (rerun && !stopped);
    })().finally(() => {
      inflight = null;
    });
    return inflight;
  }

  return {
    run,
    invalidate: (sessions) => {
      for (const session of sessions) invalidated.add(pairKey(session));
      return run();
    },
    stop: () => {
      stopped = true;
      disarmRetry();
    },
  };
}
