import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { listen } from "@tauri-apps/api/event";
import {
  organizationLabelMap,
  type OrganizationEntry,
  popoutQueryInputs,
  popoutQuotaTag,
  popoutReadings,
  scopeMembershipReadings,
  type PopoutReadings,
  type RankedPopoutViewInput,
  type ScopeMembershipReading,
  statusSnapshotSchema,
  type StatusSnapshot,
  type TrackedMembership,
} from "@maxprice/shared";
import { rosterWindowState } from "@/lib/organization-scope-view";
import { sidecarExited, sidecarFetch } from "@/lib/sidecar";
import { insideTauri } from "@/lib/tauri";
import { applyStoredTheme } from "@/lib/theme";
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
// tokens, and the limits read the head Organization's usage current, or the
// Scope's Memberships off `/api/accounts` on an install tracking two or more
// Accounts (`popoutSource`). The settings
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
// popout window is created hidden at process start, so its sidecar fetches
// every 30s ran for the entire life of a resident tray app against a window
// nobody could see (an /api/blocks among them, until ADR-0142 retired it: it
// re-folded the whole corpus on every call).
//
// The mount-time fetch is left alone deliberately: one round of fetches at
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
// packages/shared/src/popout-view.ts), and `usageConnection` and the head
// Organization's Limits answer and Window states (whether its limits can be
// read, and which windows its plan reports), and the main window's copy lives
// in a zustand store fed by its SSE channel, which a glance surface has no
// business standing up.
export function popoutStatusQueryKey(): [string] {
  return ["popout-status"];
}

export async function fetchPopoutStatus(signal?: AbortSignal): Promise<StatusSnapshot> {
  const res = await sidecarFetch("/api/status", { signal });
  if (!res.ok) throw new Error(`/api/status ${res.status}`);
  return statusSnapshotSchema.parse(await res.json());
}

// The readings are `popoutReadings`' over the three answers: ADR-0047's
// `ready`/`hasData` pair passed through untouched so the view can apply
// `corpusIsEmpty` to both, and the head Organization's Limits answer and
// Window states (#384) from the status the popout already fetches.
export type PopoutData = PopoutReadings & {
  anyError: boolean;
  // The shell confirms the sidecar exited (ADR-0112). Raw: popoutView alone
  // decides whether that makes the down state a stop.
  engineStopped: boolean;
  settled: boolean;
  // The head's Organization's label for the eyebrow (`popoutQuotaTag`): the
  // one Membership's while the source is `membership`.
  quotaTag: string | null;
  // Its plan word off the roster, null when unknown or not yet loaded.
  plan: string | null;
  // The Scope is every tracked Membership, and more than one
  // (`ScopeView.isAll`): the Today row says so.
  allOrganizations: boolean;
  // The ranked Popout's readings (#638) while `popoutSource` is `ranked`,
  // else null: the one-Membership Popout.
  ranked: Pick<RankedPopoutViewInput, "memberships" | "plans" | "windowState"> | null;
};

// What the Popout reads, by the Scope's multi-Membership set, which only an
// install tracking two or more Accounts fills (`scopeMembershipSet`), as the
// shell sizes it (`/api/readout`'s `popoutLimitRows`, read from the same
// set):
// - `head`: the set empty, as on a one-Account install under every Scope,
//   All organizations included: the head Organization's usage current and
//   status entry;
// - `membership`: one Membership (#738): its own reading, connection and
//   Limits answer off `/api/accounts`, as Live's card reads it, never its
//   Organization's projection, which reads the Home Account's;
// - `ranked`: two or more, the ranked Popout (#638; #610's "head + ranked").
// Pure, for its test.
export type PopoutSource = "head" | "membership" | "ranked";
export function popoutSource(set: readonly TrackedMembership[]): PopoutSource {
  return set.length === 0 ? "head" : set.length === 1 ? "membership" : "ranked";
}

// The one-Membership Popout's head: the set's one Membership while the
// source is `membership` and `/api/accounts` has answered, its Organization
// naming the eyebrow (`popoutQuotaTag`) and the plan; else the Scope's head
// Organization. Pure, for its test.
export type PopoutHeadSource = {
  membership: ScopeMembershipReading | undefined;
  organization: string | undefined;
  quotaTag: string | null;
  plan: string | null;
};
export function popoutHead(
  source: PopoutSource,
  readings: readonly ScopeMembershipReading[] | undefined,
  quotaOrganization: string | undefined,
  multi: boolean,
  roster: readonly OrganizationEntry[] | undefined,
): PopoutHeadSource {
  const membership = source === "membership" ? readings?.[0] : undefined;
  const organization = membership?.organizationUuid ?? quotaOrganization;
  return {
    membership,
    organization,
    quotaTag: popoutQuotaTag(multi, organization, roster),
    plan: roster?.find((o) => o.uuid === organization)?.plan ?? null,
  };
}

