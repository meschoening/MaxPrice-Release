import { deriveProjectName, deriveProjectPath, type ProjectRow } from "@maxprice/shared";
import type { IdentityIndex } from "@/lib/project-identity";
import { foldProjectRows } from "@/lib/projects";

// The sidebar's Project filter options.
//
// One option per PROJECT: worktrees fold into their repository (ADR-0061), and
// checkouts sharing a Repo identity fold into one group (ADR-0062) — the menu
// offers the same identities the Projects page and the chart do. Selecting one
// reaches every checkout's work because the checked-state/selection layer
// carries the group's `members` (each widened to its worktrees sidecar-side).
//
// The option VALUE stays a slug — the group's representative parent slug, the
// same slug-typed key every other surface uses. Only the rendered label is
// derived, and it is the project's folder NAME rather than its path (ADR-0009's
// display pair), matching every other project-naming surface.
//
// Options derive from PROJECT ROWS, never from the Identity directory alone: a
// replica-off client still mirrors foreign rows in its directory, and
// enumerating those would surface peers' repos with no data behind them. The
// directory only ever WIDENS an existing option's membership.
//
// WHY THE LABEL IS SOMETIMES STILL A PATH. Folder names are not unique, and the
// identity fold only removes the collisions it can prove (two checkouts of one
// repo). Two genuinely different projects sharing a name — or two checkouts the
// directory hasn't identified yet — still render as one name twice, so a name
// shared by more than one option carries its path — and ONLY then, so the
// common case stays short.
export type ProjectOption = {
  value: string;
  label: string;
  // Every parent slug this option stands for — the Repo identity group's
  // members (ADR-0062 §5), or just the option's own slug. Checkbox
  // checked-state matches on membership overlap; deselecting removes them all.
  members: string[];
  // What the menu's search box matches on. Always carries both the name and the
  // full path, so filtering by directory keeps working even where the label is
  // a bare name.
  searchText: string;
};

const DISAMBIGUATOR = " — ";

export function buildProjectOptions(
  input: readonly ProjectRow[],
  identity?: IdentityIndex,
): ProjectOption[] {
  const rows = foldProjectRows(input, identity).map((g) => g.row);
  const nameCounts = new Map<string, number>();
  for (const r of rows) {
    const name = deriveProjectName(r.path);
    nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
  }

  return (
    rows
      .map((r) => {
        const name = deriveProjectName(r.path);
        const path = deriveProjectPath(r.path);
        const ambiguous = (nameCounts.get(name) ?? 0) > 1;
        // The directory may know members the range has no rows for — they stay
        // members (a stored selection of one keeps the box checked) without
        // ever becoming options of their own.
        const groupMembers = identity ? identity.membersOf(identity.keyOf(r.slug)) : [];
        return {
          value: r.slug,
          label: ambiguous ? `${name}${DISAMBIGUATOR}${path}` : name,
          members: groupMembers.length > 0 ? [...groupMembers] : [r.slug],
          searchText: `${name} ${path}`,
        };
      })
      // Slug order. Worktrees and folded checkouts no longer appear as their
      // own options, so this is simply a stable deterministic ordering — and it
      // keeps name-colliding projects adjacent, which is where the path
      // disambiguator earns its keep.
      .sort((a, b) => (a.value < b.value ? -1 : a.value > b.value ? 1 : 0))
  );
}
