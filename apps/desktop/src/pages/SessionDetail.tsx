import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Check, Copy } from "lucide-react";
import {
  deriveProjectPath,
  formatAbsoluteTimestamp,
  formatRelativeTime,
  type CostMode,
  type TimeDisplay,
} from "@maxprice/shared";
import { useFilters, type Metric } from "@/state/filters";
import { useSettings, useTimeDisplay } from "@/state/use-settings";
import { useNowTick } from "@/state/use-now-tick";
import { useSessionEvents, type SessionEventsData } from "@/state/use-session-events";
import { useSessionRow } from "@/state/use-session-row";
import { useMachineAxis, type MachineAxis } from "@/state/use-machine-axis";
import { foldMachineIdList } from "@/lib/machines";
import { MachineChip } from "@/components/machine-chip";
import { ModelSplitBar } from "@/components/model-split-bar";
import { SessionTimeline } from "@/components/session-timeline";
import { StripIdentity, StripStat } from "@/components/detail-strip";
import { formatCost } from "@/lib/list-format";
import { abbreviate } from "@/lib/active-block";
import { cn } from "@/lib/utils";

// M5 — the standalone /sessions/:id page wearing Glass (T6 `lens`,
// session-detail-glass.html + NOTES §Session detail). The back navigation
// lives in the topbar's back chip (Topbar's SessionHeading); the old
// SessionHeader + KeyValueGrid + split Card fuse into ONE summary strip
// panel; the timeline is the lens panel in `session-timeline.tsx`. The data
// path is untouched: NDJSON streaming via `useSessionEvents` (ADR-0012 frame
// order), cost-mode / filter changes re-key and re-stream.

