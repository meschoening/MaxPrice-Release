import { useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown, ArrowUp, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { flattenTreeRows, hasDisclosableChildren } from "@/lib/table-tree";
import { TableHeadBar } from "./table-head-bar";

export type SortDir = "asc" | "desc";

// Optional one-level hierarchy (ADR-0061 — a repository's worktrees fold into
// it, disclosed on demand). Depth is deliberately capped at one: the shape this
// exists for is a project and its worktrees, and a general tree would drag in
// recursive sorting and indent scaling for no caller that wants them.
export type TreeSpec<Row> = {
  // A row's children, split by how they order. `lead` renders first in the
  // order given and never sorts — the Projects page's own-directory row, which
  // is the anchor its worktrees branched from rather than a peer, so it must
  // not wander when the table is re-sorted. `rest` sorts by the active column
  // and direction, exactly like the top level.
  childrenOf: (row: Row) => { lead: readonly Row[]; rest: readonly Row[] };
};

export type Column<Row> = {
  id: string;
  header: string;
  cell: (row: Row) => React.ReactNode;
  // Sort key for this column. A number sorts numerically, a string by locale.
  //
  // OMIT IT to make the column unsortable — its header renders as inert text
  // rather than a button. That is the honest shape for a column of per-row
  // action buttons, which has nothing to order by: supplying a constant instead
  // produced a focusable header that announced itself as sortable, and clicking
  // it silently discarded the active sort in exchange for no ordering at all.
  sortValue?: (row: Row) => number | string;
  // Numeric columns right-align (.cell.num).
  numeric?: boolean;
  // Extra class on every body cell of this column — e.g. `cost` for the
  // 800-weight cost face, `softer` for de-emphasized text (M4).
  cellClass?: string;
  // CSS grid track for the column. Defaults to `minmax(0,1fr)`.
  width?: string;
  // Does this row's cell hold nothing worth a labelled slot? Read ONLY by the
  // narrow arrangement, where the row wraps to a second line and each value
  // carries its column's name (map #151 / T13, ADR-0073). Without it a done
  // Blocks row spends three of its six slots printing "BURN RATE —" and runs to
  // a third line against the active row's two — rows that no longer measure the
  // same height, which is what makes a table read as improvised.
  //
  // It lives on the Column because CSS cannot select on text at all and the
  // component cannot know what an em dash means. A column whose cells are
  // always populated omits it.
  isEmpty?: (row: Row) => boolean;
};

export type DataTableProps<Row> = {
  title: string;
  rows: Row[];
  columns: Column<Row>[];
  rowId: (row: Row) => string;
  onSelect?: (row: Row) => void;
  selectedId?: string;
  defaultSort: { columnId: string; dir: SortDir };
  // Per-row searchable strings — free-text search matches if any contains the
  // query (case-insensitive). Omit to disable search.
  searchKeys?: (row: Row) => string[];
  // A row excluded from the sortable/virtualized body and rendered inside the
  // sticky header block instead — the Blocks page's pinned active block. It
  // stays put regardless of sort order AND scroll position (.row.pinned).
  pinnedRow?: Row;
  // Width floor for the table grid, in px. Below it the table scrolls
  // horizontally (the wrapper's overflow-x-auto) instead of letting the
  // flexible minmax(0,…) name columns collapse to nothing — the fixed-width
  // data columns would otherwise win all the space at narrow window widths.
  minWidth?: number;
  // Extra classes per row — the Projects page dims stale rows through this.
  rowClassName?: (row: Row) => string | undefined;
  // One level of expandable children (ADR-0061). Omit for a flat table — every
  // other caller behaves exactly as it did before this existed.
  tree?: TreeSpec<Row>;
  searchPlaceholder?: string;
  emptyMessage?: string;
  // The page query's error, rendered as the danger inset when there are no
  // rows to show — without it a report 5xx is indistinguishable from an empty
  // range (the prototype's seeded corpus never errored, so this state has no
  // mock; the recipe mirrors SessionDetail's ErrorState). Stale rows from a
  // failed refetch still render as a table — data beats an error card.
  error?: Error | null;
  headerAction?: React.ReactNode;
};

// Past this many rows the body is virtualized (TanStack Virtual). Smaller lists
// render every row — cheaper and free of measurement quirks. The scroll body
// fills whatever height the page's flex column gives it (ADR-0016) — the table
// panel is the page's flex-1 region, so the body's height is the viewport
// remainder after the detail strip.
const VIRTUALIZE_THRESHOLD = 200;
// Estimated row height seeding the virtualizer's scroll math. Rows self-measure
// (measureElement) so this only needs to be close — ~52px is a two-line row
// (9px cell padding + two leading lines + the hairline divider). Forcing rows
// to a fixed height shorter than their content pushed the text off-center.
const ESTIMATED_ROW_HEIGHT = 52;

// Generic sortable / searchable / virtualized table on the M4 glass recipes:
// one frosted panel, flat-tint hairline rows, the sticky frosted column
// header. One primitive, used by the Sessions, Projects, and Blocks views.
export function DataTable<Row>({
  title,
  rows,
  columns,
  rowId,
  onSelect,
  selectedId,
  defaultSort,
  searchKeys,
  pinnedRow,
  minWidth,
  rowClassName,
  tree,
  searchPlaceholder,
  emptyMessage = "No rows.",
  error,
  headerAction,
}: DataTableProps<Row>): React.ReactElement {
  // The user's REQUEST, which may name a column that is not currently on the
  // table: the active sort column can disappear beneath the sort. `costShare`
  // exists only in the wide arrangement (ADR-0073) and the machine columns only
  // while the machine axis is on, so maximizing, sorting by Cost share, and
  // un-maximizing used to leave `find` returning undefined — every row silently
  // ordered by the first column in the stale direction, with `aria-sort="none"`
  // and no arrow anywhere, so the table looked unsorted while being sorted by a
  // column nobody chose.
  //
  // So the request is remembered but not applied while its column is away:
  // re-widening (or re-enabling the axis) restores the choice without a click,
  // and because the ordering below and the header indicator both read the two
  // derived values, they can never disagree about what is sorted.
  //
  // Derived during render rather than reset from an effect for two reasons: an
  // effect costs a second render on every resize, and it could not honestly
  // name `defaultSort` in its dependency array — all three call sites pass it
  // as an inline object literal, so its identity is fresh every render. Two
  // primitives rather than one derived object for the same identity reason:
  // an object would churn the `entries` memo below every render.
  //
  // The state is `sortRequest`, not `sort`, so that no site downstream can read
  // the raw request by accident — `tsc` is the coverage this repo's missing
  // component-test rig would otherwise have to provide.
  const [sortRequest, setSort] = useState(defaultSort);
  const sortIsVisible = columns.some((c) => c.id === sortRequest.columnId);
  const sortColumnId = sortIsVisible ? sortRequest.columnId : defaultSort.columnId;
  const sortDir = sortIsVisible ? sortRequest.dir : defaultSort.dir;
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  // Which rows are disclosed. Deliberately ephemeral and collapsed on mount:
  // children are extra detail revealed when wanted, and a persisted expansion
  // would present them as the default view (ADR-0061).
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Debounce the search term by 100ms so a fast typist doesn't re-filter a
  // multi-thousand-row list on every keystroke.
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput), 100);
    return () => clearTimeout(t);
  }, [searchInput]);

  const pinnedId = pinnedRow ? rowId(pinnedRow) : undefined;

  // The rendered body. All of search / sort / flatten lives in the pure
  // `flattenTreeRows` (lib/table-tree.ts) so its rules are unit-testable — the
  // component only supplies the active column's sort key and the search
  // predicate. The key goes over as a key rather than a comparator so the lib
  // can call it once per row instead of once per comparison (some columns
  // derive their key from a path per call, with no memo).
  const { entries, topCount, disclosed } = useMemo(() => {
    const col = columns.find((c) => c.id === sortColumnId) ?? columns[0];
    const needle = search.trim().toLowerCase();
    return flattenTreeRows<Row>({
      rows: rows.filter((r) => rowId(r) !== pinnedId),
      rowId,
      // No column, or an unsortable one named by `defaultSort` — a constant key
      // leaves the rows in the order the caller gave them. Unreachable by click:
      // an unsortable header is not a button.
      sortKey: col?.sortValue ?? (() => 0),
      dir: sortDir === "asc" ? 1 : -1,
      matches:
        needle && searchKeys
          ? (r) => searchKeys(r).some((k) => k.toLowerCase().includes(needle))
          : null,
      childrenOf: tree ? tree.childrenOf : null,
      expanded,
    });
  }, [rows, columns, sortColumnId, sortDir, search, searchKeys, rowId, pinnedId, tree, expanded]);

  const rowVirtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ESTIMATED_ROW_HEIGHT,
    overscan: 12,
  });

  const virtualize = entries.length > VIRTUALIZE_THRESHOLD;
  const gridTemplateColumns = columns.map((c) => c.width ?? "minmax(0,1fr)").join(" ");

  // Compares against the EFFECTIVE column, not the remembered request: while a
  // request is parked, the header shows the fallback as sorted, and a first
  // click on what the user can see must flip it rather than restate it as asc.
  const toggleSort = (columnId: string): void => {
    setSort(
      sortColumnId === columnId
        ? { columnId, dir: sortDir === "asc" ? "desc" : "asc" }
        : { columnId, dir: "asc" },
    );
  };

  // Virtualized rows are absolutely positioned by the virtualizer and
  // self-measure (measureElement) so they keep their natural content height —
  // a fixed height shorter than the two-line cells pushed text off-center.
  // The pinned row renders through the same path with the `pinned` treatment
  // and no virtualizer wiring.
  const toggleExpand = (id: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  };

  const renderRow = (
    row: Row,
    virtual?: { index: number; start: number },
    pinned = false,
    child = false,
  ): React.ReactElement => {
    const id = rowId(row);
    const selected = id === selectedId;
    // A disclosure control appears only where there is something to disclose,
    // by the same predicate the flatten uses to decide whether to emit children
    // — spelling the rule out twice is how a control that opens nothing (or
    // children with no control) gets shipped.
    const kids = tree && !child ? tree.childrenOf(row) : undefined;
    const expandable = kids !== undefined && hasDisclosableChildren(kids);
    // Actual disclosure, not the user's toggle — a search can force a row open,
    // and a control pointing shut at visible children is simply lying.
    const open = expandable && disclosed.has(id);
    return (
      <div
        key={id}
        role="row"
        aria-selected={selected}
        tabIndex={0}
        data-index={virtual?.index}
        ref={virtual ? rowVirtualizer.measureElement : undefined}
        onClick={() => onSelect?.(row)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onSelect?.(row);
          }
        }}
        style={{
          ...(virtual
            ? {
                position: "absolute" as const,
                top: 0,
                left: 0,
                width: "100%",
                transform: `translateY(${virtual.start}px)`,
              }
            : undefined),
          gridTemplateColumns,
        }}
        className={cn(
          "grid items-center row",
          pinned && "pinned",
          child && "child",
          rowClassName?.(row),
        )}
      >
        {columns.map((col, i) => (
          <div
            key={col.id}
            role="cell"
            /* The two inert attributes the narrow arrangement needs on an
               otherwise unchanged element tree (ADR-0073). `data-col` is the
               column's name beside its value, because `content: attr()` is the
               only way a stylesheet can write text; `data-empty` suppresses the
               slot entirely, because CSS cannot select on text. Both are dead
               weight in every other arrangement, on purpose — the alternative
               is a different element tree per width. */
            data-col={col.header}
            data-empty={col.isEmpty?.(row) ? "1" : undefined}
            className={cn("cell", col.numeric && "num", col.cellClass)}
          >
            {i === 0 && tree ? (
              // The disclosure control lives in the first column so the tree
              // reads down the name axis. `stopPropagation` because the row
              // itself is a select target — opening a project must not also
              // select it.
              <span className="tree-cell">
                {expandable ? (
                  <button
                    type="button"
                    className={cn("tree-toggle", open && "open")}
                    aria-expanded={open}
                    aria-label={open ? "Collapse" : "Expand"}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleExpand(id);
                    }}
                    onKeyDown={(e) => e.stopPropagation()}
                  >
                    <ChevronRight aria-hidden strokeWidth={2.5} />
                  </button>
                ) : (
                  <span className="tree-toggle placeholder" aria-hidden />
                )}
                {col.cell(row)}
              </span>
            ) : (
              col.cell(row)
            )}
          </div>
        ))}
      </div>
    );
  };

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <TableHeadBar
        title={title}
        search={searchInput}
        onSearch={setSearchInput}
        count={topCount + (pinnedRow ? 1 : 0)}
        searchPlaceholder={searchPlaceholder}
        action={headerAction}
      />

      {/* Everything below the head bar shares one horizontal scroll container;
          the row floor lands on the vertical scroll body — its content is
          width:auto and follows — so below the floor this wrapper scrolls
          horizontally with row backgrounds still painting their full width.

          The floor travels as a CUSTOM PROPERTY rather than as `min-width`
          itself: at narrow the row wraps and nothing is off-screen any more, so
          the floor has to go or the scroller keeps a phantom scrollbar under a
          row that fits — and an inline `min-width` could only be overridden
          with `!important`. A variable lets the arrangement's rule simply
          declare `min-width: 0` (globals.css, `.table-scroll`). */}
      <div className="overflow-x-auto flex-1 min-h-0 flex flex-col">
        <div
          ref={scrollRef}
          style={
            {
              "--row-floor": minWidth === undefined ? "0px" : `${minWidth}px`,
            } as React.CSSProperties
          }
          className="table-scroll thin-scroll flex-1 min-h-0 overflow-y-auto"
        >
          <div role="table" aria-label={title}>
            {/* One sticky frosted surface: the column-header row plus (on
                Blocks) the pinned active row — rows blur sliding beneath. */}
            <div className="sticky-head">
              <div role="row" style={{ gridTemplateColumns }} className="grid col-head">
                {columns.map((col) => {
                  // A column with no `sortValue` is inert: a plain cell, not a
                  // button, and no `aria-sort` — which on a non-sortable header
                  // would claim it is merely unsorted rather than unsortable.
                  // It keeps `role="columnheader"` so the grid's column count
                  // still matches the rows'.
                  if (!col.sortValue) {
                    return (
                      <div
                        key={col.id}
                        role="columnheader"
                        // The same attribute the body cells carry, for the same
                        // reason in reverse: at narrow the header becomes a
                        // wrapping run of sort chips, and a column with no name
                        // (the Projects merge action) must not draw a blank one.
                        data-col={col.header}
                        className={cn(col.numeric && "num")}
                      >
                        <span>{col.header}</span>
                      </div>
                    );
                  }
                  const active = sortColumnId === col.id;
                  return (
                    <button
                      key={col.id}
                      type="button"
                      role="columnheader"
                      data-col={col.header}
                      aria-sort={active ? (sortDir === "asc" ? "ascending" : "descending") : "none"}
                      onClick={() => toggleSort(col.id)}
                      className={cn(col.numeric && "num", active && "sorted")}
                    >
                      <span>{col.header}</span>
                      {active ? (
                        sortDir === "asc" ? (
                          <ArrowUp aria-hidden strokeWidth={2.5} />
                        ) : (
                          <ArrowDown aria-hidden strokeWidth={2.5} />
                        )
                      ) : null}
                    </button>
                  );
                })}
              </div>
              {pinnedRow ? renderRow(pinnedRow, undefined, true) : null}
            </div>

            {entries.length === 0 && error ? (
              <div className="inset danger m-3" role="alert">
                <p className="lead">Could not load {title.toLowerCase()}</p>
                <p className="num break-words">{error.message}</p>
              </div>
            ) : entries.length === 0 ? (
              <p className="empty-msg">{emptyMessage}</p>
            ) : virtualize ? (
              <div style={{ height: rowVirtualizer.getTotalSize(), position: "relative" }}>
                {rowVirtualizer.getVirtualItems().map((vi) => {
                  const entry = entries[vi.index];
                  if (!entry) return null;
                  return renderRow(entry.row, vi, false, entry.child);
                })}
              </div>
            ) : (
              entries.map((entry) => renderRow(entry.row, undefined, false, entry.child))
            )}
          </div>
          <div className="fade" aria-hidden />
        </div>
      </div>
    </div>
  );
}
