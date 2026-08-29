import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { listen } from "@tauri-apps/api/event";
import {
  statusSnapshotSchema,
  type BlockRow,
  type ModelScopedWindow,
  type StatusSnapshot,
  type UsageWindow,
} from "@maxprice/shared";
import { sidecarFetch } from "@/lib/sidecar";
import { insideTauri } from "@/lib/tauri";
import { applyStoredTheme } from "@/lib/theme";
import { ymdShift } from "@/lib/dates";
import { blocksQueryKey, fetchBlocks } from "./use-blocks";
import { dailyQueryKey, fetchDaily } from "./use-daily";
import { fetchUsageCurrent, usageCurrentQueryKey } from "./use-usage-current";
import { useSettings } from "./use-settings";

// The popout's own data plumbing (map #168 M3; T5 decision 8): the popout's
// dashboard numbers are its OWN sidecar fetches — it never reads the tray
// readout string, and the ambient Rust writer never feeds it. This webview has
// its own QueryClient (one bundle, two windows — main.tsx), so nothing here
// can collide with the main window's cache.
//
// Refetch model: a Rust-emitted `popout:shown` poke invalidates everything on
// every show, plus a slow interval so a popout left open keeps breathing —
// parked by the matching `popout:hidden` while the window is off screen.
//
// Both pokes come from Rust because this webview cannot observe its own window
// appearing or disappearing at all; the whole reasoning lives once in
// src-tauri/src/popout.rs's "Window-visibility events" note.
//
// That is also why the interval has to be gated BY HAND. An earlier comment
// here claimed the OS throttles a hidden window's timers, which is simply
// false for this window — and believing it is what shipped the bug. TanStack's
// `refetchInterval` is silently conditioned on `focusManager.isFocused()`,
// which resolves to `document.visibilityState !== "hidden"`; WebView2 leaves
// that "visible" through a hide, so nothing anywhere stopped the timer. The
// popout window is created hidden at process start, so four sidecar fetches
// every 30s ran for the entire life of a resident tray app against a window
// nobody could see — /api/blocks among them, which has no ADR-0057 report-cache
// entry and so re-folds the whole corpus on every call.
//
// The mount-time fetch is left alone deliberately: one round of four fetches at
// launch (the popout must be readable the instant the first tray click lands,
// and `popout:shown` invalidates on top of it anyway), then silence until that
// click.
const POPOUT_REFRESH_MS = 30_000;

// A popout fetch that never returns is the failure mode issue #183 exposed:
// the sidecar completed its ADR-0002 handshake, held the port, and answered
// nothing for minutes. TanStack has no `isError` for a request still in
// flight — `isError` needs a rejection — so `anyError` stayed false and
// `settled` stayed false for the whole episode, and the ladder's most
// confident state was reached with the least information.
//
// A deadline converts the hang into a rejection, which the ladder already
// knows how to say out loud (the `down` inset: "can't reach the engine").
// 5s is a glance surface's patience, not the engine's: a healthy answer here
// is single-digit milliseconds, and the tray popout is opened to be read now.
// `retry: 1` because the default 3-with-backoff would spend most of a minute
// deciding, which on this surface is indistinguishable from the hang.
const POPOUT_FETCH_TIMEOUT_MS = 5_000;
const POPOUT_RETRY = 1;

// Runs `fetch` under BOTH TanStack's cancellation signal and a deadline, on a
// derived controller. Deriving matters: aborting TanStack's own signal would
// read as a cancellation and never surface as an error, which is the exact
// silence being fixed. Exported for its test.
export async function withDeadline<T>(
  signal: AbortSignal | undefined,
  run: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number = POPOUT_FETCH_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController();
  const relay = (): void => controller.abort(signal?.reason);
  if (signal?.aborted === true) relay();
  else signal?.addEventListener("abort", relay, { once: true });
  const timer = setTimeout(
    () => controller.abort(new Error(`popout fetch timed out after ${timeoutMs}ms`)),
    timeoutMs,
  );
  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", relay);
  }
}

// Keep in lockstep with popout.rs's POPOUT_SHOWN_EVENT / POPOUT_HIDDEN_EVENT
// and ambient.rs's UPDATE_AVAILABLE_EVENT.
const POPOUT_SHOWN_EVENT = "popout:shown";
const POPOUT_HIDDEN_EVENT = "popout:hidden";
const UPDATE_AVAILABLE_EVENT = "update:available";

// /api/status, four-piece style (ADR-0004) — the popout needs `ready` +
// `hasData` (the first-launch inset, which takes BOTH per ADR-0047; see
// popout-view.ts) and `usageConnection` (the ADR-0030 limit-row dim), and
// the main window's copy lives in a zustand store fed by its SSE channel,
// which a glance surface has no business standing up.
export function popoutStatusQueryKey(): [string] {
  return ["popout-status"];
}

export async function fetchPopoutStatus(signal?: AbortSignal): Promise<StatusSnapshot> {
  const res = await sidecarFetch("/api/status", { signal });
  if (!res.ok) throw new Error(`/api/status ${res.status}`);
  return statusSnapshotSchema.parse(await res.json());
}

export type PopoutData = {
  anyError: boolean;
  settled: boolean;
  // ADR-0047's pair, passed through untouched so the view can apply
  // `corpusIsEmpty` to both. `null` before the first status frame.
  ready: boolean | null;
  hasData: boolean | null;
  usageConnected: boolean;
  block: BlockRow | null;
  usageWindow: UsageWindow | null;
  weeklyWindow: UsageWindow | null;
  modelWindow: ModelScopedWindow | null;
  todayCost: number;
  todayTokens: number;
};