// The strip's relative timestamps age while the page is open; 30s is plenty
// for a minute-granularity label.
const NOW_TICK_MS = 30_000;

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function SessionDetailPage(): React.ReactElement {
  const { id } = useParams<{ id: string }>();
  // Cost mode is durable settings (settings.json, ADR-0014); a change re-keys
  // `useSessionEvents` and re-streams. The session-events NDJSON endpoint is
  // per-event and carries no `tz` param, so `mode` and the model filter flow
  // through here.
  const { data: settings } = useSettings();
  const costMode = settings?.costMode ?? "auto";
  // The rail's model filter narrows the timeline + totals (ADR-0017): only
  // matching messages stream, and the summary covers exactly those.
  const models = useFilters((s) => s.models);
  // The rail's machine filter narrows the same way (ADR-0041 M6) — the axis
  // supplies alias-expanded machine= params and the em-dash-vs-chips gate.
  const machineAxis = useMachineAxis();
  // Cost vs tokens toggle for the per-model split bar — page-local, not a
  // persisted filter (it only affects this one bar).
  const [splitMetric, setSplitMetric] = useState<Metric>("cost");

  const sessionId = id ?? "";
  const query = useSessionEvents(sessionId, costMode, models, machineAxis.machineParams);
  const data: SessionEventsData | undefined = query.data;

  // Arrival flash (T6): a re-stream (SSE invalidation) fully rebuilds the
  // timeline; rows beyond the PREVIOUS settled count are genuinely new and
  // enter on the arrive rise + accent flash. The first pour of a key has no
  // settled baseline, so nothing flashes; a key change (cost mode / filters /
  // another session) resets the baseline the same way.
  const streamIdentity = [
    sessionId,
    costMode,
    models.join("\0"),
    machineAxis.machineParams.join("\0"),
  ].join("|");
  const settledCount = useRef<number | null>(null);
  const [freshFrom, setFreshFrom] = useState<number | null>(null);
  const prevIdentity = useRef(streamIdentity);
  if (prevIdentity.current !== streamIdentity) {
    prevIdentity.current = streamIdentity;
    settledCount.current = null;
    if (freshFrom !== null) setFreshFrom(null);
  }
  const wasFetching = useRef(false);
  useEffect(() => {
    if (query.isFetching && !wasFetching.current) {
      // A stream (re)opened — everything past the last settle is fresh.
      setFreshFrom(settledCount.current);
    }
    if (!query.isFetching && wasFetching.current) {
      settledCount.current = data?.events.length ?? 0;
    }
    wasFetching.current = query.isFetching;
  }, [query.isFetching, data]);
  // Drop the fresh marker shortly after settle: the 900ms arrive animation is
  // done, and a lingering class would replay it when virtualization remounts
  // a scrolled-away row.
  useEffect(() => {
    if (query.isFetching || freshFrom === null) return;
    const t = setTimeout(() => setFreshFrom(null), 1500);
    return () => clearTimeout(t);
  }, [query.isFetching, freshFrom]);

  // A failed *request* — one that never reached the summary frame — is a
  // full-page error. A mid-stream `error` frame that arrives AFTER a summary
  // is instead a partial-failure warn inset (rendered inside SessionContent)
  // so the rows that did stream in are kept.
  const requestFailed =
    query.isError || (data !== undefined && data.summary === null && data.error !== null);

  return (
    <div className="flex flex-col gap-[18px]">
      {requestFailed ? (
        <ErrorState
          message={data?.error ?? (query.error as Error | undefined)?.message ?? "Request failed."}
        />
      ) : data === undefined ? (
        <LoadingSkeleton />
      ) : data.summary && data.summary.eventCount === 0 ? (
        <EmptyState
          sessionId={sessionId}
          filtered={models.length > 0 || machineAxis.machineParams.length > 0}
        />
      ) : (
        <SessionContent
          sessionId={sessionId}
          data={data}
          costMode={costMode}
          machineAxis={machineAxis}
          splitMetric={splitMetric}
          onSplitMetricChange={setSplitMetric}
          streaming={query.isFetching}
          freshFrom={freshFrom}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Loaded content
// ---------------------------------------------------------------------------

function SessionContent({
  sessionId,
  data,
  costMode,
  machineAxis,
  splitMetric,
  onSplitMetricChange,
  streaming,
  freshFrom,
}: {
  sessionId: string;
  data: SessionEventsData;
  costMode: CostMode;
  machineAxis: MachineAxis;
  splitMetric: Metric;
  onSplitMetricChange: (m: Metric) => void;
  streaming: boolean;
  freshFrom: number | null;
}): React.ReactElement {
  const { summary, events, error } = data;
  const now = useNowTick(NOW_TICK_MS);
  // first / last activity are not in the summary frame — derive them from the
  // streamed event frames. They update as more events arrive.
  const first = events[0]?.timestamp ?? null;
  const last = events.at(-1)?.timestamp ?? null;

  // An all-zero timeline in `display` mode is correct, not a bug — current
  // Claude Code omits the JSONL cost field. Surface a gentle hint.
  const allZeroCost =
    costMode === "display" && events.length > 0 && events.every((e) => e.cost === 0);

  return (
    <>
      <SummaryStrip
        sessionId={sessionId}
        data={data}
        first={first}
        last={last}
        now={now}
        machineAxis={machineAxis}
        splitMetric={splitMetric}
        onSplitMetricChange={onSplitMetricChange}
      />

      {/* A mid-stream `error` frame after a valid summary: keep the streamed
          rows, surface the failure as a warn inset ABOVE them. */}
      {error !== null ? (
        <div className="inset warn" role="alert">
          <p>
            <span className="lead">The event stream ended early</span> — this timeline may be
            incomplete. <span className="num">{error}</span>
          </p>
        </div>
      ) : null}

      {allZeroCost ? (
        <div className="inset">
          <p>
            All events read <b>$0.00</b> — this session has no stored cost. Switch the cost mode to{" "}
            <b style={{ color: "var(--accent)" }}>calculate</b> in the topbar to price tokens.
          </p>
        </div>
      ) : null}

      <SessionTimeline
        events={events}
        totalEvents={summary?.eventCount ?? null}
        streaming={streaming}
        freshFrom={freshFrom}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// The summary strip — SessionHeader + KeyValueGrid + the split Card, fused
// into ONE glass panel wearing the lists family's two-row layout (T6).
// ---------------------------------------------------------------------------

function SummaryStrip({
  sessionId,
  data,
  first,
  last,
  now,
  machineAxis,
  splitMetric,
  onSplitMetricChange,
}: {
  sessionId: string;
  data: SessionEventsData;
  first: string | null;
  last: string | null;
  now: number;
  machineAxis: MachineAxis;
  splitMetric: Metric;
  onSplitMetricChange: (m: Metric) => void;
}): React.ReactElement {
  const { summary } = data;
  // The project path comes from the session's /api/sessions row (frozen wire:
  // the summary frame carries no path) — absent on a deep link outside the
  // rail's range, in which case the line is just the projects link.
  const row = useSessionRow(sessionId);
  const display = useTimeDisplay();

  const [copied, setCopied] = useState(false);
  // The copy-confirmation timer must be cleared on unmount so navigating away
  // mid-confirmation can't call setState on an unmounted component.
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(copyTimer.current), []);

  const copyUuid = (): void => {
    void navigator.clipboard?.writeText(sessionId);
    setCopied(true);
    clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopied(false), 1200);
  };

  return (
    <section className="panel strip" aria-label="Session summary">
      <StripIdentity title={sessionId.slice(0, 8)}>
        <button
          type="button"
          onClick={copyUuid}
          className="copy-btn num"
          title="Copy full session id"
        >
          <span className="trunc">{sessionId}</span>
          {copied ? <Check aria-hidden className="ok" /> : <Copy aria-hidden />}
        </button>
        {/* Flex so a long project path truncates while the link stays — a
            plain ellipsis span would swallow "View projects →" whole. */}
        <span className="sub flex min-w-0 items-center gap-1.5">
          {row ? (
            <>
              <span className="num min-w-0 truncate">{deriveProjectPath(row.path)}</span>
              <span aria-hidden>·</span>
            </>
          ) : null}
          <Link to="/projects" className="shrink-0">
            View projects →
          </Link>
        </span>
      </StripIdentity>

      <StripStat label="first event">
        <TimeValue iso={first} now={now} display={display} />
      </StripStat>
      <StripStat label="last event">
        <TimeValue iso={last} now={now} display={display} />
      </StripStat>
      <StripStat label="events">
        {summary ? <span className="num">{summary.eventCount.toLocaleString()}</span> : <Dash />}
      </StripStat>
      {/* The machine attribution stat (ADR-0041 M6) — chips for the summary's
          full alias-folded machine set; present ONLY while the axis is
          enabled, em-dash until the summary frame arrives. */}
      {machineAxis.enabled ? (
        <StripStat label="machine">
          {summary && summary.machines.length > 0 ? (
            <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
              {foldMachineIdList(summary.machines, machineAxis.directory).map((mid) => (
                <MachineChip key={mid} id={mid} machineAxis={machineAxis} />
              ))}
            </span>
          ) : (
            <Dash />
          )}
        </StripStat>
      ) : null}
      <StripStat label="total cost">
        {summary ? <span className="num">{formatCost(summary.totalCost)}</span> : <Dash />}
      </StripStat>
      <StripStat label="total tokens">
        {summary ? <span className="num">{abbreviate(summary.totalTokens)}</span> : <Dash />}
      </StripStat>

      {/* Row 2: the per-model split pinned full-width below, with the
          page-local cost/tokens seg (T6). */}
      <div className="flex w-full min-w-0 flex-col gap-1.5">
        <div className="flex items-center gap-3">
          <span className="eyebrow text-[10px] tracking-[0.08em] whitespace-nowrap">
            Per-model split
          </span>
          <div className="seg seg-mini" role="group" aria-label="Split metric">
            {(["cost", "tokens"] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => onSplitMetricChange(m)}
                aria-pressed={m === splitMetric}
                className={cn(m === splitMetric && "active")}
              >
                {m}
              </button>
            ))}
          </div>
        </div>
        {summary && summary.modelBreakdowns.length > 0 ? (
          <ModelSplitBar
            breakdowns={summary.modelBreakdowns}
            size="md"
            showLegend
            metric={splitMetric}
          />
        ) : (
          // The empty track while the summary is still in flight — the strip
          // never reflows when the real bar lands.
          <div className="splitbar" aria-hidden />
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Small helpers + states
// ---------------------------------------------------------------------------

function Dash(): React.ReactElement {
  return <span className="dash">—</span>;
}

// Relative time with the absolute timestamp in a tooltip. `now` is threaded in
// from a `useNowTick` subscription so the label ages instead of freezing.
//
// The tooltip used to be the raw ISO string — i.e. UTC. Since the visible label
// is relative ("3h ago"), that tooltip is the ONLY absolute reading this surface
// offers, and answering it in UTC hands the user arithmetic to do. ADR-0060
// renders it in the Settings timezone and the chosen format instead.
function TimeValue({
  iso,
  now,
  display,
}: {
  iso: string | null;
  now: number;
  display: TimeDisplay;
}): React.ReactElement {
  if (iso === null) return <Dash />;
  return (
    <span className="num" title={formatAbsoluteTimestamp(iso, display)}>
      {formatRelativeTime(iso, now)}
    </span>
  );
}

// Skeleton — flat tint blocks pulsing at the system cadence, never a frosted
// shimmer (T6). Shaped like the strip + timeline panels so settling doesn't
// shift the layout.
function LoadingSkeleton(): React.ReactElement {
  return (
    <div className="flex flex-col gap-[18px]" aria-busy="true" aria-label="Loading session">
      <section className="panel strip">
        <div className="skel w-full max-w-[420px]">
          <i style={{ width: "38%", height: 14 }} />
          <i style={{ width: "64%" }} />
          <i style={{ width: "52%" }} />
        </div>
      </section>
      <section className="panel table-panel">
        <div className="skel m-[18px]">
          <i style={{ height: 42, borderRadius: 10 }} />
          <i style={{ height: 42, borderRadius: 10 }} />
          <i style={{ height: 42, borderRadius: 10 }} />
        </div>
      </section>
    </div>
  );
}

// A zero-event summary has two distinct causes. With no filter active it is a
// genuinely empty session (brand-new, or no assistant turns yet). With a model
// (ADR-0017) or machine (ADR-0041 M6) filter active the session HAS events —
// they just don't match the selection; the empty-session copy would misdirect,
// so branch it. Both wear the dashed neutral inset (T6: dashing marks absence,
// never a status tint).
function EmptyState({
  sessionId,
  filtered,
}: {
  sessionId: string;
  filtered: boolean;
}): React.ReactElement {
  return (
    <div className="inset dashed">
      {filtered ? (
        <>
          <p className="lead">No events match the current filters</p>
          <p>
            Session <span className="num break-all">{sessionId}</span> has events, but none match
            the model or machine filters in the filter rail. Clear them to see the full timeline.
          </p>
        </>
      ) : (
        <>
          <p className="lead">No usage events</p>
          <p>
            Session <span className="num break-all">{sessionId}</span> has no recorded usage events.
            It may be a brand-new session, or one with no assistant turns yet.
          </p>
        </>
      )}
    </div>
  );
}

// A failed request (no summary frame ever arrived) replaces the whole content
// column with the danger inset (T6).
function ErrorState({ message }: { message: string }): React.ReactElement {
  return (
    <div className="inset danger" role="alert">
      <p className="lead">Could not load the timeline</p>
      <p className="num break-words">{message}</p>
    </div>
  );
}
