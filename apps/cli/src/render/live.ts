import {
  abbreviate,
  type BlockRow,
  blockState,
  formatCost,
  formatElapsed,
  formatRange,
  formatRemainingLong,
  formatWallClock,
  type PopoutHead,
  type PopoutViewState,
  type TimeDisplay,
  type UsageWindow,
} from "@maxprice/shared";
import { terminalText } from "@maxprice/usage-core/terminal-text";
import type { Style } from "./style";
import type { Output } from "./table";

// `maxprice live` as #445's Variant A key-value panel: one snapshot of the
// tray popout's view (`popoutView`), with the Active block's burn rate and
// projection from /api/blocks, which the popout has no room for. Every
// number the popout draws is printed as the view formats it, so the panel
// can disagree with the popout only by asking a different question.
//
// The top section is the Active block, or the single line `No active block`;
// under it, the limits and Today. A percent the view has no fresh reading
// for prints `—` (ADR-0030), with no reset beside it. The panel is never
// truncated: its lines are short, and a pipe keeps them whole.

// The view a panel prints. `loading` and `down` are the command's: a snapshot
// is taken only of final answers, and a failed fetch is an error.
export type LiveView = Extract<PopoutViewState, { kind: "no-data" } | { kind: "dash" }>;

export type LiveReport = {
  view: LiveView;
  // The active block the view was built from: its window, burn rate and
  // projection.
  block: BlockRow | null;
  // The Quota organization's 5-hour and weekly readings, for their resets.
  fiveHour: UsageWindow | null;
  weekly: UsageWindow | null;
  now: number;
  display: TimeDisplay;
};

// The popout's first-launch copy.
export const NO_DATA = "No usage yet — MaxPrice is waiting for your first Claude Code session.";
export const NO_ACTIVE_BLOCK = "No active block";
const DASH = "—";

// The key column's least width, the prototype's: `5-hour limit` and two
// spaces. A longer key, a model's limit, widens the whole column.
const KEY_MIN = 14;

type Line = { key: string; value: string };
type Dash = Extract<LiveView, { kind: "dash" }>;

// The Active block's title and lines, or null with none. The head's ring is
// not enough: with no block the ring can be the account's 5-hour window,
// which is no Active block.
function activeBlock(
  head: PopoutHead,
  report: LiveReport,
  s: Style,
): { title: string; lines: Line[] } | null {
  if (head.kind !== "ring") return null;
  const state = blockState(report.block, report.now);
  if (state.kind !== "active") return null;
  const { block, startMs, endMs } = state;
  const { display, now } = report;
  const elapsed = `(${formatElapsed(now - startMs)} in, ${head.centerLabel ?? DASH} left)`;
  const lines: Line[] = [
    { key: "Window", value: `${formatRange(startMs, endMs, display)}  ${s.dim(elapsed)}` },
    { key: "Cost", value: `${s.bold(head.costText)}  ${s.dim(head.tokensText)}` },
  ];
  if (block.burnRate !== null) {
    const { tokensPerMinute, costPerHour } = block.burnRate;
    lines.push({
      key: "Burn rate",
      value: `${abbreviate(tokensPerMinute)} tok/min · ${formatCost(costPerHour)}/h`,
    });
  }
  if (block.projection !== null) {
    lines.push({
      key: "Projected",
      value: `${formatCost(block.projection.totalCost)} by ${formatWallClock(endMs, display)}`,
    });
  }
  const title =
    head.eyebrowTag === null ? "Active block" : `Active block · ${terminalText(head.eyebrowTag)}`;
  return { title, lines };
}

function percent(pct: number | null, s: Style): string {
  return pct === null ? s.dim(DASH) : `${pct}%`;
}

// A reading's reset, beside its percent only: `—` has no reading to reset.
function reset(
  pct: number | null,
  window: UsageWindow | null,
  text: (resetMs: number) => string,
  s: Style,
): string {
  return pct === null || window === null ? "" : `  ${s.dim(text(Date.parse(window.resetAt)))}`;
}

function limitLines(view: Dash, report: LiveReport, s: Style): Line[] {
  const { display, now } = report;
  const lines: Line[] = [
    {
      key: "5-hour limit",
      value:
        percent(view.limitPct, s) +
        reset(view.limitPct, report.fiveHour, (ms) => `resets ${formatWallClock(ms, display)}`, s),
    },
    {
      key: "Weekly limit",
      value:
        percent(view.weeklyPct, s) +
        reset(
          view.weeklyPct,
          report.weekly,
          (ms) => `resets in ${formatRemainingLong(ms - now)}`,
          s,
        ),
    },
  ];
  // Labelled from the wire (`Fable limit`).
  if (view.modelRow !== null) {
    lines.push({ key: terminalText(view.modelRow.label), value: percent(view.modelRow.pct, s) });
  }
  lines.push({
    key: view.todayLabel,
    value: `${s.bold(view.todayText)}  ${s.dim(view.todayTokensText)}`,
  });
  return lines;
}

export function renderLive(report: LiveReport, out: Output): string {
  const { view } = report;
  if (view.kind === "no-data") return `${NO_DATA}\n`;
  const s = out.style;
  const block = activeBlock(view.head, report, s);
  const limits = limitLines(view, report, s);
  const keys = [...(block?.lines ?? []), ...limits].map((l) => l.key);
  const width = Math.max(KEY_MIN, ...keys.map((key) => Bun.stringWidth(key) + 2));
  const row = (l: Line) =>
    `  ${s.dim(l.key)}${" ".repeat(width - Bun.stringWidth(l.key))}${l.value}`;
  const top =
    block === null ? [s.dim(NO_ACTIVE_BLOCK)] : [s.bold(block.title), ...block.lines.map(row)];
  return [...top, "", ...limits.map(row)].join("\n") + "\n";
}
