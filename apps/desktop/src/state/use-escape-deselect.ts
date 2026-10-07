import { useEffect } from "react";
import { isEditableTarget } from "@/lib/dom";

// Esc clears the list views' row selection, returning the detail strip to its
// filter-totals state (ADR-0016). Lives beside use-now-tick in state/ — the
// react-refresh lint rule keeps non-component exports out of component files.
//
// Esc presses inside text-editing fields are ignored via the shared
// isEditableTarget guard (input / textarea / contentEditable — same rationale
// as the ⇧R hotkey): clearing the table's search box (a native
// <input type="search"> Esc behavior) must not also clear the selection.

export interface EscapeToDeselectOptions {
  // Also ignore an Esc that an open layer already handled. A Radix popover,
  // menu or dialog calls preventDefault on the Esc that closes it, in a
  // document capture listener that runs before this window one, so closing
  // it leaves the selection alone. Read off the event rather than off the
  // layer's open state: React can commit the close before the event reaches
  // the window. The Sessions page's owner-less review opts in (#312); the
  // tables keep their shipped behaviour.
  skipHandled?: boolean;
}

// Whether a keydown clears the selection. Pure, so the guards are testable
// without a window.
export function isDeselectEscape(
  e: Pick<KeyboardEvent, "key" | "target" | "defaultPrevented">,
  { skipHandled = false }: EscapeToDeselectOptions = {},
): boolean {
  if (e.key !== "Escape") return false;
  if (isEditableTarget(e.target)) return false;
  if (skipHandled && e.defaultPrevented) return false;
  return true;
}

export function useEscapeToDeselect(
  onDeselect: () => void,
  { skipHandled = false }: EscapeToDeselectOptions = {},
): void {
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (isDeselectEscape(e, { skipHandled })) onDeselect();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onDeselect, skipHandled]);
}
