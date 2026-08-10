// The multi-select chip's checkbox semantics, extracted pure so they pin under
// plain bun tests (the table-tree precedent — this repo has no component rig,
// and the membership rules below are exactly the kind of subtlety that once
// hid a bug inside component internals).
//
// An option is ONE checkbox, but under Repo identity (ADR-0062 §5) it may
// stand for several stored values: a folded group's option carries every
// member checkout's parent slug in `members`. Checked-state matches on
// membership OVERLAP, never value equality — a selection persisted before the
// Identity directory loaded may hold a non-representative member, and the
// group's box must still read checked. A member-less option stands for its own
// value, which keeps the model/machine menus byte-identical to before.

export type MultiSelectOption = { value: string; members?: string[] };

// Every stored value this option stands for.
export function optionMembers(o: MultiSelectOption): readonly string[] {
  return o.members !== undefined && o.members.length > 0 ? o.members : [o.value];
}

// Checked-state: any member overlap with the stored selection.
export function isOptionSelected(o: MultiSelectOption, selected: readonly string[]): boolean {
  return optionMembers(o).some((m) => selected.includes(m));
}

// One checkbox click → the next stored selection. Deselecting removes EVERY
// member (unchecking a Repo identity group clears whichever member slugs the
// selection holds); selecting appends the option's own value (the
// representative slug) only.
//
// Checking every box (or clearing the last one) reads as "All" — reset to the
// empty selection (INTERACTIONS.md focus pattern; the wire treats both
// identically). The reset counts CHECKED OPTIONS, not stored values: a group's
// stored selection can hold several member slugs while being one checked box.
export function toggleOption(
  options: readonly MultiSelectOption[],
  selected: readonly string[],
  toggled: MultiSelectOption,
): string[] {
  const members = optionMembers(toggled);
  const next = isOptionSelected(toggled, selected)
    ? selected.filter((s) => !members.includes(s))
    : [...selected, toggled.value];
  const checked = options.filter((o) => isOptionSelected(o, next)).length;
  return checked === options.length ? [] : next;
}

// How many CHECKBOXES the summary should claim, which is not `selected.length`:
// one folded group's option can stand for several stored member slugs, so a
// selection of two checkouts that now fold together is one checked box — the
// same distinction toggleOption's All reset makes.
//
// The uncovered ("orphan") term is what keeps the count honest in the other
// direction: the rail's options come from its date-range-scoped project rows,
// so a persisted selection for a project with no rows in range is not among
// them. Counting checked options alone would report zero for a selection the
// rail is visibly rendering as a raw slug — so every stored value no option
// covers counts as itself.
export function selectedOptionCount(
  options: readonly MultiSelectOption[],
  selected: readonly string[],
): number {
  const covered = new Set(options.flatMap((o) => [...optionMembers(o)]));
  const checked = options.filter((o) => isOptionSelected(o, selected)).length;
  return checked + selected.filter((s) => !covered.has(s)).length;
}
