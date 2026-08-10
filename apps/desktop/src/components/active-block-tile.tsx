import { formatWallClock, type BlockRow, type TimeDisplay } from "@maxprice/shared";
import { abbreviate, formatRange } from "@/lib/active-block";
import {
  activeBlockTileState,
  ringStrokeDasharray,
  type ActiveBlockTileState,
} from "@/lib/active-block-tile-state";
import { UsageExpiredHint } from "@/components/usage-expired-hint";
import { useLiveStatus } from "@/state/use-live-status";
import { useNowTick } from "@/state/use-now-tick";
import { useTimeDisplay } from "@/state/use-settings";
import { useUsageCurrent } from "@/state/use-usage-current";
import { useBump } from "@/state/use-bump";
import { cn } from "@/lib/utils";

export type ActiveBlockTileProps = {
  block: BlockRow | null;
  // The "typical" block — median tokens across the range's completed blocks
  // (see typicalBlockTokens). Shown in the tile's foot as the reference.
  typicalBlockTokens: number;
};

// The Active Block tile (glass.html): the 100px elapsed ring and the 5-hour
// limit meter wear the Aurora --accent-a → --accent-b gradient — the glass
// system's glow, earned by a live reset window (the This-week tile's weekly
// meter wears it too; settled blocks' meters stay flat). The ring's arc tracks
// time elapsed and its center counts H:MM down to the reset; the meter tracks
// the real polled limit; window chip, elapsed /
// resets meta, and the projection foot carry the rest. Same quantities as
// before the reskin (burn rate excepted — the mock retires it from the tile;
// it lives on in /blocks), relocated per the mock.
export function ActiveBlockTile({
  block,
  typicalBlockTokens,
}: ActiveBlockTileProps): React.ReactElement {
  // 1Hz tick so the ring, meter and meta advance every second, independent of
  // the SSE pipeline (Part 3); the 900ms linear transitions turn the steps
  // into a continuous crawl.
  const now = useNowTick(1000);
  // The Settings timezone formats the window range in the user's zone, matching
  // the day the engine bucketed into; the timeFormat decides 24h vs AM/PM
  // (ADR-0060). Both arrive together as one TimeDisplay.
  const display = useTimeDisplay();
  const { data: usage } = useUsageCurrent();
  const usageConnection = useLiveStatus((s) => s.usageConnection);
  const tileState = activeBlockTileState(
    block,
    usage?.sample?.fiveHour ?? null,
    usageConnection === "connected",
    now,
  );
  const valueText = tileState.kind === "tile" ? tileValueText(tileState) : "—";
  const bumping = useBump(valueText);

  // Without a live usage connection there is no account-level reading to
  // distinguish idle from unavailable, so retain the explicit empty inset.
  // A connected account with no local block keeps the tile shell: a future
  // reset shows the provisional account window, while an expired or absent
  // reading renders known zeroes below.
  if (tileState.kind === "empty-inset") {
    return (
      <div className="tile panel">
        <span className="eyebrow">Active block</span>
        <div className="inset dashed my-auto">
          <p>No active block — start a Claude Code session to open one.</p>
        </div>
        {usageConnection === "expired" ? <UsageExpiredHint /> : null}
      </div>
    );
  }

  return (
    <ActiveBlockTileContent
      state={tileState}
      typicalBlockTokens={typicalBlockTokens}
      now={now}
      display={display}
      bumping={bumping}
      usageExpired={usageConnection === "expired"}
    />
  );
}

type TileState = Extract<ActiveBlockTileState, { kind: "tile" }>;

export type ActiveBlockTileContentProps = {
  state: TileState;
  typicalBlockTokens: number;
  now: number;
  display: TimeDisplay;
  bumping: boolean;
  usageExpired: boolean;
};

