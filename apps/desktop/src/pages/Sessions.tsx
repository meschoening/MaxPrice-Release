import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Check, Copy } from "lucide-react";
import {
  deriveProjectName,
  deriveProjectPath,
  formatRelativeTime,
  parentProjectPath,
  type SessionRow,
} from "@maxprice/shared";
import { resolveDateRange, useFilters } from "@/state/filters";
import { useSettings } from "@/state/use-settings";
import { useSessions } from "@/state/use-sessions";
import { useMachineAxis } from "@/state/use-machine-axis";
import { useProjectAxis } from "@/state/use-project-axis";
import { useCorpusEmpty } from "@/state/use-corpus-empty";
import { useEscapeToDeselect } from "@/state/use-escape-deselect";
import { machineName } from "@/lib/machines";
import { EmptyState } from "@/components/EmptyState";
import { DataTable, type Column } from "@/components/data-table";
import { MachineChip } from "@/components/machine-chip";
import { StripPage } from "@/components/strip-page";
import { DetailStrip, StripIdentity, StripSection, StripStat } from "@/components/detail-strip";
import { ModelBadges } from "@/components/model-badges";
import { ModelSplitBar } from "@/components/model-split-bar";
import { useArrangement } from "@/state/use-arrangement";
import { costBarColumn } from "@/components/cost-bar";
import { aggregateSessions, type SessionsAggregate } from "@/lib/aggregate";
import { formatCost, RANGE_LABEL } from "@/lib/list-format";
import { abbreviate } from "@/lib/active-block";
import {
  selectedIdFromParams,
  withoutSelectedParam,
  withSelectedParam,
} from "@/lib/session-selection";

// Cache-hit share: cache-read tokens over all input-side tokens.
function cacheHitPct(s: SessionRow): number {
  const denom = s.inputTokens + s.cacheCreationTokens + s.cacheReadTokens;
  return denom === 0 ? 0 : (s.cacheReadTokens / denom) * 100;
}

// Stable row-id accessor. Hoisted to module scope so its identity never
// changes — DataTable's `processed` memo keys on `rowId`, so an inline arrow
// here would re-filter+re-sort every row on every render.
const sessionRowId = (s: SessionRow): string => s.sessionId;

// The project a session belongs to, which for a worktree session is the
// repository above it (ADR-0061). Derived from the session's own `path` — no
// project list needed, so this can never disagree with a row that hasn't loaded.
const sessionProjectName = (s: SessionRow): string => deriveProjectName(parentProjectPath(s.path));

