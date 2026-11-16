import { useId, useRef, useState } from "react";
import { HOME_BADGE, type AccountCardView, type Tone } from "@/lib/accounts-view";
import { refusalSentence, renameSubmission } from "@/lib/tracking-confirm";
import { cn } from "@/lib/utils";

// Settings › Accounts' small parts (#621, #639): the Track switch, the avatar,
// the Home badge, a connection state and the in-place label editor.

// A Track switch: the glass `.toggle` with no visible label, named for what it
// tracks. One that cannot act stays rendered, dimmed, with its reason as its
// title (the Home membership's lock, or no Home yet).
export function TrackSwitch({
  on,
  canToggle,
  title,
  label,
  onToggle,
}: {
  on: boolean;
  canToggle: boolean;
  title: string;
  // The accessible name: "Track ‹name›".
  label: string;
  onToggle: () => void;
}): React.ReactElement {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-disabled={canToggle ? undefined : true}
      aria-label={label}
      title={title}
      className={cn("toggle", !canToggle && "cursor-not-allowed")}
      onClick={canToggle ? onToggle : undefined}
    >
      <span className="track" aria-hidden />
    </button>
  );
}

// The Account menu's avatar recipe at card scale: the mark's letter, or a
// Pending account's dashed "@".
export function AccountAvatar({
  avatar,
  compact,
}: {
  avatar: AccountCardView["avatar"];
  compact?: boolean;
}): React.ReactElement {
  return (
    <span
      className={cn("acct-av", avatar.dashed && "pending", compact && "compact")}
      aria-hidden
      title={avatar.dashed ? "Pending account: known by email only" : undefined}
    >
      {avatar.letter}
    </span>
  );
}

export function HomeBadge(): React.ReactElement {
  return (
    <span className="acct-home" title={HOME_BADGE.title}>
      {HOME_BADGE.text}
    </span>
  );
}

export function Pill({
  tone,
  title,
  children,
}: {
  tone: "new" | "warn" | "soft";
  title?: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <span className={cn("acct-pill", tone)} title={title}>
      {children}
    </span>
  );
}

// A connection state: the Glass dot and its words in the tone's ink.
export function ConnectionState({ text, tone }: { text: string; tone: Tone }): React.ReactElement {
  return (
    <span className={cn("acct-conn", tone)}>
      <span className={cn("dot", tone)} aria-hidden />
      {text}
    </span>
  );
}

// Copy that names the cookie: each `sessionKey` in it is code-styled.
export function SessionKeyText({ text }: { text: string }): React.ReactElement {
  const parts = text.split("sessionKey");
  return (
    <>
      {parts.map((part, i) => (
        <span key={i}>
          {i > 0 ? <code>sessionKey</code> : null}
          {part}
        </span>
      ))}
    </>
  );
}

// The in-place label editor: an Organization's rename (ADR-0105) or an
// Account label (ADR-0136 §7), whose submissions follow one rule
// (`renameSubmission`). `current` is the user's label, null when there is
// none; the field then starts empty with the fallback as its placeholder, and
// saving it empty clears a label. Enter saves and Escape cancels; leaving the
// field saves too, unless a key already settled this draft or its refusal is
// still showing. Editing the draft clears the refusal. `onSave` resolves null
// once saved, else the sidecar's refusal, shown under the input. Residuals,
// as the Organizations list's editor had them: a refusal to a blur-save made
// by opening another editor is never shown, and a draft typed while a save is
// in flight is dropped when that save closes the field.
export function LabelField({
  current,
  placeholder,
  ariaLabel,
  onSave,
  onDone,
}: {
  current: string | null;
  placeholder: string;
  ariaLabel: string;
  onSave: (label: string | null) => Promise<string | null>;
  onDone: (returnFocus: boolean) => void;
}): React.ReactElement {
  const [draft, setDraft] = useState(current ?? "");
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const settled = useRef(false);
  const saving = useRef(false);
  const errorId = useId();

  function close(): void {
    onDone(document.activeElement === input.current);
  }

  async function save(): Promise<void> {
    if (saving.current) return;
    const submission = renameSubmission(draft, {
      bareLabel: current ?? "",
      renamed: current !== null,
    });
    if (submission.kind === "noop") return close();
    if (submission.kind === "invalid") return setError(submission.error);
    saving.current = true;
    const refusal = await onSave(submission.label);
    saving.current = false;
    if (refusal === null) close();
    else setError(refusalSentence(refusal));
  }

  return (
    <span className="acct-rename">
      <input
        ref={input}
        className="input"
        aria-label={ariaLabel}
        aria-invalid={error !== null ? true : undefined}
        aria-describedby={error !== null ? errorId : undefined}
        // Opened from the label it replaces, so focus moves with it.
        autoFocus
        placeholder={placeholder}
        value={draft}
        onChange={(e) => {
          settled.current = false;
          setError(null);
          setDraft(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            settled.current = true;
            void save();
          } else if (e.key === "Escape") {
            e.preventDefault();
            settled.current = true;
            onDone(true);
          }
        }}
        onBlur={() => {
          if (settled.current || error !== null) return;
          settled.current = true;
          void save();
        }}
      />
      {error !== null ? (
        <span id={errorId} className="err">
          {error}
        </span>
      ) : null}
    </span>
  );
}