// Pure rendering seam for the two sources of active-block presentation: a
// local event-derived block, or a reset-only account window before its first
// event. Keeping both in one composition prevents provisional state from
// silently dropping rows that the event-backed state renders.
export function ActiveBlockTileContent({
  state,
  typicalBlockTokens,
  now,
  display,
  bumping,
  usageExpired,
}: ActiveBlockTileContentProps): React.ReactElement {
  const { accountWindow, active, limitPct, ringCenterLabel, ringFrac } = state;
  const valueText = tileValueText(state);
  const ringDasharray = ringStrokeDasharray(ringFrac);
  const tileStartMs = active?.startMs ?? accountWindow?.startMs ?? null;
  const tileEndMs = active?.endMs ?? accountWindow?.endMs ?? null;

  return (
    <div className="tile panel block-tile">
      <div className="ring-wrap">
        <svg
          viewBox="0 0 96 96"
          aria-label={
            active
              ? `Block time elapsed: ${Math.round(active.elapsedFrac * 100)}%`
              : accountWindow
                ? `Block time elapsed: ${Math.round(ringFrac * 100)}%`
                : "No active block"
          }
        >
          <defs>
            <linearGradient id="ringGrad" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" className="stop-a" />
              <stop offset="1" className="stop-b" />
            </linearGradient>
          </defs>
          <circle className="ring-track" cx="48" cy="48" r="40" />
          {ringDasharray === null ? null : (
            <circle
              className="ring-fill"
              cx="48"
              cy="48"
              r="40"
              strokeDasharray={ringDasharray}
              transform="rotate(-90 48 48)"
            />
          )}
        </svg>
        <span className="ring-label">
          {ringCenterLabel !== null ? (
            <>
              <b className="num">{ringCenterLabel}</b>
              <small>to reset</small>
            </>
          ) : (
            <b className="num">—</b>
          )}
        </span>
      </div>
      <div className="block-body">
        <div className="block-head">
          <span className="eyebrow">Active block</span>
          {tileStartMs !== null && tileEndMs !== null ? (
            <span className="window-chip num">{windowChip(tileStartMs, tileEndMs, display)}</span>
          ) : null}
        </div>
        <div className="block-value-row">
          <span className={cn("value num", bumping && "bump")}>{valueText}</span>
          {tileStartMs !== null && tileEndMs !== null ? (
            <span className="block-meta num">
              {formatElapsed(now - tileStartMs)} elapsed · resets{" "}
              {formatWallClock(tileEndMs, display)}
            </span>
          ) : null}
        </div>
        {limitPct !== null ? (
          <div className="limit-row">
            <label>5-hour limit used</label>
            <span
              className="limit-meter"
              role="meter"
              aria-valuenow={limitPct}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label="5-hour limit used"
            >
              <i style={{ width: `${limitPct}%` }} />
            </span>
            <b className="num">{limitPct}%</b>
          </div>
        ) : null}
        {active !== null || accountWindow !== null ? (
          <div className="block-foot num">
            <b>
              {active
                ? active.block.projection
                  ? `$${active.block.projection.totalCost.toFixed(2)}`
                  : "—"
                : "$0.00"}
            </b>{" "}
            projected · <b>{active ? abbreviate(active.block.totalTokens) : "0"}</b> tokens vs
            typical <b>{typicalBlockTokens > 0 ? abbreviate(typicalBlockTokens) : "—"}</b>
          </div>
        ) : null}
        {usageExpired ? <UsageExpiredHint /> : null}
      </div>
    </div>
  );
}

function tileValueText(state: TileState): string {
  if (state.active) return `$${state.active.block.costUSD.toFixed(2)}`;
  return state.accountWindow ? "$0.00" : "—";
}

// "14:00 → 19:00 (5h)" / "2:00 PM → 7:00 PM (5h)" — the block window chip.
function windowChip(startMs: number, endMs: number, display: TimeDisplay): string {
  const hours = Math.round((endMs - startMs) / 3_600_000);
  return `${formatRange(startMs, endMs, display).replace(" – ", " → ")} (${hours}h)`;
}

// "3h 12m" / "42m" — elapsed time within the block.
function formatElapsed(ms: number): string {
  const totalMin = Math.max(0, Math.floor(ms / 60_000));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
