// The toast imperative (T7) — module-level so any surface can land a
// confirmation on the glass pill without context plumbing. The pill itself is
// components/toast.tsx's ToastHost, which registers the live emitter on
// mount; a call with no host mounted is a silent no-op (boot, tests).
//
// A toast may carry ONE action (#312's Undo): the pill then shows the message
// followed by the action's button, dwells ACTION_DWELL_MS instead of DWELL_MS,
// and a click runs the action and hides the pill at once. One toast at a time
// still holds — a newer toast replaces an older one, action and all, so an
// action is only reachable while its own toast is the one showing.

export interface ToastAction {
  label: string;
  run: () => void;
}

export interface ToastOptions {
  action?: ToastAction;
}

export const DWELL_MS = 2200; // the Glass notes said ~1.9s; 2.2s shipped and is the contract (ADR-0088)
export const ACTION_DWELL_MS = 8000; // time to read the message and reach the button (#312)

export function toastDwellMs(options?: ToastOptions): number {
  return options?.action === undefined ? DWELL_MS : ACTION_DWELL_MS;
}

// What the pill shows. A dismissed toast keeps its message and action, so the
// 250ms fade-out runs on unchanged content rather than a pill that jumps.
export interface ToastState {
  message: string;
  action: ToastAction | null;
  show: boolean;
}

export const NO_TOAST: ToastState = { message: "", action: null, show: false };

export function presentToast(message: string, options?: ToastOptions): ToastState {
  return { message, action: options?.action ?? null, show: true };
}

export function dismissToast(toast: ToastState): ToastState {
  return toast.show ? { ...toast, show: false } : toast;
}

// The action button's click: dismisses, then runs the action — but only while
// the toast is showing, so an action runs at most once and never after its
// toast has timed out. `commit` receives the dismissed toast BEFORE the action
// runs, and must stop the dwell timer as well as store it: an action may show
// a toast of its own (an Undo confirming itself), which has to land on top of
// the dismissal, not under it — and an action that throws leaves the pill
// already hidden. An event-handler call, never a state updater (it has a side
// effect, and React may invoke updaters twice).
export function runToastAction(toast: ToastState, commit: (dismissed: ToastState) => void): void {
  if (!toast.show || toast.action === null) return;
  commit(dismissToast(toast));
  toast.action.run();
}

type Emit = (message: string, options?: ToastOptions) => void;

let emit: Emit | null = null;

export function showToast(message: string, options?: ToastOptions): void {
  emit?.(message, options);
}

// ToastHost's registration hook — not for general use.
export function registerToastEmitter(fn: Emit | null): void {
  emit = fn;
}
