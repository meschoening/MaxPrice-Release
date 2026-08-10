import type { BootProgress } from "@maxprice/shared";

// The boot splash's progress model (ADR-0067, amending ADR-0047 and the NOTES
// §Boot splash contract that forbade progress numbers).
//
// The splash reports four steps. Only ONE of them is measured by the sidecar —
// the corpus scan, whose file counts ride `bootProgress` on the status frame.
// The other three are renderer-side facts that never needed a wire:
//
//   engine  we have not heard from the sidecar yet (no status frame). Covers
//           the Rust shell's spawn, the port handshake, and the SSE connect —
//           indistinguishable from here, and not worth three steps that are
//           each over in single-digit milliseconds on a healthy launch.
//   scan    the sidecar's own `scanning` phase, with real files-parsed counts.
//   fleet   the sidecar's `merging` phase — the fleet replica load (ADR-0041).
//           Present only when there is a replica to load, which the sidecar
//           declares on the FIRST frame so the list never changes shape.
//   paint   ADR-0066's second stage: `ready` has landed and we are waiting for
//           Live to report itself drawn.
//
// Nothing here is smoothed, eased, or extrapolated. A step contributes its full
// weight or nothing (scan alone contributes a fraction, because a fraction is
// what it actually knows), so a wedged boot parks the bar at a number that says
// where it wedged. That honesty is the entire justification for the wire change
// — a bar that keeps creeping while nothing happens is worse than no bar.

export type BootStepKey = "engine" | "scan" | "fleet" | "paint";
export type BootStepState = "done" | "active" | "pending";

export type BootStepView = {
  key: BootStepKey;
  // The breadcrumb's label. Short because the long name is already in the stat
  // line directly above it, and repeating it makes the row wider than the bar.
  short: string;
  state: BootStepState;
};

export type BootProgressView = {
  // 0–1, and 0–100 rounded. Both, because the bar wants the ratio and the
  // readout wants the integer, and rounding twice from different places is how
  // a bar and its label end up disagreeing.
  overall: number;
  percent: number;
  // The active step's full name, for the stat line.
  activeName: string;
  // The active step's live count, or null when it has none to give. Only the
  // scan has one — this is where the "live counts" half of the contract lives.
  count: string | null;
  steps: BootStepView[];
};

export type BootProgressInput = {
  // The live store's `ready`: `null` until the first `status:changed` frame.
  // That null IS the "engine" step — it means no sidecar has spoken yet.
  ready: boolean | null;
  // The sidecar's boot progress, or null when the frame carried none.
  progress: BootProgress | null;
  // ADR-0066's first-paint latch.
  paintSettled: boolean;
  // The splash has begun fading. Terminal by definition: the gate is open, so
  // whatever we were waiting for we are no longer waiting for. Without this a
  // reveal forced by BOOT_PAINT_CEILING_MS would fade the bar out at 78%,
  // which reads as a crash rather than as the deadlock breaker doing its job.
  revealing: boolean;
};

// Relative share of the bar. These are honest orders of magnitude, not measured
// ratios: on the cold boot this feature exists for, the scan dominates by an
// order of magnitude and the paint hold is the only other visible wait. They
// renormalize when the fleet step is absent, so a hub-less boot still spans
// 0→100 with no dead zone at the end.
const WEIGHTS: Record<BootStepKey, number> = {
  engine: 8,
  scan: 62,
  fleet: 8,
  paint: 22,
};

const SHORT: Record<BootStepKey, string> = {
  engine: "Engine",
  scan: "Files",
  fleet: "Fleet",
  paint: "Renderer",
};

function longName(key: BootStepKey, progress: BootProgress | null): string {
  switch (key) {
    case "engine":
      return "Starting the engine";
    case "scan":
      // Before the walk has enumerated anything there is no denominator, and
      // "reading" would be a claim about work that hasn't started. The same
      // wording covers a genuinely empty corpus, which is over so fast nobody
      // reads it.
      return progress !== null && progress.filesTotal > 0
        ? "Reading session files"
        : "Finding session files";
    case "fleet":
      return "Merging fleet history";
    case "paint":
      return "Rendering your usage";
  }
}

