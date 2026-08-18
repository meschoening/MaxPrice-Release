import { Link } from "react-router-dom";
import { useLiveStatus } from "@/state/use-live-status";
import { useNowTick } from "@/state/use-now-tick";
import { footHasLines, hubFootLine, saturationFootLine, usageFootLine } from "@/lib/foot-status";
import { isStale } from "@/lib/stale-status";
import { cn } from "@/lib/utils";

// The pipeline diagnostics, driven entirely by the live-status store (Part 3).
// M2 relocated this block from the old bottom status bar to the glass
// sidebar's foot (the mock world has no status-bar surface).
//
// The foot carries the two connections the app depends on and the topbar
// refresh pill says nothing about: claude.ai (where the limits come from) and
// the hub (who is polling them) — each drawn only while it has something to
// say, so a machine with no key or no hub carries no permanent reminder of a
// feature it doesn't use. Above them sits the episodic "engine catching up"
// line, present only while the sidecar reports a saturated event loop.
// The `pricing fresh · LiteLLM` and `engine v…` lines were static facts and
// moved to Settings › App info (map #100), as did the identity row's version
// chip. `sidecar online` followed them on 2026-08-01 — not because it stopped
// being live, but because the topbar refresh pill already reports the same
// channel on every page ("offline" / "reconnecting…") and the Live badge says
// it a third time.
//
// All three lines are mirrors of sidecar-owned state, so all three are subject
// to the stale rule in `lib/stale-status`: with the SSE channel gone the two
// connection lines go soft rather than keep asserting a reading no one has
// confirmed since it dropped, and the saturation line — whose mere presence IS
// its assertion — hides outright.
//
// T11 (map #151, ADR-0073) made each line a MORPH ROW: a dot plus a clipped
// label, so the collapsed rail's dot stack and the expanded foot's labelled
// lines are the SAME THREE NODES rather than two renderings of one state. That
// is why the collapse re-homes nothing and why everything above this comment
// runs exactly once, unchanged. Every row keeps its `title`, so a collapsed dot
// still says what it means on hover.
export function StatusBar() {
  const connectionState = useLiveStatus((s) => s.connectionState);
  const usageConnection = useLiveStatus((s) => s.usageConnection);
  const usageLastSampleAt = useLiveStatus((s) => s.usageLastSampleAt);
  const hubConnection = useLiveStatus((s) => s.hubConnection);
  // The last SETTLED hub state, feeding the sticky-connecting rule. Store-derived
  // rather than tracked here, so it carries the history from before this
  // component existed: BootGate withholds the frame until the engine is ready,
  // long after the sidecar started reporting hub state.
  const lastSettledHub = useLiveStatus((s) => s.lastSettledHubConnection);
  // Saturation verdict (issue #116 / F4) — the one global "your numbers may be
  // behind" surface, visible from every page. Verdict-only: the renderer never
  // re-derives it from the lag numbers.
  const saturated = useLiveStatus((s) => s.saturation?.saturated ?? false);
  // Coarse tick — the usage tooltip's "sampled Nm ago" only needs
  // minute-grained freshness.
  const now = useNowTick(60_000);

  const stale = isStale(connectionState);
  const usage = usageFootLine(usageConnection, usageLastSampleAt, now, stale);
  const hub = hubFootLine(hubConnection, lastSettledHub, stale);
  const showSaturation = saturationFootLine(saturated, stale);

  // Nothing to say — no claude.ai key, no hub, engine keeping up. Render no
  // separator either: a hairline over an empty box reads as a broken surface,
  // not a quiet one.
  if (!footHasLines(usage, hub, showSaturation)) return null;

  return (
    <div className="shrink-0">
      <div className="sep sb-footsep" aria-hidden />
      <div className="sb-footlines">
        {showSaturation && (
          <span
            className="sb-footrow text-warn"
            title="The engine's event loop is saturated — numbers may lag while it catches up."
          >
            <span aria-hidden className="dot warn pulse-anim" />
            <span className="sb-label">engine catching up</span>
          </span>
        )}
        {usage.kind === "expired" ? (
          // `text-warn`, deliberately NOT `usageConnectionTextClass(connection)`
          // — that helper returns red `text-bad` for `expired`, a divergence
          // scoped to the Settings status line (usage-status.ts:56-59). The
          // foot's expired line is amber, matching its own dot; only the dot
          // comes from the shared map.
          <Link to="/settings" className="sb-footrow text-warn" title={usage.title}>
            <span aria-hidden className={cn("dot", usage.variant)} />
            <span className="sb-label">Session expired</span>
          </Link>
        ) : usage.kind === "state" ? (
          <span className="sb-footrow" title={usage.title}>
            <span aria-hidden className={cn("dot", usage.variant)} />
            <span className="sb-label">claude.ai limits</span>
          </span>
        ) : null}
        {hub !== null && (
          <span className="sb-footrow" title={hub.title}>
            <span aria-hidden className={cn("dot", hub.variant)} />
            <span className="sb-label">Hub</span>
          </span>
        )}
      </div>
    </div>
  );
}
