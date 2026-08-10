import { createContext, useContext } from "react";

// The frame's boot phase (ADR-0066). Since the frame is MOUNTED throughout the
// hold — beneath the opaque splash, so Live's queries run during it rather than
// after — one consumer has to know which side of the reveal it is on: `Layout`
// stamps the phase on `.boot-frame` (CSS hides the held frame and fires the
// rise AT the reveal) and withholds the surfaces that must not paint or
// self-dismiss unseen.
//
// Lives here rather than beside `BootGate` so the component file exports only
// components (react-refresh).
export type BootPhase = "hold" | "reveal";

// Defaults to "reveal" so anything rendered outside a BootGate behaves normally.
export const BootPhaseContext = createContext<BootPhase>("reveal");

export function useBootPhase(): BootPhase {
  return useContext(BootPhaseContext);
}