export function usePopoutData(): PopoutData {
  const { data: settings } = useSettings();
  const { params: scope, quotaOrganization, isAll, multi } = useScope();
  const { memberships: scopeSet } = useScopeMemberships();
  const source = popoutSource(scopeSet);
  const rankedMode = source === "ranked";
  // The two sources that read the set read it off `/api/accounts`.
  const readsSet = source !== "head";
  // Is this window on screen? FALSE is the truthful initial state: the popout
  // window is created hidden (`"visible": false` in tauri.conf.json) and stays
  // that way until the first tray click. Only the Rust pokes below move it —
  // nothing the renderer can read ever will.
  const [shown, setShown] = useState(false);
  // Today's window, as `popoutQueryInputs` explains it; the Headless
  // client's `live` requests the same.
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
  // Account roster that decides the source, and every Membership's reading
  // while the Popout reads the set. This observer adds the deadline and,
  // while it reads the set, the popout's interval; on a one-Account install
  // it fetches nothing `useScope` does not.
  const accountsQ = useQuery({
    queryKey: accountsQueryKey(),
    queryFn: ({ signal }) => withDeadline(signal, (s) => fetchAccounts(s)),
    refetchInterval: shown && readsSet ? POPOUT_REFRESH_MS : false,
    retry: POPOUT_RETRY,
  });
  // The roster: the plan word (`none on Ultra`, ADR-0142 §2), the head
  // Organization's label while more than one is tracked, and in ranked mode
  // every row's name and Window states. Not part of `anyError`: a label is
  // not a reading, so a failed roster leaves the eyebrow untagged, the plan
  // unnamed (and ranked rows on the shared fallback label) rather than
  // blanking the popout.
  const rosterQ = useQuery({
    queryKey: organizationsQueryKey(),
    queryFn: ({ signal }) => withDeadline(signal, (s) => fetchOrganizations(s)),
    retry: POPOUT_RETRY,
  });
  const roster = rosterQ.data?.organizations;
  // The set's readings while the Popout reads the set; undefined until
  // `/api/accounts` answers.
  const setReadings = useMemo(
    () =>
      readsSet && accountsQ.data !== undefined
        ? scopeMembershipReadings(
            scopeSet,
            accountsQ.data.accounts,
            organizationLabelMap(roster ?? []),
          )
        : undefined,
    [readsSet, scopeSet, accountsQ.data, roster],
  );
  const rankedMemberships = rankedMode ? (setReadings ?? []) : null;
  const head = popoutHead(source, setReadings, quotaOrganization, multi, roster);
  // The set's readings come off `/api/accounts`, so usage current is the
  // head Organization's popout's alone.
  const usageQ = useQuery({
    queryKey: usageCurrentQueryKey(quotaOrganization),
    queryFn: ({ signal }) => withDeadline(signal, (s) => fetchUsageCurrent(s, quotaOrganization)),
    enabled: !readsSet,
    refetchInterval: shown ? POPOUT_REFRESH_MS : false,
    retry: POPOUT_RETRY,
  });

  const anyError =
    statusQ.isError || dailyQ.isError || (readsSet ? accountsQ.isError : usageQ.isError);
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

  // Settled once the roster has answered too, failed or not, so no row or
  // note flashes the fallback label or plan first; while it reads the set,
  // once the accounts it reads have answered (they have: the source needs
  // them).
  const rosterSettled = rosterQ.data !== undefined || rosterQ.isError;
  const settled =
    statusQ.data !== undefined &&
    dailyQ.data !== undefined &&
    rosterSettled &&
    (readsSet ? accountsQ.data !== undefined : usageQ.data !== undefined);

  return {
    anyError,
    engineStopped: exitQ.data === true,
    settled,
    ...popoutReadings(
      {
        status: statusQ.data,
        today: dailyQ.data,
        usage: usageQ.data,
        ...(head.membership === undefined ? {} : { membership: head.membership }),
      },
      inputs.todayYmd,
      head.organization,
    ),
    quotaTag: head.quotaTag,
    plan: head.plan,
    allOrganizations: isAll,
    ranked:
      rankedMemberships === null
        ? null
        : {
            memberships: rankedMemberships,
            plans: new Map((roster ?? []).map((o) => [o.uuid, o.plan])),
            windowState: (uuid, window) => rosterWindowState(roster, uuid, window),
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
