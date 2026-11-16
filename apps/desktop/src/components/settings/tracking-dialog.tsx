import { useId, useRef, useState } from "react";
import { XIcon } from "lucide-react";
import { excludeCopy, excludeTitle, isExcludeArmed } from "@maxprice/shared";
import { trackCopy, trackTitle, type TrackingFacts } from "@/lib/tracking-confirm";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";

// Settings › Accounts' tracking confirmations (ADR-0098, ADR-0136 §3; #639):
// tracking an Organization is the update gate's plain recipe
// (components/UpdateGate.tsx); excluding an Organization or an Account is the
// typed recipe of Storage's Forget (`ForgetConfirm`), since excluding either
// removes this machine's history for it from the Local archive and the hub (a
// repair, ADR-0136 §3). Tracking an Account asks nothing: it only widens what
// counts, as Connect's own tracking does. Tracking's words come from
// lib/tracking-confirm, and excluding's from packages/shared
// (organization-tracking.ts), which `maxprice org exclude` prints too.
//
// While the write is pending every dismiss locks (Cancel, ×, Esc, scrim). A
// failed write keeps the dialog open over the error line (the settings writer
// has already logged and toasted it); a write that resolves — including one
// with nothing left to write — closes it.

interface ConfirmActions {
  onConfirm: () => Promise<void>;
  onClose: () => void;
}

// The confirm button's write, shared with Unattributed usage's Excluded confirm
// (assign-excluded-confirm.tsx) — hooks beside the dialogs they drive; a file
// of their own would cost more than fast refresh does.
// eslint-disable-next-line react-refresh/only-export-components
export function usePendingConfirm(
  onConfirm: () => Promise<void>,
  onClose: () => void,
): { pending: boolean; failed: boolean; confirm: () => void } {
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const confirm = (): void => {
    if (pending) return;
    setPending(true);
    setFailed(false);
    onConfirm().then(onClose, () => {
      setPending(false);
      setFailed(true);
    });
  };
  return { pending, failed, confirm };
}

// Focus opens on `initial`, not the × Radix would pick first, and closes back
// on whatever held it before: the switch. With no DialogTrigger, Radix's modal
// close focuses nothing.
// eslint-disable-next-line react-refresh/only-export-components
export function useDialogFocus(initial: React.RefObject<HTMLElement | null>): {
  onOpenAutoFocus: (e: Event) => void;
  onCloseAutoFocus: (e: Event) => void;
} {
  const returnTo = useRef<Element | null>(null);
  return {
    onOpenAutoFocus: (e) => {
      returnTo.current = document.activeElement;
      e.preventDefault();
      initial.current?.focus();
    },
    onCloseAutoFocus: (e) => {
      e.preventDefault();
      if (returnTo.current instanceof HTMLElement) returnTo.current.focus();
    },
  };
}

export function CloseX(): React.ReactElement {
  return (
    <DialogClose asChild>
      <button type="button" className="gate-x" aria-label="Close">
        <XIcon aria-hidden />
      </button>
    </DialogClose>
  );
}

// `label`: the Organization as Settings shows it, collision suffix included.
export function TrackConfirm({
  label,
  facts,
  onConfirm,
  onClose,
}: ConfirmActions & { label: string; facts: TrackingFacts }): React.ReactElement {
  const { pending, failed, confirm } = usePendingConfirm(onConfirm, onClose);
  const trackButton = useRef<HTMLButtonElement>(null);
  const focus = useDialogFocus(trackButton);
  const [lead, ...rest] = trackCopy(facts);

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && !pending) onClose();
      }}
    >
      <DialogContent
        className="gate-dialog"
        overlayClassName="gate-scrim"
        showCloseButton={false}
        {...focus}
      >
        {pending ? null : <CloseX />}
        <DialogTitle asChild>
          <h3>{trackTitle(label)}</h3>
        </DialogTitle>
        <DialogDescription className="gate-desc">{lead}</DialogDescription>
        {rest.map((paragraph) => (
          <p key={paragraph} className="gate-desc">
            {paragraph}
          </p>
        ))}
        {failed ? <p className="err">Couldn't save settings.</p> : null}
        <div className="btns">
          <button type="button" className="chip" disabled={pending} onClick={onClose}>
            Cancel
          </button>
          <button
            ref={trackButton}
            type="button"
            className="chip active"
            disabled={pending}
            onClick={confirm}
          >
            {pending ? "Tracking…" : "Track"}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// The typed token is the bare label (`isExcludeArmed`): an Organization's
// unsuffixed label, or an Account's title. `shortId` is its id's first 8, which
// the title names. Focus opens in its field, the one thing to do next, and
// Enter there confirms once it is armed. `hub`: a Hub is configured.
export function ExcludeConfirm({
  bareLabel,
  shortId,
  hub,
  onConfirm,
  onClose,
}: ConfirmActions & { bareLabel: string; shortId: string; hub: boolean }): React.ReactElement {
  const { pending, failed, confirm } = usePendingConfirm(onConfirm, onClose);
  const [typed, setTyped] = useState("");
  const field = useRef<HTMLInputElement>(null);
  const focus = useDialogFocus(field);
  const fieldId = useId();
  const armed = isExcludeArmed(typed, bareLabel);
  const [lead, ...rest] = excludeCopy({ hub });

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && !pending) onClose();
      }}
    >
      <DialogContent
        className="gate-dialog st-confirm"
        overlayClassName="gate-scrim"
        showCloseButton={false}
        {...focus}
      >
        {pending ? null : <CloseX />}
        <DialogTitle asChild>
          <h3>{excludeTitle(bareLabel, shortId)}</h3>
        </DialogTitle>
        <DialogDescription asChild>
          <p>{lead}</p>
        </DialogDescription>
        {rest.map((paragraph) => (
          <p key={paragraph}>{paragraph}</p>
        ))}

        <div className="confirm-field">
          <label htmlFor={fieldId}>
            Type <b>{bareLabel}</b> to confirm.
          </label>
          <input
            ref={field}
            className="input"
            id={fieldId}
            autoComplete="off"
            spellCheck={false}
            disabled={pending}
            placeholder={bareLabel}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && armed) {
                e.preventDefault();
                confirm();
              }
            }}
          />
        </div>

        {failed ? <p className="err">Couldn't save settings.</p> : null}

        <div className="btns">
          <button type="button" className="chip" disabled={pending} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="chip danger"
            disabled={!armed || pending}
            onClick={confirm}
          >
            {pending ? "Excluding…" : "Exclude"}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
