import { cn } from "@/lib/utils";

// Building blocks for the detail strip above the Sessions / Projects / Blocks
// tables (ADR-0016), wearing the glass system (M4, sessions-glass.html §strip).
// The strip has two content modes the pages swap between: the selected row's
// detail and the filter-wide aggregate ("filter totals"). Both render into the
// same DetailStrip container so the swap never shifts the table below.

export type DetailStripProps = {
  // True when showing a selected row — gets the same 3px accent inset bar as
  // selected table rows, so strip and row read as linked (.strip.selected).
  selected: boolean;
  children: React.ReactNode;
  className?: string;
};

// The glass panel container: a horizontal flex row that wraps. At full width
// every block sits on one line; when the window is too narrow to fit them all,
// the flexible sections (chart, model split) and trailing actions flow onto a
// second line instead of clipping at the panel's right edge. The Projects
// page's loading shell passes the `tall` modifier so the taller two-row strip
// settles without shifting the table.
export function DetailStrip({
  selected,
  children,
  className,
}: DetailStripProps): React.ReactElement {
  return (
    <section
      aria-label="Detail strip"
      className={cn("panel strip", selected && "selected", className)}
    >
      {children}
    </section>
  );
}

// The strip's left block: a title, optional status pill, and soft subtitle
// line(s) passed as children.
export function StripIdentity({
  title,
  pill,
  children,
  className,
}: {
  title: React.ReactNode;
  pill?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
}): React.ReactElement {
  return (
    <div className={cn("strip-id", className)}>
      <div className="id-row">
        <h3>{title}</h3>
        {pill}
      </div>
      {children}
    </div>
  );
}

// One labeled stat tile — eyebrow label above, 800-weight value below.
export function StripStat({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}): React.ReactElement {
  return (
    <div className={cn("stat", className)}>
      <span className="eyebrow">{label}</span>
      <b>{children}</b>
    </div>
  );
}

// A flexible labeled region — the model split bar, the compact cost chart,
// the 5h-limit meter. The real flex-basis (190px, .strip-section) is what
// makes the strip's wrap work: a section that can't get at least its basis on
// the current line moves to the next one, then grows to fill it. The `wide`
// modifier (Projects' 30-day chart) widens the basis to 260px.
export function StripSection({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}): React.ReactElement {
  return (
    <div className={cn("strip-section", className)}>
      <span className="eyebrow">{label}</span>
      {children}
    </div>
  );
}
