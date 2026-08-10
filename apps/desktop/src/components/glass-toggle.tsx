import { cn } from "@/lib/utils";

// The glass switch (@maxprice/glass .toggle) — label + pill track. Disabled
// switches stay rendered but dimmed with an explanatory tooltip
// (INTERACTIONS.md: the Log scale toggle is disabled, not hidden, when no
// model/token-type axis is selected).
export function GlassToggle({
  label,
  checked,
  onToggle,
  disabled = false,
  title,
}: {
  label: string;
  checked: boolean;
  onToggle: () => void;
  disabled?: boolean;
  title?: string;
}): React.ReactElement {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-disabled={disabled || undefined}
      onClick={disabled ? undefined : onToggle}
      title={title}
      className={cn("toggle", disabled && "cursor-not-allowed")}
    >
      {label}
      <span className="track" aria-hidden />
    </button>
  );
}
