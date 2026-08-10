import type { BlockRow } from "@maxprice/shared";

// Provenance copy + dot styling per windowSource (ADR-0028/0029) — the single
// source for BOTH the Blocks view and the Live chart's block span (ADR-0031),
// so the two surfaces never drift on language. "annulled" is a real window cut
// short by an out-of-band reset — its start is exact, its end is its successor
// window's start, its span under 5h.
export const WINDOW_SOURCE = {
  observed: {
    aria: "exact window",
    title: "Exact window — boundaries from Anthropic's reset time",
    strip: "exact window",
    dot: "size-1.5 shrink-0 rounded-full bg-brand/80",
  },
  annulled: {
    aria: "window ended early",
    title: "Window ended early — Anthropic reset limits out-of-band",
    strip: "ended early — limits reset",
    dot: "size-1.5 shrink-0 rounded-full bg-warn/80",
  },
  heuristic: {
    aria: "estimated window",
    title: "Estimated window — no usage history covered this period",
    strip: "estimated window",
    dot: "size-1.5 shrink-0 rounded-full border border-soft/50",
  },
} as const satisfies Record<
  BlockRow["windowSource"],
  { aria: string; title: string; strip: string; dot: string }
>;

// The chart-foot provenance note for the block span (ADR-0031): dot + strip
// copy. The caller decides when to show it (the Live chart shows it only for
// non-observed windows — the dot would be noise on the exact case).
export function WindowSourceNote({
  source,
}: {
  source: BlockRow["windowSource"];
}): React.ReactElement {
  const s = WINDOW_SOURCE[source];
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] text-soft" title={s.title}>
      <span role="img" aria-label={s.aria} className={s.dot} />
      {s.strip}
    </span>
  );
}
