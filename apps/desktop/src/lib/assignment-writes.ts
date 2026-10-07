import type { SessionRow } from "@maxprice/shared";
import { undoPlan, type ChooserOption, type UndoGroup } from "@/lib/session-assignment";
import type { ToastOptions } from "@/lib/toast";

// The writes behind the Sessions page's `Assign to…` and `Clear assignment`
// (#312): what each one PUTs, how it is undone, and the order its effects run
// in. No React — the page hands in the PUT, the query invalidation, the toast
// and its own state setters, so the sequencing is testable with plain mocks.
//
// Every write reads its Undo from the rows BEFORE it (#312 ruling 6), and only
// a successful write offers one: a refusal or a network failure keeps the
// selection and toasts the error alone (Review Focus 3).

export function countSessions(n: number): string {
  return `${n} session${n === 1 ? "" : "s"}`;
}

// What picking an Organization in the chooser does. The checked one — the
// selection's `sharedTarget`, which every selected session is already
// assigned to — does nothing: its PUT would change nothing, and clearing the
// selection and offering an Undo would report a write that never happened. A
// tracked one is written at once, with Undo; an Excluded one asks first,
// because the usage then leaves every report on this machine. Home for a
// presumed selection is never checked (sharedTarget is null), so picking it
// writes: that pins the sessions there.
export function assignmentAction(
  option: Pick<ChooserOption, "uuid" | "tracked">,
  sharedTarget: string | null,
): "none" | "write" | "confirm" {
  if (option.uuid === sharedTarget) return "none";
  return option.tracked ? "write" : "confirm";
}

export interface AssertionWrite {
  sessionIds: string[];
  // The claim written: an Organization's uuid, or null to clear.
  organizationUuid: string | null;
  // The PUTs that put every written session back (undoPlan).
  undo: UndoGroup[];
  // The success toast, which carries the Undo.
  message: string;
  // What a failure's toast says before the error.
  failure: string;
}

// Assign every selected session's owner-less usage to `option`.
export function assignWrite(
  rows: readonly SessionRow[],
  option: Pick<ChooserOption, "uuid" | "label">,
): AssertionWrite {
  return {
    sessionIds: rows.map((row) => row.sessionId),
    organizationUuid: option.uuid,
    undo: undoPlan(rows),
    message: `Assigned ${countSessions(rows.length)} to ${option.label}`,
    failure: "Couldn't assign sessions",
  };
}

// Clear the claims of the selected sessions that hold one — presumed sessions
// hold none, so they are not written. Empty when nothing selected is assigned.
// The toast counts assignments and names no Organization: a cleared session
// is presumed under its producer's published Home, which for a peer's session
// is not this machine's.
export function clearWrite(rows: readonly SessionRow[]): AssertionWrite {
  const cleared = rows.filter((row) => row.organizationResolution === "assigned");
  const n = cleared.length;
  return {
    sessionIds: cleared.map((row) => row.sessionId),
    organizationUuid: null,
    undo: undoPlan(cleared),
    message: `Cleared ${n} assignment${n === 1 ? "" : "s"}`,
    failure: "Couldn't clear assignments",
  };
}

export interface AssertionUndoDeps {
  // putOrganizationAssertions: rejects with the envelope's error on a refusal.
  put: (sessionIds: string[], organizationUuid: string | null) => Promise<unknown>;
  // Invalidates the assertions query. The reports refresh without it, through
  // the usage:new round the sidecar ends every changed claim with.
  invalidate: () => void;
  toast: (message: string, options?: ToastOptions) => void;
}

export interface AssertionWriteDeps extends AssertionUndoDeps {
  // Holds the bar's Assign and Clear disabled while the PUT is in flight.
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
      await deps.put(write.sessionIds, write.organizationUuid);
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
  // picked Organization.
  confirm: (write: AssertionWrite, label: string) => void;
}

// A pick in the `Assign to…` chooser, as the page runs it (assignmentAction):
// the checked target runs nothing, so the selection stays and no toast
// appears; an Excluded one opens the confirm; any other writes at once.
export function runAssignPick(
  option: Pick<ChooserOption, "uuid" | "label" | "tracked">,
  rows: readonly SessionRow[],
  sharedTarget: string | null,
  deps: AssignPickDeps,
): void {
  const action = assignmentAction(option, sharedTarget);
  if (action === "none") return;
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
    for (const group of plan) await deps.put(group.sessionIds, group.organizationUuid);
  } catch (error) {
    deps.invalidate();
    deps.toast(`Couldn't undo: ${errorText(error)}`);
    return false;
  }
  deps.invalidate();
  deps.toast(`Restored ${countSessions(count)}`);
  return true;
}
