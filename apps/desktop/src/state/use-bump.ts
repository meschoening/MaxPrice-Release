import { useEffect, useRef, useState } from "react";

// Tile value bump (INTERACTIONS.md): when the rendered value changes, the
// number scales 1 → 1.035 → 1 over 350ms, origin left — the caller adds the
// `bump` class while this returns true. The initial mount never bumps; only
// a real value change does. Reduced motion is handled in CSS (the global
// animation kill in @maxprice/glass), so the class is inert there.
export function useBump(value: string): boolean {
  const prevRef = useRef<string | undefined>(undefined);
  const [bumping, setBumping] = useState(false);
  useEffect(() => {
    const prev = prevRef.current;
    prevRef.current = value;
    if (prev === undefined || prev === value) return;
    setBumping(true);
    const t = setTimeout(() => setBumping(false), 350);
    return () => clearTimeout(t);
  }, [value]);
  return bumping;
}
