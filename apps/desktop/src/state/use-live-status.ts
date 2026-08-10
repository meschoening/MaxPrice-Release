import { create } from "zustand";
import type {
  BootProgress,
  HubConnection,
  PricingStatus,
  StatusSnapshot,
  UsageConnection,
} from "@maxprice/shared";
import { nextSettledHub } from "@/lib/foot-status";

export type ConnectionState = "connected" | "reconnecting" | "disconnected";

export type LiveStatusState = {
  // SSE connection health — the single source for the status-bar dot, the
  // streaming pulse badge, and the refresh pill's warn state. No component
  // reads connection state from anywhere else.
  connectionState: ConnectionState;
  watchedPaths: string[];
  // Pricing provenance + last-attempt outcome (ADR-0053). `null` means the
  // renderer has no answer yet — either no `status:changed` frame has arrived,
  // or the frame carried no `pricing` at all (a stale sidecar binary, the case
  // the schema's `.optional()` exists for). Both render as "unknown", never as a
  // guessed timestamp; Settings' App info row owns that copy.
  pricing: PricingStatus | null;
  // Epoch-ms of the most recent usage:new event — drives the refresh pill.
  lastEventAt: number | null;
  engineVersion: string | null;
  // Whether the engine holds any usage events at all (range-independent).
  // `null` until the first `status:changed` frame; drives the first-launch
  // empty state (Task 6.5). The sidecar broadcasts a fresh frame the moment
  // the corpus goes from empty to non-empty, so this flips false→true live.
  hasData: boolean | null;
  // Boot readiness (ADR-0047): whether the sidecar's local engine sources
  // (initial scan + replica file load) have settled. `null` until the first
  // `status:changed` frame — the boot splash gate treats null and false alike
  // (not ready). Once true it never goes back: rescans are data updates, not
  // boots. The first-launch empty state must require `ready && !hasData` —
  // before `ready`, hasData:false only means the scan hasn't finished.
  ready: boolean | null;
  // What the boot is doing while `ready` is still false (ADR-0067) — the
  // splash's progress bar, step list, and live file counts. `null` means either
  // no frame has arrived yet (the "starting the engine" step) or the frame
  // carried no `bootProgress` at all (a pre-ADR-0067 sidecar), and the splash
  // tells those apart by whether `ready` is still null. Never cleared once the
  // boot finishes — it terminates at `phase: "done"` in the same frame `ready`
  // flips, and nothing reads it after that.
  // `BootProgress | null`, not `StatusSnapshot["bootProgress"]`: the wire field
  // is optional, and letting `undefined` through would give the store's "no
  // progress reported" state two spellings that consumers must both handle.
  bootProgress: BootProgress | null;
  // Terminal pre-ready sidecar failure (T4 boot splash): the Rust shell's
  // SidecarStatus::Failed message, recorded by live-stream when the URL
  // resolution fails hard before `ready` ever arrived. Cleared when a
  // connection opens. Only the boot splash's error card reads it — post-ready
  // connection loss is the StatusBar's story.
  bootFailure: string | null;
  // Usage-limits connection state (ADR-0023). Mirrors StatusSnapshot fields;
  // updated live on every `status:changed` frame (success AND failure) so the
  // Settings section and future status indicator always reflect the poller.
  usageConnection: UsageConnection;
  usageLastSampleAt: string | null;
  // Hub connection state (ADR-0035). `off` until a hub URL is configured.
  hubConnection: HubConnection;
  // The last SETTLED hub state (anything but `connecting`), feeding
  // foot-status' sticky rule. Derived in the store rather than in a component
  // ref so it is complete from the FIRST frame a consumer renders — StatusBar
  // mounts only after BootGate opens, by which time the sidecar may already
  // have cycled connecting/fallback several times. `off` IS recorded here; the
  // presenter decides what to do with it.
  lastSettledHubConnection: HubConnection | null;
  // Fleet replica seeding progress (ADR-0041 M6): non-null exactly while the
  // sidecar's pull loop drains from cursor 0. The Live subtitle and Settings
  // render clamp(cursor/target) — never event counts.
  hubSeed: StatusSnapshot["hubSeed"];
  // Pre-event-sync hub degrade (ADR-0041 M6) — Settings' amber line.
  hubEventsDegraded: boolean;
  // The local archive can't be written (ADR-0069) — Settings › Storage' amber
  // line. Absent lands as `false` for the `hubEventsDegraded` reason: a sidecar
  // that never reports the flag is not a sidecar reporting a fault.
  localArchiveDegraded: boolean;
  // Saturation self-report (issue #116 / F4): the sidecar-owned verdict that
  // its event loop is starved, with the Loop lag numbers behind it. `null`
  // means UNKNOWN (no frame yet, or a pre-F4 sidecar) — never healthy. The
  // renderer branches ONLY on `.saturated`; the trip threshold lives with the
  // sidecar's sampler.
  saturation: NonNullable<StatusSnapshot["saturation"]> | null;
  setConnectionState: (state: ConnectionState) => void;
  setBootFailure: (reason: string | null) => void;
  applyStatusSnapshot: (snapshot: StatusSnapshot) => void;
  markEvent: (at: number) => void;
};

// Ephemeral live-pipeline state. Deliberately NOT persisted (unlike useFilters)
// — connection health and event timing are meaningless across launches.
export const useLiveStatus = create<LiveStatusState>((set) => ({
  connectionState: "reconnecting",
  watchedPaths: [],
  pricing: null,
  lastEventAt: null,
  engineVersion: null,
  hasData: null,
  ready: null,
  bootProgress: null,
  bootFailure: null,
  usageConnection: "disconnected",
  usageLastSampleAt: null,
  hubConnection: "off",
  lastSettledHubConnection: null,
  hubSeed: null,
  hubEventsDegraded: false,
  localArchiveDegraded: false,
  saturation: null,
  setConnectionState: (state) => set({ connectionState: state }),
  setBootFailure: (reason) => set({ bootFailure: reason }),
  applyStatusSnapshot: (snapshot) =>
    set((s) => ({
      watchedPaths: snapshot.watchedPaths,
      // `?? null` for the same reason `hubEventsDegraded` has a fallback: the
      // field is optional on the wire, and absent must land as an explicit
      // "unknown" rather than `undefined` leaking into the store.
      pricing: snapshot.pricing ?? null,
      engineVersion: snapshot.engineVersion,
      hasData: snapshot.hasData,
      ready: snapshot.ready,
      // `?? null` for the reason `pricing` documents above: the field is
      // optional on the wire, and absent must land as an explicit "no progress
      // reported" — which the splash renders as ADR-0047's indeterminate
      // composition — rather than `undefined` leaking into the store.
      bootProgress: snapshot.bootProgress ?? null,
      usageConnection: snapshot.usageConnection,
      usageLastSampleAt: snapshot.usageLastSampleAt,
      hubConnection: snapshot.hubConnection,
      // The last SETTLED hub state, feeding foot-status' sticky rule. Derived
      // here rather than in a component ref so it is complete from the FIRST
      // frame — StatusBar mounts only after BootGate opens, by which time the
      // sidecar may already have cycled connecting/fallback several times.
      lastSettledHubConnection: nextSettledHub(s.lastSettledHubConnection, snapshot.hubConnection),
      hubSeed: snapshot.hubSeed,
      hubEventsDegraded: snapshot.hubEventsDegraded ?? false,
      localArchiveDegraded: snapshot.localArchiveDegraded ?? false,
      saturation: snapshot.saturation ?? null,
    })),
  markEvent: (at) => set({ lastEventAt: at }),
}));
