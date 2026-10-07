import { useEffect, useState } from "react";

// When Settings was last open, for the Organizations list's `New` tag: an
// untracked Organization first seen since then is new. Presentation only, so
// the stamp is this renderer's own localStorage key, never a setting. The
// visit is read once per mount — the previous one — and this one is stamped
// after, so every Organization new at open stays marked until the next visit.
const STORAGE_KEY = "maxprice-settings-last-opened";

// A stored value that is not a time reads as no visit recorded.
export function parseSettingsLastOpened(raw: string | null): string | null {
  if (raw === null) return null;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

function readLastOpened(): string | null {
  try {
    return parseSettingsLastOpened(localStorage.getItem(STORAGE_KEY));
  } catch {
    return null;
  }
}

export function useSettingsLastOpened(): string | null {
  const [previous] = useState(readLastOpened);
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, new Date().toISOString());
    } catch {
      // Storage denied — nothing is marked new on the next visit.
    }
  }, []);
  return previous;
}
