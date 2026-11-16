// Relative imports only, not `@/`, so the v0.9.2 upgrade rig
// (scripts/acceptance) can import Settings' view models that use it
// (accounts-view.ts) under the scripts' own tsconfig.
import type { OrganizationEntry } from "@maxprice/shared";

// An untracked Organization first recorded after the previous Settings visit:
// the `New` pill of Settings › Accounts' Membership rows and of Connect's
// result step. No recorded visit, or no first-seen time, marks nothing
// new.
export function isNewOrganization(
  entry: Pick<OrganizationEntry, "tracked" | "firstSeenAt">,
  lastOpenedAt: string | null,
): boolean {
  return (
    !entry.tracked &&
    lastOpenedAt !== null &&
    entry.firstSeenAt !== null &&
    Date.parse(entry.firstSeenAt) > Date.parse(lastOpenedAt)
  );
}
