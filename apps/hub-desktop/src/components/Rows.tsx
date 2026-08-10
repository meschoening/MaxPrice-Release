import { cn } from "@/lib/utils";

// The console's `pairs` grammar — a label on the left, its value on the right —
// shared by every card that has one. It lived as a local `Row` inside
// HubStatusCard until the App info card (map #143) needed a second copy; lifted
// here rather than forked, which is the whole reason this file exists.

/**
 * A label/value pair. `title` carries detail the value must not print; `warn`
 * tints a value that states a problem (ADR-0051's "Starts at login: No — not
 * registered"), the quieter register beneath an `inset warn` block.
 */
export function Row(props: {
  label: string;
  value: string;
  title?: string;
  warn?: boolean;
}): React.ReactElement {
  return (
    <div className="krow">
      <span>{props.label}</span>
      <b className={cn(props.warn === true && "warn")} title={props.title}>
        {props.value}
      </b>
    </div>
  );
}

/**
 * A pair whose value cell carries a CONTROL, not just a value.
 *
 * A separate shape rather than a prop on `Row`, because the two differ in the
 * DOM and in their alignment: `.krow` aligns on the baseline, which is right for
 * two runs of text and wrong for a 26px chip (it sits visibly low), so
 * `.krow.control` centres instead and lets the value side wrap rather than
 * ellipse. At the 380px floor a second line is cheap and a truncated update
 * state is not a state.
 */
export function ControlRow(props: {
  label: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="krow control">
      <span>{props.label}</span>
      <span className="val">{props.children}</span>
    </div>
  );
}
