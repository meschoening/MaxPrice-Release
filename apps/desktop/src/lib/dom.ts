// Shared keydown-guard helper: is the event target a text-editing surface where
// a printable key should type/act normally rather than fire an app-wide hotkey?
// True for <input>, <textarea>, and any contentEditable element — so a capital
// "R" types in a Settings field instead of triggering a rescan, and an Esc that
// clears a search box doesn't also clear the table selection.
//
// Duck-typed on the DOM properties rather than `instanceof HTMLElement` so the
// pure logic is testable without a DOM, and safe for non-element EventTargets
// (window, document, null) — they simply lack `tagName` and return false.
export function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as Partial<HTMLElement> | null;
  if (!el) return false;
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable === true;
}
