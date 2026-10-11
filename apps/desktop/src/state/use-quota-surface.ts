import { useMemo } from "react";
import {
  quotaSurface,
  rosterLimitsAnswer,
  rosterWindowState,
  type QuotaSurface,
} from "@/lib/organization-scope-view";
import { useOrganizationLabels, useOrganizations } from "./use-organizations";
import { useOrganizationScope } from "./use-organization-scope";

// What the quota tiles say about the Quota organization (ADR-0106 §10): its
// label under All organizations, and per tile a note when its window has no
// limit (an absent Window state) or the limits can't be read (`forbidden`)
// (`quotaSurface`). Both facts are the roster's: the answer the scope chip's
// "no limits" marker reads, and the Window states of the last successful poll
// (#384).
//
// The roster changes identity on every usage read (its status timestamps
// move), so the memo keys on what is read out of it first, three strings,
// never on the objects: the surface, and its notes, keep their identity until
// something they show changes.
export function useQuotaSurface(): QuotaSurface {
  const { quotaOrganization, isAll } = useOrganizationScope();
  const labels = useOrganizationLabels();
  const { data } = useOrganizations();
  const roster = data?.organizations;
  const answer = rosterLimitsAnswer(roster, quotaOrganization);
  const fiveHour = rosterWindowState(roster, quotaOrganization, "fiveHour");
  const weekly = rosterWindowState(roster, quotaOrganization, "weekly");
  return useMemo(
    () => quotaSurface({ isAll, quotaOrganization, labels, answer, fiveHour, weekly }),
    [isAll, quotaOrganization, labels, answer, fiveHour, weekly],
  );
}
