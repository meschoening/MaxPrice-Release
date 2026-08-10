// The DataTable's search + sort + flatten step, extracted as a pure function.
//
// It lives here rather than inside the component because the interaction of
// three rules is genuinely subtle, and this repo has no component-test rig — a
// pure function is the only way to pin the behaviour. The bug that prompted the
// extraction: the "nothing to disclose" guard was counting the SEARCH-FILTERED
// children, so a search matching exactly one worktree looked identical to a
// project with no worktrees at all, and the row stayed shut on the very search
// that should have opened it.
//
// The three rules, in the order they apply:
//   1. SEARCH. A parent survives if its own text matches, or if any child's
//      does. A parent that survived only through a child is FORCED open and
//      shows just the matching children — you typed a worktree name because you
//      wanted that worktree. A parent that matched on its own text keeps all its
//      children and stays however the user left it.
//   2. SORT. Parents sort against parents; each parent's `rest` children sort
//      among themselves by the same column and direction. `lead` children never
//      sort (the project's own directory is the anchor its worktrees branched
//      from, not a peer).
//   3. FLATTEN. Children are appended after their parent, AFTER the parent level
//      is sorted — which is what lets the virtualizer count one flat list while
//      a re-sort can never separate a child from its parent.

export type TreeEntry<Row> = { row: Row; child: boolean };

export type FlattenInput<Row> = {
  rows: readonly Row[];
  rowId: (row: Row) => string;
  // The active column's key extractor — a number sorts numerically, a string by
  // locale. Deliberately a KEY rather than a comparator: a comparator is called
  // ~2·n·log n times, and a real column's key is not free (Sessions' project
  // column derives a name from a path — a regex exec plus a split+filter — with
  // no memo), so `sorted` below decorates instead, calling this once per row.
  sortKey: (row: Row) => number | string;
  // Sort direction as a multiplier: 1 ascending, -1 descending.
  dir: 1 | -1;
  // null = no active search (every row matches).
  matches: ((row: Row) => boolean) | null;
  // null = a flat table; every other caller behaves as it did before trees.
  childrenOf: ((row: Row) => { lead: readonly Row[]; rest: readonly Row[] }) | null;
  expanded: ReadonlySet<string>;
};

function compare(a: number | string, b: number | string): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b));
}

// Whether a row has enough children to be worth disclosing. The single source
// of this rule: the flatten below decides whether to emit children, and the
// table decides whether to draw a disclosure control, and the two MUST agree —
// disagreement renders either a control that opens nothing or children with no
// control to close them.
//
// Two invariants live in the ">1", and both are load-bearing:
//   - A project whose only member is its own directory is not a tree. It must
//     render exactly as it did before trees existed: no control, no child row
//     repeating its own name beneath it.
//   - The count is of the FULL child set, never the search-filtered one.
//     "This project has no worktrees" is a property of the project, not of what
//     the current search happened to match. Counting the filtered set is the
//     bug this module was extracted for: a search matching exactly one worktree
//     left one child, looked identical to a worktree-less project, and shut the
//     row on the very search that should have opened it.
export function hasDisclosableChildren(children: {
  lead: readonly unknown[];
  rest: readonly unknown[];
}): boolean {
  return children.lead.length + children.rest.length > 1;
}

export function flattenTreeRows<Row>(input: FlattenInput<Row>): {
  entries: TreeEntry<Row>[];
  // Top-level rows only — the count the header reports, so disclosing a project
  // never makes the table claim to hold more projects than it does.
  topCount: number;
  // The ids actually showing children. NOT the same as `expanded`: a search can
  // force a row open. The disclosure control reads this, so it can never point
  // shut at a row whose children are on screen.
  disclosed: ReadonlySet<string>;
} {
  const { rows, rowId, sortKey, dir, matches, childrenOf, expanded } = input;
  // Decorate-sort-undecorate. `Array.prototype.sort` is stable and the
  // decoration preserves input order, so ties break exactly as they did when
  // this took a comparator — the only thing that changed is how many times the
  // key is computed (once per row, not once per comparison).
  const sorted = (list: readonly Row[]): Row[] =>
    list
      .map((row) => ({ row, key: sortKey(row) }))
      .sort((a, b) => dir * compare(a.key, b.key))
      .map((d) => d.row);

  if (!childrenOf) {
    const kept = matches ? rows.filter(matches) : [...rows];
    const entries = sorted(kept).map((row) => ({ row, child: false }));
    return { entries, topCount: entries.length, disclosed: new Set() };
  }

  // What each surviving parent should disclose, and whether the search opened
  // it. Absent for a parent when no search is running.
  const shown = new Map<string, { lead: readonly Row[]; rest: readonly Row[]; forced: boolean }>();
  let top: Row[];

  if (matches) {
    top = rows.filter((r) => {
      const { lead, rest } = childrenOf(r);
      const selfMatch = matches(r);
      const hitLead = lead.filter(matches);
      const hitRest = rest.filter(matches);
      if (!selfMatch && hitLead.length + hitRest.length === 0) return false;
      shown.set(
        rowId(r),
        selfMatch ? { lead, rest, forced: false } : { lead: hitLead, rest: hitRest, forced: true },
      );
      return true;
    });
  } else {
    top = [...rows];
  }

  const entries: TreeEntry<Row>[] = [];
  const disclosed = new Set<string>();
  const ordered = sorted(top);
  for (const row of ordered) {
    entries.push({ row, child: false });
    const id = rowId(row);
    // `all`, never `shown` — see `hasDisclosableChildren` for why the decision
    // is made on the full child set.
    const all = childrenOf(row);
    if (!hasDisclosableChildren(all)) continue;
    const picked = shown.get(id);
    if (!(picked?.forced ?? false) && !expanded.has(id)) continue;
    disclosed.add(id);
    const { lead, rest } = picked ?? all;
    for (const c of lead) entries.push({ row: c, child: true });
    for (const c of sorted(rest)) entries.push({ row: c, child: true });
  }
  return { entries, topCount: ordered.length, disclosed };
}
