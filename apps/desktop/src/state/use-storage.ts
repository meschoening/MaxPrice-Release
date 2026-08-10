import {
  useMutation,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
  useQuery,
} from "@tanstack/react-query";
import {
  STORAGE_CLEAN_PATH,
  STORAGE_FORGET_PATH,
  STORAGE_PATH,
  storageCleanResponseSchema,
  storageForgetResponseSchema,
  storageReportSchema,
  type StorageCleanResponse,
  type StorageForgetRequest,
  type StorageForgetResponse,
  type StorageReport,
} from "@maxprice/shared";
import { sidecarFetch } from "@/lib/sidecar";
import { usageAuthHeaders } from "@/lib/usage-credential";

// GET /api/storage — the Settings › Storage report (map #124). ADR-0004's
// four-piece split, modelled on `use-machines.ts`: the other param-less loopback
// endpoint, and excluded from `DATA_QUERY_KEYS` for the same class of reason.
//
// THE KEY MUST NEVER JOIN `DATA_QUERY_KEYS`. This is load-bearing, not
// stylistic. Inside that set, ADR-0058's completion-gated invalidation rounds
// would fire a DIRECTORY WALK on every `usage:new` burst — reinstating exactly
// the per-minute cost that choosing a dedicated endpoint (rather than a
// `/api/status` field) exists to avoid, and feeding it straight into ADR-0056's
// saturation detector. Nothing about this report is cost-mode- or usage-shaped;
// its only invalidators are the two actions below it on the page.

// Piece 1 — the query key.
export const storageQueryKey = ["storage"] as const;

// Piece 2 — the URL builder.
export function buildStorageUrl(): string {
  return STORAGE_PATH;
}

// Piece 3 — the fetch. `fetchImpl` is a parameter purely for tests.
export async function fetchStorage(
  signal: AbortSignal | undefined,
  fetchImpl: typeof sidecarFetch = sidecarFetch,
): Promise<StorageReport> {
  const res = await fetchImpl(buildStorageUrl(), { signal });
  if (!res.ok) throw new Error(`${STORAGE_PATH} ${res.status}: ${await res.text()}`);
  return storageReportSchema.parse(await res.json());
}

// Piece 4 — the useQuery wrapper.
//
// No polling interval and no window-focus refetch: the sidecar holds no cached
// result, so leaving and re-entering the section already re-measures, and a
// focus refetch would fire a walk on every alt-tab of a page people leave open.
// The numbers move because Clean and Forget invalidate this key when they
// SETTLE — both do irreversible work before they can fail, so a failure has to
// re-measure too.
//
// `enabled` lets the Settings page hold the walk until the section is actually
// on screen.
export function useStorage(enabled = true): UseQueryResult<StorageReport> {
  return useQuery<StorageReport>({
    queryKey: storageQueryKey,
    queryFn: ({ signal }) => fetchStorage(signal),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    enabled,
  });
}

// ── The two actions (#132) ────────────────────────────────────────────────
//
// Both POST behind the sidecar's `x-maxprice-auth` guard (`usageAuthHeaders`
// resolves to `{}` outside Tauri, so the Vite standalone path is unaffected),
// and both invalidate `storageQueryKey` AND NOTHING ELSE.
//
// That narrowness is the point, and it is the mirror image of why the key is
// kept out of `DATA_QUERY_KEYS`. These actions move no report: Clean drops a
// parse cache and some superseded log lines, neither of which any figure in the
// app is derived from. Forget does eventually move the reports — it unlinks the
// replica and re-pulls a pruned archive — but that lands through the fleet's own
// `usage:new` poke, on ADR-0058's completion-gated rounds, exactly as every
// other engine change does. Invalidating the data families from here would
// duplicate that round, and would fire it before the reseed had put anything
// back.
//
// The response bodies are parsed rather than ignored so a shape drift is a loud
// failure; callers may use the counts for a confirmation line, but the section's
// numbers come only from the refetched report.

export function buildStorageCleanUrl(): string {
  return STORAGE_CLEAN_PATH;
}

export function buildStorageForgetUrl(): string {
  return STORAGE_FORGET_PATH;
}

