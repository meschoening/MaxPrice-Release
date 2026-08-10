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
export function useEscapeToDeselect(onDeselect: () => void): void {
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      if (isEditableTarget(e.target)) return;
      onDeselect();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onDeselect]);
}
