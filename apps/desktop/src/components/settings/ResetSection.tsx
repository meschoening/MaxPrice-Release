import { useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { showToast } from "@/lib/toast";

// ResetSection — the T1 danger chip gated behind a confirmation worn as a
// floating glass leaf (the kebab-leaf recipe: title, description, Cancel /
// danger Reset; Esc + outside click close via the popover host). On confirm,
// the caller writes `DEFAULT_SETTINGS` wholesale — `claudePaths`, `timezone`,
// and `costMode` all revert — and the confirmation lands on the toast (T7).

export function ResetSection({ onReset }: { onReset: () => void }): React.ReactElement {
  const [open, setOpen] = useState(false);

  const confirm = (): void => {
    onReset();
    setOpen(false);
    showToast("Settings reset to defaults");
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger className="chip danger">Reset to defaults</PopoverTrigger>
      <PopoverContent align="start" sideOffset={8} className="leaf">
        <h4>Reset all settings?</h4>
        <p>Claude data paths, timezone, and cost mode revert to their defaults.</p>
        <div className="btns">
          <button type="button" className="chip" onClick={() => setOpen(false)}>
            Cancel
          </button>
          <button type="button" className="chip danger" onClick={confirm}>
            Reset
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
