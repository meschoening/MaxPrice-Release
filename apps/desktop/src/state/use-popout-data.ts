import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { listen } from "@tauri-apps/api/event";
import {
  activeBlockOf,
  blocksHeadAccountNotKnown,
  homeMembershipOf,
  organizationLabelMap,
  popoutHeadMembership,
  popoutQueryInputs,
  popoutQuotaTag,
  popoutReadings,
  rankedHeadBlocksInput,
  scopeMembershipReadings,
  type PopoutReadings,
  type RankedPopoutViewInput,
  statusSnapshotSchema,
  type StatusSnapshot,
  type TrackedMembership,
  withAccountNotKnown,
} from "@maxprice/shared";
import { sidecarExited, sidecarFetch } from "@/lib/sidecar";
import { insideTauri } from "@/lib/tauri";
import { applyStoredTheme } from "@/lib/theme";
import { blocksQueryKey, fetchBlocks } from "./use-blocks";
import { dailyQueryKey, fetchDaily } from "./use-daily";
import {
  accountsQueryKey,
  fetchAccounts,
  fetchOrganizations,
  organizationsQueryKey,
} from "./use-organizations";
import { fetchUsageCurrent, usageCurrentQueryKey } from "./use-usage-current";
import { useScope } from "./use-scope";
import { useScopeMemberships } from "./use-scope-memberships";
import { useSettings } from "./use-settings";

// The popout's own data plumbing (map #168 M3; T5 decision 8): the popout's
// dashboard numbers are its OWN sidecar fetches — it never reads the tray
// readout string, and the ambient Rust writer never feeds it. This webview has
// its own QueryClient (one bundle, two windows — main.tsx), so nothing here
// can collide with the main window's cache.
//
// Those fetches follow the persisted Scope (ADR-0106 §11, #637) through the
// same `useScope` as the main window: the money queries carry the Scope's
// tokens, usage current reads the Quota organization's entry. The settings
// query is one of the queries `popout:shown` invalidates, so a Scope flip
// made in the main window lands on the popout's next open.
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

// Is a failing popout an Engine stop (ADR-0112 §4)? The fetches only ever
// fail, whether the sidecar exited or merely stopped answering, so while one
// is failing the popout asks the shell (`sidecarExited`). The shell records
// the exit a beat after the socket drops, so a probe that lands first reads
// a live sidecar; it asks again each second while the popout is on screen,
// until the shell confirms. Never while hidden: nobody is reading, and the
// next show invalidates every query, this one included.
export const EXIT_PROBE_MS = 1_000;

export function popoutSidecarExitQueryKey(): [string] {
  return ["popout-sidecar-exit"];
}

// The probe's interval, pure for its test.
export function exitProbeInterval(shown: boolean, exited: boolean | undefined): number | false {
  return shown && exited !== true ? EXIT_PROBE_MS : false;
}

// Keep in lockstep with popout.rs's POPOUT_SHOWN_EVENT / POPOUT_HIDDEN_EVENT
// and ambient.rs's UPDATE_AVAILABLE_EVENT.
const POPOUT_SHOWN_EVENT = "popout:shown";
const POPOUT_HIDDEN_EVENT = "popout:hidden";
const UPDATE_AVAILABLE_EVENT = "update:available";

// /api/status, four-piece style (ADR-0004) — the popout needs `ready` +
// `hasData` (the first-launch inset, which takes BOTH per ADR-0047; see
// packages/shared/src/popout-view.ts) and `usageConnection` (the ADR-0030
// limit-row dim), and the main window's copy lives in a zustand store fed by
// its SSE channel, which a glance surface has no business standing up.
export function popoutStatusQueryKey(): [string] {
  return ["popout-status"];
}

export async function fetchPopoutStatus(signal?: AbortSignal): Promise<StatusSnapshot> {
  const res = await sidecarFetch("/api/status", { signal });
  if (!res.ok) throw new Error(`/api/status ${res.status}`);
  return statusSnapshotSchema.parse(await res.json());
}

