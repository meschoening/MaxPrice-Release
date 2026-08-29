import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { insideTauri } from "@/lib/tauri";
import { logClientEvent } from "@/lib/client-log";
import { showToast } from "@/lib/toast";

// The "Start at login" toggle's state (map #168 / M4; ADR-0077). A Tauri
// command pair rather than a settings.json field: the OS login entry IS the
// record of the user's choice, so the row reads it fresh and can never assert
// a state the registry (or LaunchAgent) disagrees with. The hub's ADR-0051
// console row is the template — same states, same slow poll — plus a writer,
// which the hub's always-on posture never needed.

export type AutostartState =
  | "on"
  | "disabled-by-user"
  | "not-registered"
  | "dev-build"
  | "unsupported";

export function autostartQueryKey(): readonly ["autostart"] {
  return ["autostart"] as const;
}

function parseAutostartState(state: string): AutostartState {
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

// Outside Tauri (standalone Vite) there is no registry to read — "unsupported"
// renders no section at all, matching Linux (where T6 ruled autostart out).
async function readAutostart(): Promise<AutostartState> {
  if (!insideTauri()) return "unsupported";
  return parseAutostartState(await invoke<string>("autostart_status"));
}

export function useAutostart(): UseQueryResult<AutostartState> {
  return useQuery({
    queryKey: autostartQueryKey(),
    queryFn: () => readAutostart(),
    // A SLOW POLL, not a focus refetch — the hub's measured ADR-0051 finding:
    // TanStack's focusManager keys on `document.visibilityState`, which in a
    // Tauri WebView2 never leaves "visible" (map #168 charter decision 11), so
    // a focus-driven query would report the state as of mount and never move.
    // The entry changes from outside this app too (Task Manager's Startup
    // tab), and 60s of staleness suits a next-boot concern.
    // `refetchIntervalInBackground` keeps the poll alive while the window
    // sits hidden in the tray, whichever value `isFocused()` takes there.
    refetchInterval: 60_000,
    refetchIntervalInBackground: true,
  });
}

// The toggle's writer: `set_autostart` registers (with the `--hidden` launch
// arg, Rust-side plugin config) or removes the entry, and returns the fresh
// post-write state — seeded into the cache so the row settles without waiting
// out the poll. Errors surface as a toast (the useUpdateSettings posture): the
// row snaps back on its own since nothing optimistic was written.
export function useSetAutostart(): UseMutationResult<AutostartState, Error, boolean> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (enable: boolean) =>
      parseAutostartState(await invoke<string>("set_autostart", { enable })),
    onSuccess: (state) => {
      qc.setQueryData(autostartQueryKey(), state);
    },
    onError: (e, enable) => {
      logClientEvent(`autostart ${enable ? "enable" : "disable"} failed: ${String(e)}`);
      showToast("Couldn't change start at login");
    },
  });
}
