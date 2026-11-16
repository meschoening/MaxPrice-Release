import { useMutation, useQueryClient, type UseMutationResult } from "@tanstack/react-query";
import { hubOrganizationsQueryKey, renameOrganization } from "@/lib/hub-api";

// The operator's Organization rename (#294); `label: null` clears it. Success
// refreshes the Accounts card's lines at once rather than waiting on the
// hub:labels frame. Errors surface via mutation.error in the Hub's words.
export function useRenameOrganization(): UseMutationResult<
  void,
  Error,
  { uuid: string; label: string | null }
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ uuid, label }) => renameOrganization(uuid, label),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: hubOrganizationsQueryKey() });
    },
  });
}