export function SessionsPage(): React.ReactElement {
  const dateRange = useFilters((s) => s.dateRange);
  const { data: settings } = useSettings();
  const tz = settings?.timezone;
  // ADR-0062: closure-expanded across Repo identity before it reaches the wire —
  // a repo's sessions from every machine's checkout answer one selection.
  const projects = useProjectAxis().projectParams;
  const models = useFilters((s) => s.models);
  const machineAxis = useMachineAxis();
  const { since, until } = resolveDateRange(dateRange, tz);

  const query = useSessions({
    since,
    until,
    mode: settings?.costMode ?? "auto",
    tz,
    projects,
    models,
    machines: machineAxis.machineParams,
  });

  // Wide's cost bar (ADR-0073). Gated in JS, not by an @container rule, because
  // a column is a TypeScript object no stylesheet can reach — see
  // `state/use-arrangement.ts`. The scale is the range's largest session cost.
  const wide = useArrangement() === "wide";
  // Keyed on `query.data`, NOT on `query.data?.sessions ?? []`: the `?? []` mints
  // a fresh array every render, which would defeat the memo outright. `query.data`
  // is stable across equal refetches (TanStack structural sharing).
  const barMax = useMemo(
    () => (query.data?.sessions ?? []).reduce((m, s) => (s.totalCost > m ? s.totalCost : m), 0),
    [query.data],
  );

  // The Machine column (dot + resolved name) lands after Project, present ONLY
  // while the machine axis is enabled (ADR-0041 M6). Built as a memo so it can
  // read `machineAxis`; the static columns are unchanged from the pre-M6 const.
  const columns = useMemo<Column<SessionRow>[]>(
    () => [
      {
        id: "session",
        header: "Session",
        // minmax(0,…) lets the text columns shrink to fit the available width so
        // the grid never overflows its container — overflow is what clipped the
        // right columns and left their row background unpainted. Content
        // truncates instead.
        width: "minmax(0,2fr)",
        sortValue: (s: SessionRow) => s.sessionId,
        cell: (s: SessionRow) => (
          <span className="lead">
            <b>{s.sessionId.slice(0, 8)}</b>
            <small className="num">{s.sessionId}</small>
          </span>
        ),
      },
      {
        id: "project",
        header: "Project",
        width: "minmax(0,1.4fr)",
        // The PROJECT, not the directory: a session that ran in a worktree
        // reads as its repository (ADR-0061). Unfolded, this column showed the
        // worktree leaf — a row reading `t5-app-info`, naming neither the repo
        // nor anything a user would recognise as a project. Where the session
        // actually ran is still on the detail strip and the session page, both
        // of which print the full path.
        sortValue: (s: SessionRow) => sessionProjectName(s),
        cell: (s: SessionRow) => <span className="trunc">{sessionProjectName(s)}</span>,
      },
      ...(machineAxis.enabled
        ? [
            {
              id: "machine",
              header: "Machine",
              width: "minmax(0,110px)",
              sortValue: (s: SessionRow) => machineName(s.machineId, machineAxis.directory),
              cell: (s: SessionRow) => <MachineChip id={s.machineId} machineAxis={machineAxis} />,
            } satisfies Column<SessionRow>,
          ]
        : []),
      {
        id: "models",
        header: "Models",
        width: "minmax(96px,1fr)",
        sortValue: (s: SessionRow) => s.modelsUsed.join(","),
        cell: (s: SessionRow) => <ModelBadges models={s.modelsUsed} />,
      },
      {
        id: "tokens",
        header: "Tokens",
        numeric: true,
        width: "110px",
        sortValue: (s: SessionRow) => s.totalTokens,
        cell: (s: SessionRow) => abbreviate(s.totalTokens),
      },
      // Wide only, and immediately left of Cost so the drawing and its number
      // read as one lockup (ADR-0073).
      ...(wide ? [costBarColumn<SessionRow>({ max: barMax, get: (s) => s.totalCost })] : []),
      {
        id: "cost",
        header: "Cost",
        numeric: true,
        cellClass: "cost",
        width: "90px",
        sortValue: (s: SessionRow) => s.totalCost,
        cell: (s: SessionRow) => formatCost(s.totalCost),
      },
      {
        id: "lastActivity",
        header: "Last activity",
        numeric: true,
        cellClass: "softer",
        // Mock track (132px): the uppercase header + sort arrow need the room.
        width: "132px",
        sortValue: (s: SessionRow) => Date.parse(s.lastActivity) || 0,
        cell: (s: SessionRow) => (
          <span title={s.lastActivity}>{formatRelativeTime(s.lastActivity, Date.now())}</span>
        ),
      },
    ],
    [machineAxis, wide, barMax],
  );
  const rows = useMemo(() => query.data?.sessions ?? [], [query.data]);

  // Stable search-key accessor. `machineAxis` is a memoized object, so keying
  // the callback on it keeps identity stable exactly when it should — DataTable's
  // `processed` memo keys on `searchKeys` and would otherwise re-run every render.
  const searchKeys = useCallback(
    (s: SessionRow) => [
      s.sessionId,
      s.path,
      // Both names: the project the row now reads as, AND the directory it ran
      // in. Folding the column removed the worktree from view, not from the
      // record, so typing a worktree name still finds its sessions.
      sessionProjectName(s),
      deriveProjectName(s.path),
      ...s.modelsUsed,
      ...(machineAxis.enabled ? [machineName(s.machineId, machineAxis.directory)] : []),
    ],
    [machineAxis],
  );

  // Selection lives in the URL so it survives the round-trip through
  // /sessions/:id and back. A ?selected= value that matches no current row
  // renders the filter-totals strip — never crashes.
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedId = selectedIdFromParams(searchParams);
  const selected = rows.find((s) => s.sessionId === selectedId);

  // Click-again toggles the selection off (back to filter totals); Esc too.
  // `{ replace: true }` so select → /sessions/:id → Back is one history slot —
  // pairs with `replace` on the detail-page link.
  const onSelect = (s: SessionRow): void => {
    setSearchParams(
      (prev) =>
        s.sessionId === selectedIdFromParams(prev)
          ? withoutSelectedParam(prev)
          : withSelectedParam(prev, s.sessionId),
      { replace: true },
    );
  };
  const deselect = useCallback(() => {
    setSearchParams((prev) => withoutSelectedParam(prev), { replace: true });
  }, [setSearchParams]);
  useEscapeToDeselect(deselect);

  // Filter totals for the strip's no-selection state (ADR-0016).
  const aggregate = useMemo(() => aggregateSessions(rows), [rows]);

  // First-launch empty state: the engine holds no usage data at all. An empty
  // result while the corpus is non-empty is merely a filtered-out date range —
  // that keeps the inline "No sessions in this range." message below.
  if (useCorpusEmpty()) {
    return (
      <div className="p-6">
        <EmptyState />
      </div>
    );
  }

  return (
    <StripPage
      onBackgroundClick={deselect}
      strip={
        selected ? (
          <SessionDetailStrip session={selected} />
        ) : query.isPending ? (
          // The sessions query hasn't resolved yet. Two flavors of the same
          // shell: a ?selected= id means the user *did* select a session (e.g.
          // just landed back from /sessions/:id) — say so; otherwise it's a
          // cold load, where showing the aggregate would assert a false
          // "0 sessions · $0.00". Once loading settles, a stale id matching no
          // row falls through to the genuine filter totals.
          <DetailStrip selected={false}>
            <span className="text-sm text-soft">
              {selectedId !== undefined ? "Loading session…" : "Loading…"}
            </span>
          </DetailStrip>
        ) : query.isError && rows.length === 0 ? (
          // A failed query with nothing cached: the zero aggregate would
          // assert a false "0 sessions · $0.00" — say what happened instead
          // (the table body carries the danger inset).
          <DetailStrip selected={false}>
            <span className="text-sm text-soft">Couldn&apos;t load sessions.</span>
          </DetailStrip>
        ) : (
          <SessionsAggregateStrip aggregate={aggregate} rangeLabel={RANGE_LABEL[dateRange]} />
        )
      }
      table={
        <section className="panel table-panel h-full" aria-label="Sessions table">
          <DataTable
            title="Sessions"
            rows={rows}
            columns={columns}
            rowId={sessionRowId}
            onSelect={onSelect}
            selectedId={selectedId}
            // 332px of fixed columns + 96px models minimum + ≥264px shared by
            // the session / project name columns. Below this the table scrolls
            // horizontally instead of crushing them. The Machine column adds
            // 120px to the floor when the axis is enabled (ADR-0041 M6). At
            // narrow the row wraps and the floor is dropped entirely — nothing
            // is off-screen there, so keeping it would leave a phantom scrollbar
            // under a row that fits (globals.css `.table-scroll`).
            minWidth={machineAxis.enabled ? 812 : 692}
            defaultSort={{ columnId: "lastActivity", dir: "desc" }}
            searchKeys={searchKeys}
            searchPlaceholder="Search sessions…"
            emptyMessage={query.isPending ? "Loading…" : "No sessions in this range."}
            error={query.error}
          />
        </section>
      }
    />
  );
}

