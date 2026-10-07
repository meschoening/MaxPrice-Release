import { Check, ChevronDown, ChevronRight, Minus } from "lucide-react";
import { formatRelativeTime, type SessionRow } from "@maxprice/shared";
import { formatCost } from "@/lib/list-format";
import {
  checkState,
  sessionTag,
  toggleSessions,
  type CheckState,
  type ChooserOption,
  type GroupSummary,
  type OwnerlessGroup,
  type SelectionSummary,
} from "@/lib/session-assignment";
import { cn } from "@/lib/utils";
import { DetailStrip, StripIdentity, StripStat } from "./detail-strip";
import { OrganizationChooser } from "./organization-chooser";
import { SessionTag } from "./session-attribution";
import { TableHeadBar } from "./table-head-bar";

// The Sessions page's owner-less review (#312, past one tracked Organization):
// the `All sessions | Owner-less N` switch, the review list of owner-less
// sessions grouped by project, and the selection bar that takes the detail
// strip's place while anything is selected. Props in, markup out, with no query
// hooks, so the markup is testable with static rendering; the page owns the
// state (the selection, the open groups, the search) and every handler hands
// back the next value for it to store. The one local state is the `Assign to…`
// chooser's open flag, inside OrganizationChooser, whose Radix popover only
// the Playwright evidence covers.

const NONE: ReadonlySet<string> = new Set();

// --- the switch ----------------------------------------------------------------

// The head bar's mode switch. `count` is the owner-less sessions in the current
// result, search aside. A click on the tab already active does nothing, so it
// adds no history entry.
export function OwnerlessSwitch({
  ownerless,
  count,
  onChange,
}: {
  ownerless: boolean;
  count: number;
  onChange: (ownerless: boolean) => void;
}): React.ReactElement {
  const select = (next: boolean): void => {
    if (next !== ownerless) onChange(next);
  };
  return (
    <div className="seg seg-mini" role="tablist" aria-label="Which sessions">
      <button
        type="button"
        role="tab"
        aria-selected={!ownerless}
        className={ownerless ? undefined : "active"}
        onClick={() => select(false)}
      >
        All sessions
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={ownerless}
        className={ownerless ? "active" : undefined}
        onClick={() => select(true)}
      >
        Owner-less <span className="num text-soft font-medium">{count}</span>
      </button>
    </div>
  );
}

// --- the checkbox ----------------------------------------------------------------

// A square checkbox with a third, mixed state for a group some of whose shown
// sessions are selected. Its click never reaches the row it sits in, whose own
// click would toggle (or open) a second time.
export function TriStateCheckbox({
  state,
  label,
  onToggle,
}: {
  state: CheckState;
  label: string;
  onToggle: () => void;
}): React.ReactElement {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={state === "some" ? "mixed" : state === "on"}
      aria-label={label}
      className={cn("tri-check", state !== "off" && "on")}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
    >
      {state === "on" ? (
        <Check strokeWidth={3.5} aria-hidden />
      ) : state === "some" ? (
        <Minus strokeWidth={3.5} aria-hidden />
      ) : null}
    </button>
  );
}

// --- the review list ---------------------------------------------------------------

export interface OwnerlessReviewContentProps {
  // groupOwnerless over the page's rows and `search`: owner-less sessions only,
  // the search already applied.
  groups: readonly OwnerlessGroup[];
  labels: ReadonlyMap<string, string>;
  selected: ReadonlySet<string>;
  // The groups opened by hand, by key. Collapsed is the default; a search opens
  // every group it matches whatever this holds.
  open: ReadonlySet<string>;
  search: string;
  // For the rows' last activity.
  now: number;
  // The head bar's switch.
  headerAction?: React.ReactNode;
  emptyMessage?: string;
  // The page query's error: with nothing to show, the danger inset, as the
  // ordinary table renders it.
  error?: Error | null;
  onSearch: (search: string) => void;
  onOpenChange: (open: ReadonlySet<string>) => void;
  onSelectionChange: (selected: ReadonlySet<string>) => void;
}