export function usePopoutData(): PopoutData {
  const { data: settings } = useSettings();
  // Is this window on screen? FALSE is the truthful initial state: the popout
  // window is created hidden (`"visible": false` in tauri.conf.json) and stays
  // that way until the first tray click. Only the Rust pokes below move it —
  // nothing the renderer can read ever will.
  const [shown, setShown] = useState(false);
  const mode = settings?.costMode ?? "auto";
  const tz = settings?.timezone;
  const today = ymdShift(0, tz);
  const yesterday = ymdShift(-1, tz);

  const statusQ = useQuery({
    queryKey: popoutStatusQueryKey(),
    queryFn: ({ signal }) => withDeadline(signal, (s) => fetchPopoutStatus(s)),
    refetchInterval: shown ? POPOUT_REFRESH_MS : false,
    retry: POPOUT_RETRY,
  });
  // Today's row only — the Today tile's cost + tokens (ADR-0020's calendar day).
  const dailyInput = { since: today, until: today, mode, tz };
  const dailyQ = useQuery({
    queryKey: dailyQueryKey(dailyInput),
    queryFn: ({ signal }) => withDeadline(signal, (s) => fetchDaily(dailyInput, s)),
    refetchInterval: shown ? POPOUT_REFRESH_MS : false,
    retry: POPOUT_RETRY,
  });
  // The active block can straddle midnight, so the window reaches back a day.
  // Blocks are cross-project by design and the popout carries no filter rail,
  // so the input is bare (ADR-0017 untouched).
  const blocksInput = { since: yesterday, until: today, mode, tz };
  const blocksQ = useQuery({
    queryKey: blocksQueryKey(blocksInput),
    queryFn: ({ signal }) => withDeadline(signal, (s) => fetchBlocks(blocksInput, s)),
    refetchInterval: shown ? POPOUT_REFRESH_MS : false,
    retry: POPOUT_RETRY,
  });
  const usageQ = useQuery({
    queryKey: usageCurrentQueryKey(),
    queryFn: ({ signal }) => withDeadline(signal, (s) => fetchUsageCurrent(s)),
    refetchInterval: shown ? POPOUT_REFRESH_MS : false,
    retry: POPOUT_RETRY,
  });

  const queryClient = useQueryClient();
  // The two visibility pokes, on THIS webview (`getCurrentWebviewWindow`, not
  // the global `listen`): both windows run the same bundle, so the popout must
  // only ever hear about the popout. Registered once; each unlisten settles
  // async (the promise resolves after registration).
  //
  // Show: refetch everything, re-stamp the theme, and start the interval.
  // Hide: park the interval — the next show pays for the gap in one pass.
  useEffect(() => {
    if (!insideTauri()) return;
    const self = getCurrentWebviewWindow();
    const unlistenShown = self.listen(POPOUT_SHOWN_EVENT, () => {
      setShown(true);
      applyStoredTheme();
      void queryClient.invalidateQueries();
    });
    const unlistenHidden = self.listen(POPOUT_HIDDEN_EVENT, () => {
      setShown(false);
    });
    return () => {
      void unlistenShown.then((off) => off());
      void unlistenHidden.then((off) => off());
    };
  }, [queryClient]);

  const settled =
    statusQ.data !== undefined &&
    dailyQ.data !== undefined &&
    blocksQ.data !== undefined &&
    usageQ.data !== undefined;

  const blocks = blocksQ.data?.blocks ?? [];
  const todayRow = dailyQ.data?.daily.find((r) => r.date === isoDate(today));
  return {
    anyError: statusQ.isError || dailyQ.isError || blocksQ.isError || usageQ.isError,
    settled,
    ready: statusQ.data?.ready ?? null,
    hasData: statusQ.data?.hasData ?? null,
    usageConnected: statusQ.data?.usageConnection === "connected",
    block: blocks.find((b) => b.isActive && !b.isGap) ?? null,
    usageWindow: usageQ.data?.sample?.fiveHour ?? null,
    weeklyWindow: usageQ.data?.sample?.weekly ?? null,
    modelWindow: usageQ.data?.sample?.weeklyModel ?? null,
    todayCost: todayRow?.totalCost ?? 0,
    todayTokens: todayRow?.totalTokens ?? 0,
  };
}

// The wire `date` is dashed YYYY-MM-DD; ymdShift returns dashless YYYYMMDD.
function isoDate(ymd: string): string {
  return `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
}

// The pending update's version, for the accent update row (T5 decision 7):
// seeded from Rust state at mount (`get_pending_update` — the check may have
// landed before this webview finished parsing), kept live by the broadcast
// `update:available` event. Outside Tauri both halves no-op to null.
export function usePendingUpdate(): string | null {
  const queryClient = useQueryClient();
  const pendingQ = useQuery({
    queryKey: ["pending-update"],
    queryFn: async () => {
      if (!insideTauri()) return null;
      return await invoke<string | null>("get_pending_update");
    },
  });

  useEffect(() => {
    if (!insideTauri()) return;
    const unlisten = listen<{ version: string }>(UPDATE_AVAILABLE_EVENT, (event) => {
      queryClient.setQueryData(["pending-update"], event.payload.version);
    });
    return () => {
      void unlisten.then((off) => off());
    };
  }, [queryClient]);

  return pendingQ.data ?? null;
}