// One step's completion, 0–1. Only `scan` is ever strictly between.
function fraction(key: BootStepKey, input: BootProgressInput): number {
  const { ready, progress, paintSettled } = input;
  switch (key) {
    case "engine":
      return ready === null ? 0 : 1;
    case "scan": {
      if (progress === null) return 0;
      if (progress.phase !== "scanning") return 1;
      if (progress.filesTotal === 0) return 0;
      // Clamped: a count that outran its denominator (it cannot today, but a
      // future producer bug would) must not push the bar past its own step.
      return Math.min(1, progress.filesParsed / progress.filesTotal);
    }
    case "fleet":
      return progress !== null && progress.phase === "done" ? 1 : 0;
    case "paint":
      return ready === true && paintSettled ? 1 : 0;
  }
}

// The whole splash view, or `null` when the renderer must not draw a bar at all.
//
// That null case is the version-skew degrade, and it is deliberate: a sidecar
// old enough to send status frames without `bootProgress` gives us no way to
// tell a long scan from a wedged one, and the honest rendering of "I don't
// know" is ADR-0047's indeterminate splash — the composition that shipped —
// not a bar frozen at the engine step's 8%. `BootSplash` falls back to the
// quiet line when this returns null.
export function bootProgressView(input: BootProgressInput): BootProgressView | null {
  const handshook = input.ready !== null;
  if (handshook && input.progress === null) return null;

  const keys: BootStepKey[] = ["engine", "scan"];
  // The fleet step exists only where a replica does. Read off the sidecar's own
  // declaration rather than guessed from `hubConnection`, which is a live
  // connection state and can be `connecting` for the whole boot.
  if (input.progress?.mergesFleet === true) keys.push("fleet");
  keys.push("paint");

  const totalWeight = keys.reduce((sum, k) => sum + WEIGHTS[k], 0);

  let overall = 0;
  let active: BootStepKey | null = null;
  const steps: BootStepView[] = keys.map((key) => {
    const f = input.revealing ? 1 : fraction(key, input);
    overall += (WEIGHTS[key] / totalWeight) * f;
    // The first incomplete step is the active one; everything after it is
    // pending even if it somehow reports progress. Steps are sequential — the
    // scan cannot start before the sidecar answers, the replica load cannot
    // start before the scan ends — and a breadcrumb that lights two rows at
    // once is describing a boot that is not happening.
    let state: BootStepState = "pending";
    // Parsing the last file produces a legitimate 1.0 fraction before the
    // sidecar has ingested the parsed records into the event store. The phase,
    // not the fraction, owns that terminal edge; keep Files active through the
    // ingestion pass so Renderer/Fleet never claims work that has not started.
    const done =
      input.revealing || (f >= 1 && !(key === "scan" && input.progress?.phase === "scanning"));
    if (done) state = "done";
    else if (active === null) {
      state = "active";
      active = key;
    }
    return { key, short: SHORT[key], state };
  });

  // Everything done ⇒ the last step is what we name. The splash is about to go.
  const activeKey: BootStepKey = active ?? (keys[keys.length - 1] as BootStepKey);

  return {
    overall,
    percent: Math.round(overall * 100),
    activeName: longName(activeKey, input.progress),
    count: activeKey === "scan" ? scanCount(input.progress) : null,
    steps,
  };
}

function scanCount(progress: BootProgress | null): string | null {
  if (progress === null || progress.filesTotal === 0) return null;
  return `${progress.filesParsed.toLocaleString()} / ${progress.filesTotal.toLocaleString()} files`;
}

// The payoff of having steps at all: when a boot fails or times out, the error
// card can name WHERE it stopped instead of only that it did. Returns null when
// there is nothing better to say than the technical reason already on the card.
export function bootStoppedWhere(view: BootProgressView | null): string | null {
  if (view === null) return null;
  // No active step means every step completed — a boot that got all the way
  // through has nothing to blame, and the card's own copy is the whole story.
  if (!view.steps.some((s) => s.state === "active")) return null;
  // `activeName` / `count` verbatim off the view, never recomputed: the card
  // and the stat line above it must never name different steps for one instant.
  const name = view.activeName.toLowerCase();
  return view.count !== null ? `Stopped while ${name} — ${view.count}.` : `Stopped while ${name}.`;
}
