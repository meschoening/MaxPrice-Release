import { byCodeUnit, type OrganizationAssertionsResponse, type SessionRow } from "@maxprice/shared";
import { undoPlan, type ChooserOption, type UndoGroup } from "@/lib/session-assignment";
import type { ToastOptions } from "@/lib/toast";

// The writes behind Settings › Unattributed usage's `Assign to…` (#312, #639)
// and Settings › Accounts' Unassign (#672): what each one PUTs, how it is undone, and the order its effects run in. No React — the page hands in the PUT, the query invalidation, the toast
// and its own state setters, so the sequencing is testable with plain mocks.
//
// Every write reads its Undo from the rows BEFORE it (#312 ruling 6), and only
// a successful write offers one: a refusal or a network failure keeps the
// selection and toasts the error alone (Review Focus 3).

export function countSessions(n: number): string {
  return `${n} session${n === 1 ? "" : "s"}`;
}

// What picking a Membership in the chooser does: one in a tracked Organization
// is written at once, with Undo; one in an Excluded Organization asks first,
// because the usage then leaves every report on this machine. The list holds
// presumed sessions only, which hold no claim, so no pick is a no-op.
export function assignmentAction(option: Pick<ChooserOption, "tracked">): "write" | "confirm" {
  return option.tracked ? "write" : "confirm";
}

export interface AssertionWrite {
  sessionIds: string[];
  // The claim written: an Organization's uuid, or null to clear.
  organizationUuid: string | null;
  // The claim's Account (ADR-0137 §5's Membership assertion), beside an
  // Organization only; absent for an Organization-only claim or a clear.
  accountUuid?: string;
  // The PUTs that put every written session back (undoPlan).
  undo: UndoGroup[];
  // The success toast, which carries the Undo.
  message: string;
  // What a failure's toast says before the error.
  failure: string;
}

// Assign every selected session's owner-less usage to the Membership `option`
// names: a Membership assertion, its Organization and its Account.
export function assignWrite(
  rows: readonly SessionRow[],
  option: Pick<ChooserOption, "organizationUuid" | "accountUuid" | "label">,
): AssertionWrite {
  return {
    sessionIds: rows.map((row) => row.sessionId),
    organizationUuid: option.organizationUuid,
    accountUuid: option.accountUuid,
    undo: undoPlan(rows),
    message: `Assigned ${countSessions(rows.length)} to ${option.label}`,
    failure: "Couldn't assign sessions",
  };
}

// The sessions assigned to an Organization (`assertions`' claims for it), in
// session-id order.
export function assignedTo(
  assertions: OrganizationAssertionsResponse,
  organizationUuid: string,
): string[] {
  return Object.keys(assertions.assertions)
    .filter((sessionId) => assertions.assertions[sessionId] === organizationUuid)
    .sort(byCodeUnit);
}

// Unassign (#672, answering #639's question 3): clear every claim naming
// `organizationUuid`, through any Account, so each session counts under its
// Presumed membership again and Unattributed usage lists it. Undo puts each
// session's own claim back, its Account included (one PUT per Account, an
// Organization-only claim first). Null when nothing is assigned there.
export function unassignWrite(
  assertions: OrganizationAssertionsResponse,
  organizationUuid: string,
): AssertionWrite | null {
  const sessionIds = assignedTo(assertions, organizationUuid);
  if (sessionIds.length === 0) return null;
  const byAccount = new Map<string | undefined, string[]>();
  for (const sessionId of sessionIds) {
    const account = assertions.accounts[sessionId];
    byAccount.set(account, [...(byAccount.get(account) ?? []), sessionId]);
  }
  const undo = [...byAccount]
    .sort(([a], [b]) => (a === undefined ? -1 : b === undefined ? 1 : byCodeUnit(a, b)))
    .map(
      ([accountUuid, ids]): UndoGroup =>
        accountUuid === undefined
          ? { organizationUuid, sessionIds: ids }
          : { organizationUuid, accountUuid, sessionIds: ids },
    );
  return {
    sessionIds,
    organizationUuid: null,
    undo,
    message: `Unassigned ${countSessions(sessionIds.length)}`,
    failure: "Couldn't unassign sessions",
  };
}

export interface AssertionUndoDeps {
  // putOrganizationAssertions: rejects with the envelope's error on a refusal.
  put: (
    sessionIds: string[],
    organizationUuid: string | null,
    accountUuid?: string,
  ) => Promise<unknown>;
  // Invalidates the assertions query. The reports refresh without it, through
  // the usage:new round the sidecar ends every changed claim with.
  invalidate: () => void;
  toast: (message: string, options?: ToastOptions) => void;
}

export interface AssertionWriteDeps extends AssertionUndoDeps {
  // Holds the bar's Assign disabled while the PUT is in flight.
  setPending: (pending: boolean) => void;
  clearSelection: () => void;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Run one write, pending throughout. Success invalidates, clears the selection
// and toasts the message with Undo; failure toasts `‹failure›: ‹error›` and
// changes nothing else. Resolves whether the PUT landed; never rejects.
export async function runAssertionWrite(
  write: AssertionWrite,
  deps: AssertionWriteDeps,
): Promise<boolean> {
  deps.setPending(true);
  try {
    try {
      await deps.put(write.sessionIds, write.organizationUuid, write.accountUuid);
    } catch (error) {
      deps.toast(`${write.failure}: ${errorText(error)}`);
      return false;
    }
    deps.invalidate();
    deps.clearSelection();
    deps.toast(write.message, {
      action: { label: "Undo", run: () => void undoAssertionWrite(write.undo, deps) },
    });
    return true;
  } finally {
    deps.setPending(false);
  }
}

export interface AssignPickDeps extends AssertionWriteDeps {
  // An Excluded pick: open the confirm over this write, labelled for the
  // picked Membership.
  confirm: (write: AssertionWrite, label: string) => void;
}

// A pick in the `Assign to…` chooser, as the section runs it
// (assignmentAction): one in an Excluded Organization opens the confirm; any
// other writes at once.
export function runAssignPick(
  option: Pick<ChooserOption, "organizationUuid" | "accountUuid" | "label" | "tracked">,
  rows: readonly SessionRow[],
  deps: AssignPickDeps,
): void {
  const action = assignmentAction(option);
  const write = assignWrite(rows, option);
  if (action === "confirm") deps.confirm(write, option.label);
  else void runAssertionWrite(write, deps);
}

// Undo: one PUT per previous claim, in the plan's order and one after another,
// so every session gets back exactly what it held (Review Focus 4). The result
// toasts plainly. A group that fails stops the rest; whatever already landed
// still refreshes.
export async function undoAssertionWrite(
  plan: readonly UndoGroup[],
  deps: AssertionUndoDeps,
): Promise<boolean> {
  const count = plan.reduce((n, group) => n + group.sessionIds.length, 0);
  try {
    for (const group of plan) {
      await deps.put(group.sessionIds, group.organizationUuid, group.accountUuid);
    }
  } catch (error) {
    deps.invalidate();
    deps.toast(`Couldn't undo: ${errorText(error)}`);
    return false;
  }
  deps.invalidate();
  deps.toast(`Restored ${countSessions(count)}`);
  return true;
}