// The owner-less review list, in place of the Sessions table: its own head bar
// (title, shown count, the switch, Expand all, search), then one row per
// project, disclosing its sessions. Clicking a group row opens it; clicking a
// session row selects it.
export function OwnerlessReviewContent({
  groups,
  labels,
  selected,
  open,
  search,
  now,
  headerAction,
  emptyMessage = "No owner-less sessions in this range.",
  error,
  onSearch,
  onOpenChange,
  onSelectionChange,
}: OwnerlessReviewContentProps): React.ReactElement {
  const searching = search.trim() !== "";
  const shown = groups.reduce((n, group) => n + group.sessions.length, 0);
  const allOpen = groups.length > 0 && groups.every((group) => open.has(group.key));
  const toggleOpen = (key: string): void => {
    const next = new Set(open);
    if (!next.delete(key)) next.add(key);
    onOpenChange(next);
  };
  return (
    <div className="flex flex-col flex-1 min-h-0">
      <TableHeadBar
        title="Sessions"
        count={shown}
        search={search}
        onSearch={onSearch}
        searchPlaceholder="Search owner-less…"
        searchLabel="Search owner-less sessions"
        action={
          <>
            {headerAction}
            <button
              type="button"
              className="chip ghost-btn"
              onClick={() => onOpenChange(allOpen ? NONE : new Set(groups.map((g) => g.key)))}
            >
              {allOpen ? "Collapse all" : "Expand all"}
            </button>
          </>
        }
      />
      <div className="thin-scroll flex-1 min-h-0 overflow-y-auto">
        {groups.length === 0 ? (
          error ? (
            <div className="inset danger m-3" role="alert">
              <p className="lead">Could not load sessions</p>
              <p className="num break-words">{error.message}</p>
            </div>
          ) : (
            <p className="empty-msg">{emptyMessage}</p>
          )
        ) : (
          groups.map((group) => (
            <ReviewGroup
              key={group.key}
              group={group}
              labels={labels}
              selected={selected}
              isOpen={searching || open.has(group.key)}
              now={now}
              onToggleOpen={() => toggleOpen(group.key)}
              onSelectionChange={onSelectionChange}
            />
          ))
        )}
      </div>
    </div>
  );
}

function summaryText(summary: GroupSummary): string {
  return summary.kind === "mixed" ? "mixed" : `${summary.kind} · ${summary.label ?? ""}`;
}

// One project: its row — checkbox over its shown sessions, chevron, name,
// session count, where their owner-less usage counts, cost — then, open, its
// sessions.
function ReviewGroup({
  group,
  labels,
  selected,
  isOpen,
  now,
  onToggleOpen,
  onSelectionChange,
}: {
  group: OwnerlessGroup;
  labels: ReadonlyMap<string, string>;
  selected: ReadonlySet<string>;
  isOpen: boolean;
  now: number;
  onToggleOpen: () => void;
  onSelectionChange: (selected: ReadonlySet<string>) => void;
}): React.ReactElement {
  const ids = group.sessions.map((row) => row.sessionId);
  const state = checkState(ids, selected);
  const n = ids.length;
  const on = ids.filter((id) => selected.has(id)).length;
  const count = `${n} session${n === 1 ? "" : "s"}${state === "some" ? ` · ${on} checked` : ""}`;
  // Row clicks stop here: the page reads a click that reaches it as a click on
  // dead space, which clears the selection.
  const open = (e: React.MouseEvent): void => {
    e.stopPropagation();
    onToggleOpen();
  };
  return (
    <div className="review-group">
      <div className={cn("review-row review-head", state === "on" && "checked")} onClick={open}>
        <TriStateCheckbox
          state={state}
          label={`Select every owner-less session in ${group.name}`}
          onToggle={() => onSelectionChange(toggleSessions(selected, ids))}
        />
        <button
          type="button"
          className={cn("tree-toggle", isOpen && "open")}
          aria-expanded={isOpen}
          aria-label={`${isOpen ? "Collapse" : "Expand"} ${group.name}`}
          onClick={open}
        >
          <ChevronRight aria-hidden strokeWidth={2.5} />
        </button>
        <b className="truncate">{group.name}</b>
        <span className="review-meta num">{count}</span>
        <span className="review-summary">{summaryText(group.summary)}</span>
        <span className="review-cost num">{formatCost(group.cost)}</span>
      </div>
      {isOpen
        ? group.sessions.map((row) => (
            <ReviewSession
              key={row.sessionId}
              row={row}
              labels={labels}
              checked={selected.has(row.sessionId)}
              now={now}
              onToggle={() => onSelectionChange(toggleSessions(selected, [row.sessionId]))}
            />
          ))
        : null}
    </div>
  );
}

