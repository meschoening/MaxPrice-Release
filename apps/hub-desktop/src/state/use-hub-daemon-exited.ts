import { useQuery } from "@tanstack/react-query";
import { hubDaemonExited } from "@/lib/tauri";

// Has the daemon exited, as the shell records it (ADR-0112 §6)? Asked only
// while the status query is failing, which is what it explains, and fed raw to
// `hubDaemonState`: that alone decides whether the failure is a stop.
//
// The shell records the exit a beat after the socket drops, so a probe that
// lands first reads a live daemon; it asks again each second until the shell
// confirms, and stops there, since nothing undoes an exit short of a relaunch.
// In the background too, for the reason `useHubStatus` polls there: both hub
// windows are normally hidden, and the hidden popout writes the tray tooltip.
// Each ask is one in-process IPC call, never a fetch.
export const EXIT_PROBE_MS = 1_000;

export function hubDaemonExitedQueryKey(): readonly ["hub-daemon-exited"] {
  return ["hub-daemon-exited"] as const;
}

// The probe's interval, pure for its test.
export function exitProbeInterval(exited: boolean | undefined): number | false {
  return exited === true ? false : EXIT_PROBE_MS;
}

export function useHubDaemonExited(isError: boolean): boolean {
  const { data } = useQuery({
    queryKey: hubDaemonExitedQueryKey(),
    queryFn: () => hubDaemonExited(),
    enabled: isError,
    refetchInterval: (query) => exitProbeInterval(query.state.data),
    refetchIntervalInBackground: true,
    retry: false,
  });
  return data === true;
}
