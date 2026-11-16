// Arrow-key focus movement for the glass menus' option lists (the Membership
// chooser behind `Assign to…`, membership-chooser.tsx): the option to focus
// for a key, or null when the key is not the list's. `current` is -1 when no
// option has focus. Arrows wrap; Home and End jump to the ends.
export function nextOptionIndex(key: string, current: number, count: number): number | null {
  if (count === 0) return null;
  switch (key) {
    case "ArrowDown":
      return (current + 1) % count;
    case "ArrowUp":
      return current <= 0 ? count - 1 : current - 1;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}