// One session: checkbox, short id, its tag naming the target (a partly owned
// session's ` · part`, then where the rest counts), last activity, cost.
function ReviewSession({
  row,
  labels,
  checked,
  now,
  onToggle,
}: {
  row: SessionRow;
  labels: ReadonlyMap<string, string>;
  checked: boolean;
  now: number;
  onToggle: () => void;
}): React.ReactElement {
  const tag = sessionTag(row, labels);
  const shortId = row.sessionId.slice(0, 8);
  return (
    <div
      className={cn("review-row review-child", checked && "checked")}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
    >
      <TriStateCheckbox
        state={checked ? "on" : "off"}
        label={`Select ${shortId}`}
        onToggle={onToggle}
      />
      <span className="num">{shortId}</span>
      {tag === null ? null : <SessionTag tag={tag} withTarget />}
      {tag?.ownedLabel === undefined ? null : (
        <span className="review-meta review-rest">{`rest has an Owner record · ${tag.ownedLabel}`}</span>
      )}
      <span className="review-meta review-when" title={row.lastActivity}>
        {formatRelativeTime(row.lastActivity, now)}
      </span>
      <span className="review-cost num">{formatCost(row.totalCost)}</span>
    </div>
  );
}

// --- the selection bar ---------------------------------------------------------------

export interface SelectionBarContentProps {
  // selectionSummary over the selected rows.
  summary: SelectionSummary;
  selected: ReadonlySet<string>;
  // The sessions the review list shows (shownSessionIds): what "Select all N
  // shown" counts and selects.
  shownIds: readonly string[];
  // What `Assign to…` offers (chooserOptions).
  options: readonly ChooserOption[];
  onSelectionChange: (selected: ReadonlySet<string>) => void;
  // A pick in the `Assign to…` chooser.
  onAssign: (option: ChooserOption) => void;
  // `Clear assignment` — clears the selected sessions' assertions.
  onClear: () => void;
  // A write is in flight: Assign and Clear wait for it.
  pending?: boolean;
}

// The detail strip's place while anything is selected: what is selected and
// what it costs, how many are presumed and assigned, a partly owned note, and
// the actions. "Select all N shown" makes the selection exactly the sessions
// the search shows, dropping any it hides, so no write can act on a session
// out of sight. Once the selection is exactly those — or when the search
// shows nothing — it reads "Select none", which clears everything, as Done
// does. `Assign to…` opens the Organization chooser, the shared target checked.
export function SelectionBarContent({
  summary,
  selected,
  shownIds,
  options,
  onSelectionChange,
  onAssign,
  onClear,
  pending = false,
}: SelectionBarContentProps): React.ReactElement {
  // Set equality, not "every shown is selected": a selection holding the
  // shown sessions plus hidden ones must still offer to narrow to the shown.
  const exactlyShown =
    shownIds.length > 0 &&
    selected.size === shownIds.length &&
    shownIds.every((id) => selected.has(id));
  const selectNone = exactlyShown || shownIds.length === 0;
  const { count, projects, partlyOwned, anyAssigned } = summary;
  return (
    <DetailStrip selected>
      <StripIdentity title={`${count} selected`}>
        <button
          type="button"
          className="copy-btn"
          onClick={() => onSelectionChange(selectNone ? NONE : new Set(shownIds))}
        >
          {selectNone ? <Minus aria-hidden /> : <Check aria-hidden />}
          {selectNone ? "Select none" : `Select all ${shownIds.length} shown`}
        </button>
        <span className="sub">
          {projects.length === 1 ? projects[0] : `${projects.length} projects`}
        </span>
      </StripIdentity>
      <StripStat label="cost">{formatCost(summary.cost)}</StripStat>
      <StripStat label="presumed">{summary.presumed}</StripStat>
      <StripStat label="assigned">{summary.assigned}</StripStat>
      {partlyOwned > 0 ? (
        <span className="strip-hint strip-note">
          {`${partlyOwned} partly owned: only ${partlyOwned === 1 ? "its" : "their"} owner-less part moves`}
        </span>
      ) : null}
      <span className="strip-actions">
        <OrganizationChooser
          count={count}
          options={options}
          checked={summary.sharedTarget}
          disabled={pending}
          className="strip-action assign-trigger"
          onPick={onAssign}
        >
          Assign to…
          <ChevronDown aria-hidden className="caret" />
        </OrganizationChooser>
        <button
          type="button"
          className="chip"
          disabled={!anyAssigned || pending}
          title={anyAssigned ? "Count them by presumption again" : "None of these is assigned"}
          onClick={onClear}
        >
          Clear assignment
        </button>
        <button type="button" className="chip ghost-btn" onClick={() => onSelectionChange(NONE)}>
          Done
        </button>
      </span>
    </DetailStrip>
  );
}