// The sidecar answers a refused action with the pinned error envelope and a 4xx
// / 5xx — a tripped guard, a hub that could not be reached. Surfacing the
// server's own sentence is deliberate: the guard `detail` is written for a human
// and is the same text the disabled button shows, so re-wording it here would
// let the two disagree about why.
async function postStorageAction<T>(
  path: string,
  parse: (raw: unknown) => T,
  fetchImpl: typeof sidecarFetch = sidecarFetch,
  body?: unknown,
): Promise<T> {
  const headers = await usageAuthHeaders();
  const res = await fetchImpl(path, {
    method: "POST",
    headers: body === undefined ? headers : { ...headers, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!res.ok) {
    const text = await res.text();
    let message = text;
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed === "object" && parsed !== null && "error" in parsed) {
        const { error } = parsed as { error: unknown };
        if (typeof error === "string" && error !== "") message = error;
      }
    } catch {
      // Not the envelope — fall back to the raw body, which is still more use
      // than the status alone.
    }
    throw new Error(message === "" ? `${path} ${res.status}` : message);
  }
  return parse(await res.json());
}

export async function postStorageClean(
  fetchImpl: typeof sidecarFetch = sidecarFetch,
): Promise<StorageCleanResponse> {
  return postStorageAction(
    buildStorageCleanUrl(),
    (raw) => storageCleanResponseSchema.parse(raw),
    fetchImpl,
  );
}

export async function postStorageForget(
  req: StorageForgetRequest,
  fetchImpl: typeof sidecarFetch = sidecarFetch,
): Promise<StorageForgetResponse> {
  return postStorageAction(
    buildStorageForgetUrl(),
    (raw) => storageForgetResponseSchema.parse(raw),
    fetchImpl,
    req,
  );
}

export function useStorageClean(): UseMutationResult<StorageCleanResponse, Error, void> {
  const queryClient = useQueryClient();
  return useMutation<StorageCleanResponse, Error, void>({
    mutationFn: () => postStorageClean(),
    // `onSettled`, not `onSuccess`: both actions do real, irreversible work
    // BEFORE they can fail. Clean unlinks `scan-cache.json` and only then awaits
    // `replica.compact()`, so a compact rejection is a 500 with the cache
    // already gone. Re-measuring only on success would leave the section
    // rendering pre-action bytes beside an error — figures asserting nothing
    // happened while bytes were in fact freed.
    onSettled: () => queryClient.invalidateQueries({ queryKey: storageQueryKey }),
  });
}

// The body is a CEILING, not a delete target — the distinction is the whole
// design.
//
// The route still takes no session list, and still re-runs the classifier
// server-side and acts on THAT: a scan can complete, a root can vanish or the
// tripwire can trip between the paint and the click, so a list the renderer
// holds could never authorise a deletion. What the body carries is the two
// figures the confirm dialog was PAINTED with — the numbers the user actually
// signed by typing this machine's name. `useStorage` has a 30s staleTime, no
// polling interval and no focus refetch, and nothing refetches while the dialog
// is open, so that preview can be arbitrarily old; without the ceiling the
// server would delete whatever a fresh pass names, however much it grew. The
// route 409s on growth (`storageForgetRequestSchema`), and the user is asked
// again against the new number.
//
// Clean sends nothing: it has no signed figure — its outcome body is its own
// second measurement, and it is not destructive.
export function useStorageForget(): UseMutationResult<
  StorageForgetResponse,
  Error,
  StorageForgetRequest
> {
  const queryClient = useQueryClient();
  return useMutation<StorageForgetResponse, Error, StorageForgetRequest>({
    mutationFn: (req) => postStorageForget(req),
    // `onSettled`, not `onSuccess`: forget returns `{ ok: false, landed: true }`
    // — which the route turns into a 502 — AFTER `awaitResync()` has already
    // unlinked and reseeded the replica. Re-measuring only on success would
    // leave the section showing pre-action bytes beside an error, asserting
    // nothing happened while hub rows were in fact deleted.
    onSettled: () => queryClient.invalidateQueries({ queryKey: storageQueryKey }),
  });
}
