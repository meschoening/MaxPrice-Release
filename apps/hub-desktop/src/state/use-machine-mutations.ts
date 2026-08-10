import { useMutation, useQueryClient, type UseMutationResult } from "@tanstack/react-query";
import {
  compactStore,
  hubMachinesQueryKey,
  hubStatusQueryKey,
  mergeMachine,
  purgeMachine,
  renameMachine,
} from "@/lib/hub-api";

// Operator mutations (M7). Every success refreshes the Machines card AND the
// status card (purge/compact change the archive stats; rename/merge change the
// directory). Errors surface via mutation.error (the pinned envelope message).
function useInvalidating<TVars>(
  fn: (vars: TVars) => Promise<void>,
): UseMutationResult<void, Error, TVars> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: hubMachinesQueryKey() });
      void qc.invalidateQueries({ queryKey: hubStatusQueryKey() });
    },
  });
}
export function useRenameMachine(): UseMutationResult<
  void,
  Error,
  { machineId: string; name: string }
> {
  return useInvalidating(({ machineId, name }) => renameMachine(machineId, name));
}
export function useMergeMachine(): UseMutationResult<
  void,
  Error,
  { machineId: string; into: string }
> {
  return useInvalidating(({ machineId, into }) => mergeMachine(machineId, into));
}
export function usePurgeMachine(): UseMutationResult<void, Error, { machineId: string }> {
  return useInvalidating(({ machineId }) => purgeMachine(machineId));
}
export function useCompactStore(): UseMutationResult<void, Error, void> {
  return useInvalidating(() => compactStore());
}
