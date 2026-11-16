import { useMemo } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import type { SessionRow, SessionsResponse } from "@maxprice/shared";
import {
  isUnattributed,
  membershipChooserOptions,
  type ChooserOption,
} from "@/lib/session-assignment";
import { unattributedSessionsInput, unattributedShown } from "@/lib/unattributed-usage";
import { useAccounts, useOrganizationLabels } from "./use-organizations";
import { useSessions } from "./use-sessions";
import { useSettings } from "./use-settings";

// Settings › Unattributed usage's reads (#639): its own `/api/sessions`
// query, never the rail's, and the Memberships its `Assign to…` offers.

// `/api/sessions` over `unattributedSessionsInput`, through the sessions
// report's ADR-0004 hook, so the live stream's invalidation of the sessions
// family refreshes it and a write's session leaves the list. Its answer
// decides whether the section shows at all (`unattributedShown`), so it runs
// once settings have answered.
export function useUnattributedSessions(): UseQueryResult<SessionsResponse> {
  const { data: settings } = useSettings();
  return useSessions(
    unattributedSessionsInput({ tz: settings?.timezone, mode: settings?.costMode ?? "auto" }),
    { enabled: settings !== undefined },
  );
}

// The sessions the section lists (`isUnattributed`), undefined until the
// query answers.
export function useUnattributedRows(): {
  query: UseQueryResult<SessionsResponse>;
  rows: SessionRow[] | undefined;
} {
  const query = useUnattributedSessions();
  const rows = useMemo(() => query.data?.sessions.filter(isUnattributed), [query.data]);
  return { query, rows };
}

// The Memberships `Assign to…` offers (`membershipChooserOptions`), undefined
// until settings and `/api/accounts` have answered.
export function useMembershipChooserOptions(): ChooserOption[] | undefined {
  const { data: settings } = useSettings();
  const { data: accounts } = useAccounts();
  const labels = useOrganizationLabels();
  return useMemo(
    () =>
      settings === undefined || accounts === undefined
        ? undefined
        : membershipChooserOptions(accounts.accounts, settings, labels),
    [settings, accounts, labels],
  );
}

// Whether Settings renders Unattributed usage (`unattributedShown`): what the
// section and the ⌘K finder's entry for it both go by.
export function useUnattributedShown(): boolean {
  const { query, rows } = useUnattributedRows();
  return unattributedShown(rows, query.error !== null);
}
