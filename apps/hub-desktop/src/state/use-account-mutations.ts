import { useMutation, useQueryClient, type UseMutationResult } from "@tanstack/react-query";
import { hubLabelDirectoryQueryKey, renameAccount } from "@/lib/hub-api";

// The operator's Account rename through the Label directory (#614 §2); the
// card re-reads the directory for the new label.
export function useRenameAccount(): UseMutationResult<
  void,
  Error,
  { uuid: string; label: string | null }
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ uuid, label }) => renameAccount(uuid, label),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: hubLabelDirectoryQueryKey() });
    },
  });
}
