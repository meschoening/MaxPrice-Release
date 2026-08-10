import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { insideTauri } from "@/lib/tauri";
import type { FirewallVerdict } from "@/lib/presentation";

// The one-click repair's two outcomes: the rule was registered, or the operator
// declined the UAC prompt (an answer, not an error — ADR-0038).
export type FirewallFixResult = "applied" | "declined";

// Windows-firewall reachability (ADR-0038). The check is a Tauri command (an
// unelevated read of the host firewall), NOT a daemon endpoint — the state is
// host-local and, when blocked, remote clients couldn't fetch it anyway. The
// console is the only consumer (ADR-0036's local-only management).

export function firewallQueryKey(): readonly ["firewall"] {
  return ["firewall"] as const;
}

// Outside Tauri (standalone Vite) there is no host to inspect — report
// unsupported, which the UI treats as silent. An unexpected value throws,
// surfacing as a query error the UI also treats as silent.
async function checkFirewall(): Promise<FirewallVerdict> {
  if (!insideTauri()) return "unsupported";
  const verdict = await invoke<string>("check_firewall");
  if (verdict === "allowed" || verdict === "blocked" || verdict === "unsupported") return verdict;
  throw new Error(`Unexpected firewall verdict: ${verdict}`);
}

export function useFirewallCheck(): UseQueryResult<FirewallVerdict> {
  return useQuery({
    queryKey: firewallQueryKey(),
    queryFn: () => checkFirewall(),
    // Rules change rarely and only from outside the app (or our own fix, which
    // invalidates explicitly) — recheck on window focus, never on a timer.
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
}

// The one-click repair: raises UAC, registers the tailnet-scoped rule.
// Resolves "applied" | "declined" (a declined prompt is an answer, not an
// error). Settled either way ⇒ re-check, so the warning row tracks reality
// rather than our expectation of it.
export function useFirewallFix(): UseMutationResult<FirewallFixResult, Error, void> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (): Promise<FirewallFixResult> => {
      const result = await invoke<string>("fix_firewall");
      if (result === "applied" || result === "declined") return result;
      throw new Error(`Unexpected firewall fix result: ${result}`);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: firewallQueryKey() }),
  });
}
