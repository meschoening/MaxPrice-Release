import { useMemo } from "react";
import { useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { parseSettings, type Settings, type TimeDisplay, DEFAULT_SETTINGS } from "@maxprice/shared";
import { insideTauri } from "@/lib/tauri";
import { logClientEvent } from "@/lib/client-log";
import { showToast } from "@/lib/toast";

// useSettings — the renderer's single read/write surface for the durable
// settings.json (ADR-0014). Settings travel to the engine as `mode`/`tz`
// query params; the renderer is the sole writer of the file.
//
// This honors the ADR-0004 four-piece split in spirit — a query key, a fetch,
// a wrapper — but has no URL builder: it talks to Rust via Tauri IPC
// (`read_settings`/`write_settings`), not the sidecar's HTTP surface. Host
// detection (`insideTauri`) lives in `@/lib/tauri` so lib/ can depend on it too.

export const settingsQueryKey = ["settings"] as const;

// Standalone Vite dev (no Tauri host): an in-memory settings object stands in
// for settings.json so the Settings page — and the machine-axis gate reading
// hubFleetReplica (ADR-0041 M6) — actually function on the Playwright/Vite
// rig. Session-scoped, never persisted; the packaged (insideTauri) path is
// untouched. Exported reset is test-only.
let devSettings: Settings | null = null;
export function __resetDevSettings(): void {
  devSettings = null;
}

export async function fetchSettings(): Promise<Settings> {
  // Standalone Vite dev: no Tauri host, so `read_settings`/`write_settings`
  // would throw. Fall back to the in-memory dev seam (defaults until written).
  if (!insideTauri()) return devSettings ?? DEFAULT_SETTINGS;

  const raw = await invoke<unknown>("read_settings");
  // An empty object means "no settings.json to read yet". `read_settings`
  // returns {} for both an absent file AND a corrupt/unparseable one — the Rust
  // side is deliberately tolerant of malformed JSON so a damaged file self-heals
  // on the next write (see read_settings in src-tauri/src/lib.rs). Either way we
  // treat it as first launch: seed defaults (costMode falls back to
  // DEFAULT_SETTINGS.costMode = "auto") and persist. The Part-5→6 costMode
  // migration from the legacy Zustand blob (ADR-0014) is retired: the persist-key
  // and bundle-id rename (`ccusage-desktop.filters`/`com.ccusage.desktop` →
  // `maxprice.filters`/`com.maxprice.desktop`) deliberately orphans the old blob.
  const isEmpty = raw !== null && typeof raw === "object" && Object.keys(raw).length === 0;
  if (isEmpty) {
    const seeded: Settings = { ...DEFAULT_SETTINGS };
    await invoke("write_settings", { next: seeded });
    return seeded;
  }
  return parseSettings(raw);
}

export async function writeSettings(next: Settings): Promise<void> {
  // Outside Tauri the write lands in the in-memory dev seam so a standalone-Vite
  // session sees its own edits (packaged path untouched).
  if (!insideTauri()) {
    devSettings = next;
    return;
  }
  await invoke("write_settings", { next });
}

export function useSettings(): UseQueryResult<Settings> {
  return useQuery({ queryKey: settingsQueryKey, queryFn: fetchSettings });
}

// The renderer's single source for HOW TO RENDER A CLOCK TIME (ADR-0060) — the
// pair every clock site takes: which zone, and 24h vs AM/PM. One hook so the
// while-loading fallback is stated exactly once.
//
// That fallback is `DEFAULT_SETTINGS.timeFormat`, not a literal "24h": defaults
// are seeded from the host's own hour cycle, so the pre-load render already
// agrees with the value about to arrive and a US machine never flashes `14:05`
// before settling on `2:05 PM`.
//
// Memoized on the two primitives, so the returned object is referentially
// stable and safe to put in a consumer's dep array. `use-chart-source` still
// deliberately deps on the raw `timeFormat` primitive instead — its memo is
// hand-maintained under a disabled exhaustive-deps rule, where an object dep is
// the more fragile choice.
export function useTimeDisplay(): TimeDisplay {
  const { data: settings } = useSettings();
  const tz = settings?.timezone;
  const timeFormat = settings?.timeFormat ?? DEFAULT_SETTINGS.timeFormat;
  return useMemo(() => ({ tz, timeFormat }), [tz, timeFormat]);
}

// Serialize settings writes through a module-level promise chain. The body is a
// non-atomic read-modify-write (read cache → merge patch → write → setQueryData),
// so two quick `update()` calls would otherwise both read the same stale cache
// snapshot and the second would clobber the first's field. Each link recomputes
// `next` from the FRESHEST cache value at the moment it runs, so concurrent
// patches merge instead of overwrite.
let writeChain: Promise<void> = Promise.resolve();

// Patch one or more settings fields. After writing, set the settings cache then
// invalidate the settings query to reconcile with disk; report views refetch
// automatically because `mode` and `tz` are part of their query keys, so a
// costMode/timezone change re-reads with the new value once the settings data
// updates.
export function useUpdateSettings(): (patch: Partial<Settings>) => Promise<void> {
  const qc = useQueryClient();
  return (patch) => {
    const run = writeChain.then(async () => {
      const current = qc.getQueryData<Settings>(settingsQueryKey) ?? DEFAULT_SETTINGS;
      const next = { ...current, ...patch };
      await writeSettings(next);
      qc.setQueryData(settingsQueryKey, next);
      await qc.invalidateQueries({ queryKey: settingsQueryKey });
    });
    // TWO catches on `run`, doing two different jobs.
    //
    // The first keeps the module-level CHAIN alive: swallowing on the chain tail
    // means one failed write can't wedge every later one.
    writeChain = run.catch(() => {});
    // The second REPORTS. Every call site but `reset` fires this
    // fire-and-forget (`void update(...)`), and attaching any reaction marks the
    // rejection handled — so before this, a failed `write_settings` (denied
    // permissions, full disk, IPC error) was completely silent: `setQueryData`
    // never ran, the control snapped back to its old value, and not even an
    // unhandled-rejection warning appeared. A renderer failure the user cannot
    // see is precisely what the durable log exists for (ADR-0056/ADR-0059), and
    // the toast is the half of it the user gets to act on. Fixed here rather
    // than at the six call sites, which would leave five identical holes.
    run.catch((e: unknown) => {
      logClientEvent(`settings write failed: ${String(e)}`);
      showToast("Couldn't save settings");
    });
    // Returned UNCHANGED, so a caller that does await still sees the rejection
    // (`reset` then reports twice — harmless, and better than a caller whose
    // own error handling was silently disarmed).
    return run;
  };
}
