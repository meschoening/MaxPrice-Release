import { useMemo } from "react";
import {
  lacksWeeklyCadence,
  quotaSurface,
  rosterLimitsAnswer,
  type QuotaSurface,
} from "@/lib/organization-scope-view";
import { useOrganizationLabels, useOrganizations } from "./use-organizations";
import { useOrganizationScope } from "./use-organization-scope";
import { useUsageCurrent } from "./use-usage-current";

// What the quota tiles say about the Quota organization (ADR-0106 §10): its
// label under All organizations, and a note when its limits can't be read, or
// it answers `none` with no weekly cadence (`quotaSurface`). The answer is the
// roster's, the one the scope chip's "no limits" marker reads; the cadence is
// the Quota organization's usage-current entry, the one the tiles display.
//
// Both sources change identity on every usage read (the roster's status
// timestamps move, and every sample replaces the entry), so the memo keys on
// what is read out of them first, a string and a boolean, never on the
// objects: the surface, and its `noLimits`, keep their identity until
// something they show changes.
export function useQuotaSurface(): QuotaSurface {
  const { quotaOrganization, isAll } = useOrganizationScope();
  const labels = useOrganizationLabels();
  const { data } = useOrganizations();
  const { data: usage } = useUsageCurrent(quotaOrganization);
  const answer = rosterLimitsAnswer(data?.organizations, quotaOrganization);
  const noWeeklyCadence = lacksWeeklyCadence(usage);
  return useMemo(
    () => quotaSurface({ isAll, quotaOrganization, labels, answer, noWeeklyCadence }),
    [isAll, quotaOrganization, labels, answer, noWeeklyCadence],
  );
}