// The readings are `popoutReadings`' over the four answers, shared with the
// Headless client's `live`: ADR-0047's `ready`/`hasData` pair passed through
// untouched so the view can apply `corpusIsEmpty` to both, and the Quota
// organization's 5-hour Window state (#384) from the status the popout
// already fetches.
export type PopoutData = PopoutReadings & {
  anyError: boolean;
  // The shell confirms the sidecar exited (ADR-0112). Raw: popoutView alone
  // decides whether that makes the down state a stop.
  engineStopped: boolean;
  settled: boolean;
  // The Quota organization's label for the eyebrow (`popoutQuotaTag`).
  quotaTag: string | null;
  // The Scope is every tracked Membership, and more than one
  // (`ScopeView.isAll`): the Today row says so.
  allOrganizations: boolean;
  // The ranked Popout's readings (#638) while `rankedPopoutMode` holds, else
  // null: today's popout.
  ranked: Pick<RankedPopoutViewInput, "memberships" | "headBlocks"> | null;
};

// The ranked Popout (#638; #610's "head + ranked") draws over the Scope's
// multi-Membership set: two or more Memberships, which only an install
// tracking two or more Accounts has (`scopeMembershipSet`). A one-Account
// install keeps today's popout under every Scope, All organizations
// included, as the shell keeps its height (`/api/readout`'s
// `popoutLimitRows`, read from the same set). Pure, for its test.
export function rankedPopoutMode(set: readonly TrackedMembership[]): boolean {
  return set.length >= 2;
}

