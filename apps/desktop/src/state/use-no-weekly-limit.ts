import {
  noWeeklyLimit,
  rosterLimitsAnswer,
  rosterWindowState,
} from "@/lib/organization-scope-view";
import { useOrganizations } from "./use-organizations";
import { useScope } from "./use-scope";

// Whether the Quota organization has no weekly limit to read (`noWeeklyLimit`,
// ADR-0106 §10): the This week tile's fallback line. Both facts are the
// roster's, the Limits answer and the weekly Window state of the last
// successful poll (#384), read out as strings so the answer keeps its value
// across the roster's per-read churn.
export function useNoWeeklyLimit(): boolean {
  const { quotaOrganization } = useScope();
  const { data } = useOrganizations();
  const roster = data?.organizations;
  return noWeeklyLimit({
    quotaOrganization,
    answer: rosterLimitsAnswer(roster, quotaOrganization),
    weekly: rosterWindowState(roster, quotaOrganization, "weekly"),
  });
}
