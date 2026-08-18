/* The three arrangements, as a value TypeScript can read (map #151 / T13 #164,
   ADR-0073).

   The arrangement is a CSS fact — `globals.css`'s "responsive thresholds" block
   is the source of truth, and every page rule is an `@container content` query
   against it. This module exists because two things in the app cannot be
   reached from a container query at all:

     - the wide cost bar is a `Column<Row>` object, and no stylesheet can add a
       column to a `gridTemplateColumns` computed from TypeScript;
     - the session timeline's stacked row height is a virtualizer constant,
       pinned to a fixed `estimateSize` on purpose (appending rows mid-stream
       must never re-measure), unlike `DataTable`'s self-measuring rows.

   So the numbers below are a SECOND copy of the CSS literals, and a disagreeing
   copy is the one failure mode here that produces no visual symptom at the
   boundary it is wrong about — a bar column that appears 40px before the row
   rearranges reads as a glitch nobody can locate. `arrangement.test.ts` reads
   `globals.css` and pins every literal in it to the constants here; that test is
   the whole reason this is a module rather than two inline numbers. */

export type Arrangement = "narrow" | "medium" | "wide";

/** Below this `content` width the row surfaces stack. */
export const NARROW_MAX_CONTENT = 800;
/** At or above this `content` width the void inside each row fills with ink. */
export const WIDE_MIN_CONTENT = 1520;

/* The CSS side of the narrow boundary. `max-width` is inclusive, so the query
   has to stop just short of 800 rather than at it — and it has to stop close
   enough that no reachable width falls between the two forms, because CSS and
   this module must agree at every width a window can actually produce. A
   fractional-DPI Windows desktop gives `content` widths in multiples of 1/dpr
   (0.25px at the extreme), and no such multiple lies strictly between 799.98 and
   800, so the two are the same boundary in practice. Pinned by the test. */
export const NARROW_MAX_QUERY = 799.98;

/** The `.tiles` row's own 3-up/duo threshold — a component floor, not a
    boundary (T2 #153): the sum of the three tiles' measured max-content floors
    plus gaps. It rides this module only so the test can tell a deliberate
    component literal apart from a boundary that has drifted. */
export const TILES_3UP_MIN_CONTENT = 1021;

/** The sidebar collapse, the narrow boundary expressed in FRAME space:
    `frame < 1072` = 800 content + 252 sidebar + 20 gap. Placed there so medium
    sits on both sides of it (ADR-0073). */
export const SIDEBAR_RAIL_MAX_FRAME = NARROW_MAX_CONTENT + 252 + 20 - 1;

/* The COMPLEMENT of that query, for the rules that must apply on the other
   side of the same boundary (the durable `[data-collapsed]` set). The two
   queries have to partition the frame axis with nothing between them, so the
   step is +0.02 and not +1: `min-width: 1072px` would leave a fractional-DPI
   width like 1071.33 — Windows hands out `frame` widths in multiples of 1/dpr
   — matching NEITHER branch, which is the exact hazard NARROW_MAX_QUERY's
   799.98 exists to avoid. No multiple of 1/dpr lies strictly between 1071 and
   1071.02, so the pair is one boundary in practice. Pinned by the test. */
export const SIDEBAR_RAIL_MIN_FRAME_QUERY = SIDEBAR_RAIL_MAX_FRAME + 0.02;

export function arrangementFor(contentWidth: number): Arrangement {
  if (contentWidth >= WIDE_MIN_CONTENT) return "wide";
  if (contentWidth < NARROW_MAX_CONTENT) return "narrow";
  return "medium";
}