// `now` is the popout's 1Hz tick: the ranked head is chosen by the windows
// in flight at that moment, and its Blocks are asked for by its token.
export function usePopoutData(now: number): PopoutData {
  const { data: settings } = useSettings();
  const { params: scope, quotaOrganization, isAll, multi } = useScope();
  const { memberships: scopeSet } = useScopeMemberships();
  const rankedMode = rankedPopoutMode(scopeSet);
  // Is this window on screen? FALSE is the truthful initial state: the popout
  // window is created hidden (`"visible": false` in tauri.conf.json) and stays
  // that way until the first tray click. Only the Rust pokes below move it —
  // nothing the renderer can read ever will.
  const [shown, setShown] = useState(false);
  // Today's window and the blocks window, as `popoutQueryInputs` explains
  // them; the Headless client's `live` requests the same two.
  const inputs = popoutQueryInputs({
    mode: settings?.costMode ?? "auto",
    tz: settings?.timezone,
    scope,
  });

  const statusQ = useQuery({
    queryKey: popoutStatusQueryKey(),
    queryFn: ({ signal }) => withDeadline(signal, (s) => fetchPopoutStatus(s)),
    refetchInterval: shown ? POPOUT_REFRESH_MS : false,
    retry: POPOUT_RETRY,
  });
  const dailyQ = useQuery({
    queryKey: dailyQueryKey(inputs.today),
    queryFn: ({ signal }) => withDeadline(signal, (s) => fetchDaily(inputs.today, s)),
    refetchInterval: shown ? POPOUT_REFRESH_MS : false,
    retry: POPOUT_RETRY,
  });
  // `/api/accounts`, which `useScope` already reads on every popout: the
  // Account roster that decides the mode, and in ranked mode every
  // Membership's reading. This observer adds the deadline and, in ranked
  // mode only, the popout's interval; on a one-Account install it fetches
  // nothing `useScope` does not.
  const accountsQ = useQuery({
    queryKey: accountsQueryKey(),
    queryFn: ({ signal }) => withDeadline(signal, (s) => fetchAccounts(s)),
    refetchInterval: shown && rankedMode ? POPOUT_REFRESH_MS : false,
    retry: POPOUT_RETRY,
  });
  // The roster, for the Quota organization's label, and in ranked mode every
  // row's — fetched only on a machine that tracks more than one Organization
  // or draws ranked, so a single-Organization, single-Account popout makes
  // exactly its four fetches. Not part of `anyError`: a label is not a
  // reading, so a failed roster leaves the eyebrow untagged (and ranked rows
  // on the shared fallback label) rather than blanking the popout.
  const rosterQ = useQuery({
    queryKey: organizationsQueryKey(),
    queryFn: ({ signal }) => withDeadline(signal, (s) => fetchOrganizations(s)),
    enabled: multi || rankedMode,
    retry: POPOUT_RETRY,
  });
  const roster = rosterQ.data?.organizations;
  const rankedMemberships = useMemo(
    () =>
      rankedMode
        ? scopeMembershipReadings(
            scopeSet,
            accountsQ.data?.accounts ?? [],
            organizationLabelMap(roster ?? []),
          )
        : null,
    [rankedMode, scopeSet, accountsQ.data, roster],
  );
  const head = rankedMemberships === null ? null : popoutHeadMembership(rankedMemberships, now);
  const headBlocksInput =
    rankedMemberships === null ? null : rankedHeadBlocksInput(inputs.blocks, head);

  // Ranked mode asks for the head Membership's own Blocks, or none while the
  // head is idle; otherwise the Scope's, as ever.
  const blocksInput = rankedMemberships === null ? inputs.blocks : headBlocksInput;
  const blocksQ = useQuery({
    queryKey: blocksQueryKey(blocksInput ?? inputs.blocks),
    queryFn: ({ signal }) =>
      withDeadline(signal, (s) => fetchBlocks(blocksInput ?? inputs.blocks, s)),
    enabled: blocksInput !== null,
    refetchInterval: shown ? POPOUT_REFRESH_MS : false,
    retry: POPOUT_RETRY,
  });
  // Ranked rows read `/api/accounts`, so usage current is today's popout's
  // alone.
  const usageQ = useQuery({
    queryKey: usageCurrentQueryKey(quotaOrganization),
    queryFn: ({ signal }) => withDeadline(signal, (s) => fetchUsageCurrent(s, quotaOrganization)),
    enabled: !rankedMode,
    refetchInterval: shown ? POPOUT_REFRESH_MS : false,
    retry: POPOUT_RETRY,
  });

  const anyError =
    statusQ.isError ||
    dailyQ.isError ||
    (blocksInput !== null && blocksQ.isError) ||
    (rankedMode ? accountsQ.isError : usageQ.isError);
  const exitQ = useQuery({
    queryKey: popoutSidecarExitQueryKey(),
    queryFn: () => sidecarExited(),
    enabled: anyError,
    refetchInterval: (query) => exitProbeInterval(shown, query.state.data),
    retry: false,
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

  // Ranked mode has settled once the accounts it reads have answered (they
  // have: the mode needs them), the head's Blocks too while it has one, and
  // the roster, failed or not, so no row flashes the fallback label first.
  const settled =
    statusQ.data !== undefined &&
    dailyQ.data !== undefined &&
    (blocksInput === null || blocksQ.data !== undefined) &&
    (rankedMode
      ? accountsQ.data !== undefined && (rosterQ.data !== undefined || rosterQ.isError)
      : usageQ.data !== undefined);

  return {
    anyError,
    engineStopped: exitQ.data === true,
    settled,
    ...popoutReadings(
      { status: statusQ.data, today: dailyQ.data, blocks: blocksQ.data, usage: usageQ.data },
      inputs.todayYmd,
      quotaOrganization,
    ),
    // The head Blocks are the Unknown Membership's in place of an empty Home
    // membership (#644): the eyebrow says "account not known".
    quotaTag: withAccountNotKnown(
      popoutQuotaTag(multi, quotaOrganization, rosterQ.data?.organizations),
      blocksHeadAccountNotKnown(
        blocksQ.data,
        settings === undefined ? null : homeMembershipOf(settings),
      ),
    ),
    allOrganizations: isAll,
    ranked:
      rankedMemberships === null
        ? null
        : {
            memberships: rankedMemberships,
            headBlocks:
              head === null || headBlocksInput === null
                ? null
                : {
                    token: head.key,
                    block: activeBlockOf(blocksQ.data?.blocks ?? []) ?? null,
                  },
          },
  };
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
