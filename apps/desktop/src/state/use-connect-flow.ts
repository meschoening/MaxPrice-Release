import { create } from "zustand";
import type { ConnectResult, ConnectTarget } from "@/lib/connect-flow";

// Settings › Accounts' one open Connect flow (#621's "The Connect flow",
// #639): which target it opened on (an Account's card, "+ Add account", the
// legacy strip), whether its run is out, the paste step's error and the result
// step. They live here rather than in the card: Connect tracks the Account,
// which moves its card from Not tracked to the tracked cards (and ranks it),
// so the flow remounts mid-run, and the result step must survive that (the
// #621 prototype's store, Sol #621 S2). One flow at a time: opening another
// drops this one, and a run that settles after its flow closed or moved
// writes nothing. Leaving Settings keeps nothing either: the page closes the
// flow as it unmounts.

export type ConnectSuccess = Extract<ConnectResult, { ok: true }>;

export interface ConnectFlowState {
  target: ConnectTarget | null;
  busy: boolean;
  error: string | null;
  result: ConnectSuccess | null;
  open: (target: ConnectTarget) => void;
  close: () => void;
}

export const useConnectFlow = create<ConnectFlowState>((set) => ({
  target: null,
  busy: false,
  error: null,
  result: null,
  open: (target) => set({ target, busy: false, error: null, result: null }),
  close: () => set({ target: null, busy: false, error: null, result: null }),
}));

// A target as one string, for matching the open flow and for React keys.
export function connectTargetKey(target: ConnectTarget): string {
  return target.kind === "account" ? `account:${target.accountKey}` : target.kind;
}

function isOpen(target: ConnectTarget): boolean {
  const open = useConnectFlow.getState().target;
  return open !== null && connectTargetKey(open) === connectTargetKey(target);
}

// Run Connect for the flow open on `target` (`runConnect`, bound by the
// caller): busy while it is out, then its result step or the paste step's
// error; a throw (a keychain write, the push) reads as the error.
export async function submitConnect(
  target: ConnectTarget,
  run: () => Promise<ConnectResult>,
): Promise<void> {
  if (!isOpen(target)) return;
  useConnectFlow.setState({ busy: true, error: null });
  let outcome: ConnectResult;
  try {
    outcome = await run();
  } catch (e) {
    outcome = { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  if (!isOpen(target)) return;
  // A Pending account connected with its own key folds into the key's
  // Account, and its card goes with it: the result moves to that Account's
  // card, so its Organization switches stay on screen (no mismatch means the
  // key is the target's own).
  const moved =
    outcome.ok &&
    outcome.mismatch === null &&
    target.kind === "account" &&
    target.accountKey !== outcome.accountUuid
      ? ({ kind: "account", accountKey: outcome.accountUuid } as const)
      : null;
  useConnectFlow.setState(
    outcome.ok
      ? { busy: false, error: null, result: outcome, ...(moved === null ? {} : { target: moved }) }
      : { busy: false, error: outcome.error, result: null },
  );
}
