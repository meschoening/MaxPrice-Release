import { useState } from "react";
import { checkLabel, LABEL_MAX } from "@maxprice/shared";

// The rename inset the Accounts card opens on a Membership line's
// Organization (#294, #614 §3) and on an Account (#614 §2): one recipe, the
// Machines card's. Labels go through the Label directory, so every machine
// sees them; an Organization that two Accounts reach is one entry, so its
// rename shows under both.

// What the inset needs of the rename mutation. `submit`'s `done` runs on
// success only, so a refusal keeps the inset open with the Hub's words.
export type LabelRename = {
  pending: boolean;
  error: string | null;
  submit: (uuid: string, label: string | null, done: () => void) => void;
  reset: () => void;
};

// The rename inset. The draft starts at the bare label: the collision suffix is
// render-time, never a rename. Save waits for a label the rename rules accept;
// their limit counts code points, so it is checked here rather than with
// maxLength (UTF-16 units). "Use default" clears a rename back to the plan word
// or short id.
export function LabelRenameFlow({
  uuid,
  label,
  renamed,
  noun,
  rename,
  onClose,
}: {
  uuid: string;
  // The bare label the draft starts at, and whether it is a rename.
  label: string;
  renamed: boolean;
  // What is renamed, for the input's name: "organization" or "account".
  noun: string;
  rename: LabelRename;
  onClose: () => void;
}): React.ReactElement {
  const [draft, setDraft] = useState(label);
  const check = checkLabel(draft);
  return (
    <div className="flow mflow">
      <div className="btns">
        <input
          className="input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          aria-label={`${noun} label`}
          style={{ flex: 1 }}
        />
        <button
          type="button"
          className="chip active"
          disabled={rename.pending || !check.ok}
          onClick={() => {
            if (check.ok) rename.submit(uuid, check.label, onClose);
          }}
        >
          {rename.pending ? "Saving…" : "Save"}
        </button>
        {renamed ? (
          <button
            type="button"
            className="chip"
            disabled={rename.pending}
            onClick={() => rename.submit(uuid, null, onClose)}
          >
            Use default
          </button>
        ) : null}
        <button type="button" className="chip ghost-btn" onClick={onClose}>
          Cancel
        </button>
      </div>
      {!check.ok && check.reason === "too-long" ? (
        <p className="err">{`Use ${LABEL_MAX} characters or fewer.`}</p>
      ) : null}
      {rename.error !== null ? <p className="err">{rename.error}</p> : null}
    </div>
  );
}
