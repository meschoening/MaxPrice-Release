import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { insideTauri } from "@/lib/tauri";
import type { AutostartState } from "@/lib/presentation";

// Does this app actually start at login (ADR-0051)? A Tauri command rather than
// a daemon endpoint, for the ADR-0038 reason the firewall check is one: the
// login entry is a fact about THIS host's registry, which the daemon neither
// owns nor can see.
//
// Read-only. The console reports the state and does not offer to change it: the
// only "no" the operator can act on is their own Task Manager opt-out, which a
// repair button would exist purely to override.

export function autostartQueryKey(): readonly ["autostart"] {
  return ["autostart"] as const;
}

// Outside Tauri (standalone Vite) there is no registry to read — "unsupported"
// renders no row at all. An unexpected value throws, which the UI also treats
// as silent.
async function readAutostart(): Promise<AutostartState> {
  if (!insideTauri()) return "unsupported";
  const state = await invoke<string>("autostart_status");
  if (
    state === "on" ||
    state === "disabled-by-user" ||
    state === "not-registered" ||
    state === "dev-build" ||
    state === "unsupported"
  )
    return state;
  throw new Error(`Unexpected autostart state: ${state}`);
}

export function useAutostart(): UseQueryResult<AutostartState> {
  return useQuery({
    queryKey: autostartQueryKey(),
    queryFn: () => readAutostart(),
    // A SLOW POLL, not a focus refetch. The entry only ever changes from
    // outside this app (Task Manager, an installer, another build's setup
    // pass), so focus-driven looks like the obvious fit — and it is inert here.
    //
    // MEASURED on the packaged Windows app, 2026-07-27: with the Run value
    // deleted out from under a running console, the row went on reading "Yes"
    // across an OS focus change AND across a hide-to-tray/reopen cycle.
    // TanStack's focusManager keys on `document.visibilityState`, which in a
    // Tauri WebView2 never leaves "visible" — so no transition ever fires and
    // `refetchOnWindowFocus` never runs. A focus-driven query would report the
    // state as of console mount and never move again, which for a row whose
    // whole job is to surface a silent state is worse than not having it.
    //
    // 60s because the underlying read is two registry lookups; the row is
    // "eventually honest" rather than live, which suits a next-boot concern.
    // `refetchIntervalInBackground` mirrors useHubStatus (ADR-0049): both hub
    // windows are hidden as their normal state, and the flag is what keeps the
    // poll running either way, whichever value `isFocused()` actually takes.
    refetchInterval: 60_000,
    refetchIntervalInBackground: true,
  });
}
