// The toast imperative (T7) — module-level so any surface can land a
// confirmation on the glass pill without context plumbing. The pill itself is
// components/toast.tsx's ToastHost, which registers the live emitter on
// mount; a call with no host mounted is a silent no-op (boot, tests). A
// message-only subset of apps/desktop/src/lib/toast.ts, which also takes an
// action (#312's Undo) the hub has no use for.

type Emit = (message: string) => void;

let emit: Emit | null = null;

export function showToast(message: string): void {
  emit?.(message);
}

// ToastHost's registration hook — not for general use.
export function registerToastEmitter(fn: Emit | null): void {
  emit = fn;
}
