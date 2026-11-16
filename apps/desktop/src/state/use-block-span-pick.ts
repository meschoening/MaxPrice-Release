import { useMemo } from "react";
import { scopeMembershipReadings } from "@maxprice/shared";
import { blockSpanPick, type BlockSpanPick } from "@/lib/block-span-pick";
import { useFilters } from "./filters";
import { useOrganizationLabels } from "./use-organizations";
import { useScopeMemberships } from "./use-scope-memberships";

// The Live chart's Block span picker (#619 variant 1, #638) over the Scope's
// Memberships (`useScopeMemberships`) and their readings off `/api/accounts`:
// `single` on a one-Account install, or while `/api/accounts` and settings
// load. The viewer's pick lives in the filters store, apart from the Blocks
// page's tab.
export function useBlockSpanPick(nowMs: number): {
  pick: BlockSpanPick;
  setPick: (token: string) => void;
} {
  const { memberships, accounts } = useScopeMemberships();
  const labels = useOrganizationLabels();
  const selectedToken = useFilters((s) => s.blockSpanMembership);
  const setPick = useFilters((s) => s.setBlockSpanMembership);
  const readings = useMemo(
    () => scopeMembershipReadings(memberships, accounts ?? [], labels),
    [memberships, accounts, labels],
  );
  const pick = useMemo(
    () => blockSpanPick({ memberships: readings, selectedToken, nowMs }),
    [readings, selectedToken, nowMs],
  );
  return { pick, setPick };
}
