import { useEffect } from "react";
import { create } from "zustand";
import { isFinderHotkey } from "@/lib/finder";
import { isMacOS } from "@/lib/platform";

// Whether the ⌘K finder is open (#640). A store rather than component state
// because two places open it: the topbar's Find chip and the hotkey.
type FinderState = {
  open: boolean;
  setOpen: (open: boolean) => void;
};

export const useFinder = create<FinderState>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));

const MAC = isMacOS();

// ⌘K (Ctrl+K off macOS) toggles the finder, from anywhere in the main window,
// a text field included (`isFinderHotkey`). Mounted by `<Finder/>`, which only
// the main window's Layout renders, so the popout never answers it. A held
// chord's auto-repeat is ignored, so holding it does not flicker the finder.
export function useFinderHotkey(): void {
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (!isFinderHotkey(e, MAC)) return;
      e.preventDefault();
      if (e.repeat) return;
      const { open, setOpen } = useFinder.getState();
      setOpen(!open);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);
}