function SessionDetailStrip({ session }: { session: SessionRow }): React.ReactElement {
  const navigate = useNavigate();
  const [copied, setCopied] = useState(false);
  // The copy-confirmation timer must be cleared on unmount so deselecting the
  // row mid-confirmation can't call setState on an unmounted component.
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(copyTimer.current), []);

  const copyUuid = (): void => {
    void navigator.clipboard?.writeText(session.sessionId);
    setCopied(true);
    clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopied(false), 1200);
  };

  return (
    <DetailStrip selected>
      <StripIdentity title={session.sessionId.slice(0, 8)}>
        <button
          type="button"
          onClick={copyUuid}
          className="copy-btn num"
          title="Copy full session id"
        >
          <span className="trunc">{session.sessionId}</span>
          {copied ? <Check aria-hidden className="ok" /> : <Copy aria-hidden />}
        </button>
        <span className="sub num">{deriveProjectPath(session.path)}</span>
      </StripIdentity>

      <StripStat label="cost">{formatCost(session.totalCost)}</StripStat>
      <StripStat label="tokens">{abbreviate(session.totalTokens)}</StripStat>
      <StripStat label="cache hit">{cacheHitPct(session).toFixed(0)}%</StripStat>
      <StripStat label="last event">{session.lastActivity}</StripStat>

      <StripSection label="Per-model split">
        <ModelSplitBar breakdowns={session.modelBreakdowns} size="md" showLegend />
      </StripSection>

      <button
        type="button"
        onClick={() => navigate(`/sessions/${session.sessionId}`)}
        className="strip-action"
      >
        View full timeline →
      </button>
    </DetailStrip>
  );
}

function SessionsAggregateStrip({
  aggregate,
  rangeLabel,
}: {
  aggregate: SessionsAggregate;
  rangeLabel: string;
}): React.ReactElement {
  return (
    <DetailStrip selected={false}>
      <StripIdentity title="All sessions">
        <span className="sub num">
          {aggregate.count} sessions · {rangeLabel}
        </span>
      </StripIdentity>

      <StripStat label="total cost">{formatCost(aggregate.totalCost)}</StripStat>
      <StripStat label="total tokens">{abbreviate(aggregate.totalTokens)}</StripStat>
      <StripStat label="avg / session">{formatCost(aggregate.avgCost)}</StripStat>
      <StripStat label="cache hit">{aggregate.cacheHitPct.toFixed(0)}%</StripStat>

      <StripSection label="Per-model split">
        <ModelSplitBar breakdowns={aggregate.breakdowns} size="md" showLegend />
      </StripSection>

      <span className="strip-hint">Select a row for details</span>
    </DetailStrip>
  );
}
