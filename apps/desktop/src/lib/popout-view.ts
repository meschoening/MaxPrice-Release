import {
  formatWallClock,
  type BlockRow,
  type ModelScopedWindow,
  type TimeDisplay,
  type UsageWindow,
} from "@maxprice/shared";
import { abbreviate } from "@/lib/active-block";
import { activeBlockTileState } from "@/lib/active-block-tile-state";
import { usageRingState } from "@/lib/usage-ring";
import { corpusIsEmpty } from "@/state/use-corpus-empty";

// Pure view-state for the tray popout mini-dashboard (map #168 M3; the T3
// "leaf" contract, NOTES.md §"Client tray popout — Glass (T3)"). Extracted
// from the component so the state ladder — sidecar down / first launch / the
// dash with its head + rows — and every formatted string are pinnable without
// a DOM. The quantities deliberately reuse the Live page's own derivations
// (`activeBlockTileState`, the Today row's totalCost + totalTokens), so the popout can only
// disagree with Live by failing to fetch, never by re-deriving.

export type PopoutHead =
  | {
      kind: "ring";
      ringFrac: number;
      // The countdown alone at this size (no "to reset" sublabel); null → "—".
      centerLabel: string | null;
      // The block's cost-so-far — the 19px/800 value.
      costText: string;
      // The block's totalTokens beside the cost ("1.2M tok"), abbreviated like
      // the Today row's tokens and drawn as the same smaller --soft run.
      tokensText: string;
      // "3h 18m · resets 7:00 PM" (no "elapsed" — the ring's countdown already
      // carries the time story). Ellipsis-guarded by CSS, not truncated here.
      metaText: string;
    }
  | { kind: "idle" }; // the dashed "No active block" inset

export type PopoutViewState =
  // Queries not settled, OR the engine's boot scan has not landed — actions
  // only. Both mean the same thing to a reader: nothing here is a verdict yet.
  | { kind: "loading" }
  | { kind: "down" } // sidecar unreachable — the danger inset
  | { kind: "no-data" } // scanned and genuinely empty — the orb inset, no rows
  | {
      kind: "dash";
      head: PopoutHead;
      // The 5-hour limit row: null renders the em-dash at 0.55 opacity (the
      // ADR-0030 rule — a real fresh reading only, never a stale percent).
      limitPct: number | null;
      // The weekly limit row, the same freshness rule (a connected reading whose
      // reset is still ahead — the This-week tile's gate), else the em-dash.
      weeklyPct: number | null;
      // The Model-scoped weekly limit row. PRESENCE is a wire fact AND an
      // opt-in — drawn iff the sample carries one (so an account that stops
      // reporting it loses the row cleanly) and Settings' `showModelLimit` is
      // on (default off); the shell sizes the window from the same two bits
      // (/api/readout's hasModelWindow × settings.json). DIMMING is a freshness
      // fact — `pct` null under the ADR-0030 rule like the other two rows.
      // Labelled from the wire ("Fable limit"), never from an assumed family.
      modelRow: { label: string; pct: number | null } | null;
      todayText: string;
      // Today's total tokens (the daily row's totalTokens, every token type),
      // abbreviated and drawn to the right of the cost: "41.2M tok".
      todayTokensText: string;
    };

export type PopoutViewInput = {
  // Any popout query errored — getSidecarUrl failed or a fetch died. One bit:
  // the popout explains trouble with one danger inset, not per-row apologies.
  anyError: boolean;
  // Every popout query has settled (data present).
  settled: boolean;
  // /api/status `ready` + `hasData` (ADR-0047), and they are read TOGETHER by
  // `corpusIsEmpty` — never `hasData` alone. `hasData: false` before `ready`
  // means "the scan has not finished", not "there is nothing to scan", and
  // reading it as the latter is what made the popout announce a first launch
  // on a machine with 650 MB of history (issue #183). `null` until the first
  // status frame arrives.
  ready: boolean | null;
  hasData: boolean | null;
  block: BlockRow | null;
  usageWindow: UsageWindow | null;
  weeklyWindow: UsageWindow | null;
  modelWindow: ModelScopedWindow | null;
  showModelLimit: boolean;
  usageConnected: boolean;
  todayCost: number;
  todayTokens: number;
  now: number;
  display: TimeDisplay;
};

export function popoutView(input: PopoutViewInput): PopoutViewState {
  if (input.anyError) return { kind: "down" };
  // Settled means the four fetches answered; `ready` means the answers are
  // final. Before `ready` every number below is a lower bound with nothing on
  // screen to say so, so the popout stays quiet rather than asserting either
  // an empty corpus or a $0.00 day.
  if (!input.settled || input.ready !== true) return { kind: "loading" };
  if (corpusIsEmpty(input.ready, input.hasData)) return { kind: "no-data" };

  const tile = activeBlockTileState(
    input.block,
    input.usageWindow,
    input.usageConnected,
    input.now,
  );

  const todayText = `$${input.todayCost.toFixed(2)}`;
  const todayTokensText = `${abbreviate(input.todayTokens)} tok`;
  const weeklyPct = freshPct(input.weeklyWindow, input.usageConnected, input.now);
  const modelRow =
    input.modelWindow === null || !input.showModelLimit
      ? null
      : {
          label: `${input.modelWindow.model} limit`,
          pct: freshPct(input.modelWindow, input.usageConnected, input.now),
        };
  // The Live tile's "known zeroes" shell (connected, no block, no usable
  // sample) has no compact reading at this size — the popout's idle inset
  // covers it, exactly like the disconnected empty-inset case.
  const bare = tile.kind === "empty-inset" || (tile.active === null && tile.accountWindow === null);
  if (bare) {
    return {
      kind: "dash",
      head: { kind: "idle" },
      limitPct: tile.kind === "tile" ? tile.limitPct : null,
      weeklyPct,
      modelRow,
      todayText,
      todayTokensText,
    };
  }

  const active = tile.active;
  const startMs = active?.startMs ?? tile.accountWindow?.startMs ?? input.now;
  const endMs = active?.endMs ?? tile.accountWindow?.endMs ?? input.now;
  const head: PopoutHead = {
    kind: "ring",
    ringFrac: tile.ringFrac,
    centerLabel: tile.ringCenterLabel,
    costText: active !== null ? `$${active.block.costUSD.toFixed(2)}` : "$0.00",
    tokensText: `${abbreviate(active?.block.totalTokens ?? 0)} tok`,
    metaText: `${formatElapsed(input.now - startMs)} · resets ${formatWallClock(endMs, input.display)}`,
  };

  return {
    kind: "dash",
    head,
    limitPct: tile.limitPct,
    weeklyPct,
    modelRow,
    todayText,
    todayTokensText,
  };
}

// A limit row's reading under the ADR-0030 rule the 5-hour row already obeys:
// a connected reading whose reset is still ahead, rounded like the tiles;
// anything else is null (the em-dash), never a stale percent.
function freshPct(window: UsageWindow | null, connected: boolean, now: number): number | null {
  const ring = usageRingState(connected ? window : null, now);
  return ring.kind === "limit" && window !== null ? Math.round(window.utilizationPct) : null;
}

// "3h 18m" / "42m" — time into the block (the ActiveBlockTile's format, sans
// the word "elapsed" per the T3 head contract).
function formatElapsed(ms: number): string {
  const totalMin = Math.max(0, Math.floor(ms / 60_000));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
