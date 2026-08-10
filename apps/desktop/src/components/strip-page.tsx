import { cn } from "@/lib/utils";

export type StripPageProps = {
  // The detail strip (top) — always rendered; content swaps between the
  // selected row's detail and the filter totals (ADR-0016).
  strip: React.ReactNode;
  // The table card (below) — fills the remaining viewport height.
  table: React.ReactNode;
  // Fired when a click lands on dead space — not on a table row, not on an
  // interactive element, and not inside the strip. The pages use it to clear
  // the row selection ("click anywhere to deselect"), alongside click-again
  // and Esc.
  onBackgroundClick?: () => void;
  className?: string;
};

// Anything matching this is NOT dead space: rows toggle their own selection,
// buttons / links / inputs (sort headers, search, row actions) do their own
// thing, and the strip is the detail being shown — clicking it shouldn't
// dismiss it (the same convention as clicking inside a modal).
const INTERACTIVE_SELECTOR = '[role="row"], button, a, input, select, textarea, [data-strip-slot]';

// Clicks that land on a scrollbar gutter report an offset beyond the target's
// client box — those are scroll interactions, not deselect intents. (Only
// matters where scrollbars take up space, i.e. not macOS overlay scrollbars.)
function isScrollbarClick(e: React.MouseEvent, target: Element): boolean {
  const el = target as HTMLElement;
  const scrollable = el.scrollHeight > el.clientHeight || el.scrollWidth > el.clientWidth;
  return (
    scrollable &&
    (e.nativeEvent.offsetX > el.clientWidth || e.nativeEvent.offsetY > el.clientHeight)
  );
}

// The shared shell for all three list views: a detail strip pinned above a
// full-width table. Replaces SplitPage (Part 4's side-by-side layout) — the
// 360px right pane squeezed the table and truncated its columns. One layout
// at every window width; no responsive collapse rule.
export function StripPage({
  strip,
  table,
  onBackgroundClick,
  className,
}: StripPageProps): React.ReactElement {
  const handleClick = (e: React.MouseEvent<HTMLDivElement>): void => {
    if (!onBackgroundClick) return;
    const target = e.target as Element;
    if (target.closest(INTERACTIVE_SELECTOR)) return;
    if (isScrollbarClick(e, target)) return;
    onBackgroundClick();
  };

  // No page padding: the M2 glass frame (Layout) already floats the main
  // column with its own gutters; strip and table are sibling panels at the
  // frame's 18px rhythm (mock .main).
  return (
    <div className={cn("h-full min-h-0 flex flex-col gap-[18px]", className)} onClick={handleClick}>
      <div data-strip-slot className="shrink-0">
        {strip}
      </div>
      <div className="flex-1 min-h-0 min-w-0">{table}</div>
    </div>
  );
}
