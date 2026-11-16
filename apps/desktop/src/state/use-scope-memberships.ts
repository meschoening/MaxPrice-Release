import { useMemo } from "react";
import type { AccountEntry, TrackedMembership } from "@maxprice/shared";
import { liveScopeMemberships, type SplitRule } from "@/lib/money-split";
import { useAccounts } from "./use-organizations";
import { useScope } from "./use-scope";
import { useSettings } from "./use-settings";

export type ScopeMemberships = {
  // The known Memberships Live splits by and cards (`liveScopeMemberships`):
  // tracked Memberships of tracked Accounts the Scope holds, Home's first,
  // while the Account filter shows; none on a one-Account install. The
  // default Scope's is the Home membership alone (its Unknown usage is no
  // Membership of its own here), so it counts one.
  memberships: TrackedMembership[];
  // How the money tiles split (#637 D6).
  rule: SplitRule;
  // `/api/accounts`' list, undefined until it answers.
  accounts: readonly AccountEntry[] | undefined;
};

// The Scope's Memberships for the split money tiles and Live's limit area
// (#637). Empty, with no split, until `/api/accounts` and settings answer, so
// a surface keeps its one-Membership form while they load, and always with
// fewer than two tracked Accounts.
export function useScopeMemberships(): ScopeMemberships {
  const { data: settings } = useSettings();
  const { data } = useAccounts();
  const { selection } = useScope();
  const accounts = data?.accounts;
  return useMemo(
    () => ({ ...liveScopeMemberships(accounts, settings, selection), accounts }),
    [settings, accounts, selection],
  );
}
