import type { Column } from "./data-table";

/* Wide's ink (map #151 / T13 #164, ADR-0073).

   At content 2256 the sessions table is 578px of ink in 2245 — three flexible
   tracks holding 869/609/435 for 248/77/52 of text — and a row whose label and
   value are 1300px apart is not spacious, it is untrackable. The bar is the
   answer to that: NOT a new number (nothing on this map touches the wire), but
   the row's own cost, drawn instead of merely printed.

   It is a COLUMN rather than a row background because a column does two jobs
   where a background does one. Taking `3fr` of the slack pulls the text tracks
   from 869/609/435 down to 517/362/258, so the distance that made the row
   untrackable actually shrinks; a background fills the void without closing it,
   and paints under 12.5px text in three themes besides. It sits immediately
   left of Cost so the drawing and its number read as one lockup — the prototype
   put it where the void was, which is further from the number it draws.

   Every table gets one wherever the arrangement is wide, including Projects,
   whose single-row corpus gains nothing from it today: the bar's absence must
   never be a fact the reader has to interpret, and a machine with twenty
   projects gets from it exactly what Sessions gets. */

/** A nonzero row always draws something: at a long-tailed spread (one $40
    session against a hundred at $0.20) a true proportional width rounds to
    nothing, and an empty cell reads as missing data rather than as a small
    number. 1.5% is the floor, not a scale change — the bar stays linear, so
    lengths remain comparable. */
const MIN_VISIBLE_PCT = 1.5;

export function CostBar({ value, max }: { value: number; max: number }): React.ReactElement {
  const pct = max > 0 ? Math.max(value > 0 ? MIN_VISIBLE_PCT : 0, (value / max) * 100) : 0;
  return (
    // aria-hidden: the value is printed in the Cost cell of the same row, so to
    // a screen reader this is a second reading of a number it already has.
    <span className="cost-bar" aria-hidden>
      <i style={{ width: `${pct}%` }} />
    </span>
  );
}

// The column factory belongs beside the mark it draws; splitting a 6px bar
// across two files to keep fast refresh happy costs more than the refresh.
// eslint-disable-next-line react-refresh/only-export-components
export function costBarColumn<Row>(opts: { max: number; get: (row: Row) => number }): Column<Row> {
  const { max, get } = opts;
  return {
    id: "costShare",
    header: "Cost share",
    // The flexible track that was the void. `minmax(120px,3fr)` rather than a
    // fixed width so it takes the slack rather than adding to it — the column
    // only exists at wide, where there is slack to take.
    width: "minmax(120px,3fr)",
    // Sortable, ordering by the value it draws. It duplicates the Cost column's
    // ordering, which is the honest shape: a header that sorts by exactly what
    // its column depicts, sitting inert beside sortable neighbours, would read
    // as broken rather than as deliberate.
    sortValue: get,
    cell: (row: Row) => <CostBar value={get(row)} max={max} />,
  };
}
