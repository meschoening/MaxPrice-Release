import { useRef } from "react";
import { countSessions } from "@/lib/assignment-writes";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import {
  CloseX,
  useDialogFocus,
  usePendingConfirm,
} from "@/components/settings/organization-tracking-dialog";

// The Sessions page's one confirmation (#312): assigning sessions to an
// Excluded Organization, whose usage then leaves every report on this machine.
// A tracked target writes at once with Undo; this one asks first. The plain
// gate recipe, as the Organizations list's Track confirm (TrackConfirm): every
// dismiss locks while the write is pending, a failed write keeps the dialog
// open over an error line (the page has already toasted the error), and a
// write that lands closes it.

export interface AssignExcludedConfirmContentProps {
  count: number;
  label: string;
  pending: boolean;
  failed: boolean;
  // The confirm button, which takes focus as the dialog opens.
  confirmRef?: React.Ref<HTMLButtonElement>;
  onCancel: () => void;
  onConfirm: () => void;
}

// The dialog's inside, pure; it needs a Dialog root around it for its title and
// description, and no portal.
export function AssignExcludedConfirmContent({
  count,
  label,
  pending,
  failed,
  confirmRef,
  onCancel,
  onConfirm,
}: AssignExcludedConfirmContentProps): React.ReactElement {
  return (
    <>
      {pending ? null : <CloseX />}
      <DialogTitle asChild>
        <h3>{`Assign ${countSessions(count)} to ${label}?`}</h3>
      </DialogTitle>
      <DialogDescription className="gate-desc">
        {`${label} is excluded on this machine, so this usage leaves every report here. Nothing is deleted: it stays in this machine's archive, and machines that track ${label} still count it. To bring it back, open ${label} in Settings and choose Return them.`}
      </DialogDescription>
      {failed ? <p className="err">Couldn&apos;t assign sessions.</p> : null}
      <div className="btns">
        <button type="button" className="chip" disabled={pending} onClick={onCancel}>
          Cancel
        </button>
        <button
          ref={confirmRef}
          type="button"
          className="chip active"
          disabled={pending}
          onClick={onConfirm}
        >
          {pending ? "Assigning…" : `Assign to ${label}`}
        </button>
      </div>
    </>
  );
}

// `onConfirm` performs the write and rejects when it fails.
export function AssignExcludedConfirm({
  count,
  label,
  onConfirm,
  onClose,
}: {
  count: number;
  label: string;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}): React.ReactElement {
  const { pending, failed, confirm } = usePendingConfirm(onConfirm, onClose);
  const confirmButton = useRef<HTMLButtonElement>(null);
  const focus = useDialogFocus(confirmButton);
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
        <AssignExcludedConfirmContent
          count={count}
          label={label}
          pending={pending}
          failed={failed}
          confirmRef={confirmButton}
          onCancel={onClose}
          onConfirm={confirm}
        />
      </DialogContent>
    </Dialog>
  );
}
