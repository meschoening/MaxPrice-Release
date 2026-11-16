import { Check, ChevronDown, ChevronRight, Minus, Search } from "lucide-react";
import { formatCalendarDay, formatCost, type SessionRow } from "@maxprice/shared";
import {
  checkState,
  sessionTag,
  toggleSessions,
  type CheckState,
  type ChooserOption,
  type GroupSummary,
  type OwnerlessGroup,
} from "@/lib/session-assignment";
import { cn } from "@/lib/utils";
import { MembershipChooser } from "./membership-chooser";
import { SessionTag } from "./session-attribution";

// Settings › Unattributed usage's markup (#620 item 4, #639; the owner-less
// review page's, #312, moved): a bar with the selection's actions and the
// search, then the unattributed sessions grouped by project. Props in, markup
// out, with no query hooks, so the markup is testable with static rendering;
// the section owns the state (the selection, the open groups, the search) and
// every handler hands back the next value for it to store. The one local
// state is the `Assign to…` chooser's open flag, inside MembershipChooser,
// whose Radix popover only the Playwright evidence covers.

const NONE: ReadonlySet<string> = new Set();

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

// --- the review ------------------------------------------------------------------

export interface UnattributedReviewContentProps {
  // groupOwnerless over the unattributed rows and `search`, the search
  // already applied.
  groups: readonly OwnerlessGroup[];
  labels: ReadonlyMap<string, string>;
  selected: ReadonlySet<string>;
  // The groups opened by hand, by key. Folded is the default; a search opens
  // every group it matches whatever this holds.
  open: ReadonlySet<string>;
  search: string;
  // For the rows' last activity: the settings Timezone and the instant that
  // decide which day is today.
  tz: string | undefined;
  now: number;
  // What `Assign to…` offers (membershipChooserOptions).
  options: readonly ChooserOption[];
  // A write is in flight: Assign waits for it.
  pending?: boolean;
  emptyMessage?: string;
  // The query's error: with nothing to show, the danger inset.
  error?: Error | null;
  onSearch: (search: string) => void;
  onOpenChange: (open: ReadonlySet<string>) => void;
  onSelectionChange: (selected: ReadonlySet<string>) => void;
  // A pick in the `Assign to…` chooser.
  onAssign: (option: ChooserOption) => void;
}

// The bar, then one row per project, disclosing its sessions. While anything
// is selected the bar reads "‹N› selected" with `Assign to…` (the Membership
// chooser) and Clear, which clears the selection; otherwise a hint. Its
// search matches id, project and model (groupOwnerless's default keys).
// Clicking a group row opens it; clicking a session row selects it.
export function UnattributedReviewContent({
  groups,
  labels,
  selected,
  open,
  search,
  tz,
  now,
  options,
  pending = false,
  emptyMessage,
  error,
  onSearch,
  onOpenChange,
  onSelectionChange,
  onAssign,
}: UnattributedReviewContentProps): React.ReactElement {
  const searching = search.trim() !== "";
  const toggleOpen = (key: string): void => {
    const next = new Set(open);
    if (!next.delete(key)) next.add(key);
    onOpenChange(next);
  };
  const empty =
    emptyMessage ??
    (searching
      ? `No unattributed session matches “${search.trim()}”.`
      : "No unattributed sessions in the last 30 days.");
  return (
    <div className="unattributed-review">
      <div className="head-bar unattributed-bar">
        {selected.size > 0 ? (
          <>
            <b className="num">{`${selected.size} selected`}</b>
            <MembershipChooser
              count={selected.size}
              options={options}
              disabled={pending}
              className="chip assign-trigger"
              onPick={onAssign}
            >
              Assign to…
              <ChevronDown aria-hidden className="caret" />
            </MembershipChooser>
            <button
              type="button"
              className="chip ghost-btn"
              onClick={() => onSelectionChange(NONE)}
            >
              Clear
            </button>
          </>
        ) : (
          <span className="hint-line">Select sessions, or a whole project, to assign them.</span>
        )}
        <div className="search-wrap">
          <Search aria-hidden />
          <input
            type="search"
            className="search"
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            placeholder="Search unattributed sessions…"
            aria-label="Search unattributed sessions"
          />
        </div>
      </div>
      <div className="unattributed-list thin-scroll">
        {groups.length === 0 ? (
          error ? (
            <div className="inset danger m-3" role="alert">
              <p className="lead">Could not load sessions</p>
              <p className="num break-words">{error.message}</p>
            </div>
          ) : (
            <p className="empty-msg">{empty}</p>
          )
        ) : (
          groups.map((group) => (
            <ReviewGroup
              key={group.key}
              group={group}
              labels={labels}
              selected={selected}
              isOpen={searching || open.has(group.key)}
              tz={tz}
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
  tz,
  now,
  onToggleOpen,
  onSelectionChange,
}: {
  group: OwnerlessGroup;
  labels: ReadonlyMap<string, string>;
  selected: ReadonlySet<string>;
  isOpen: boolean;
  tz: string | undefined;
  now: number;
  onToggleOpen: () => void;
  onSelectionChange: (selected: ReadonlySet<string>) => void;
}): React.ReactElement {
  const ids = group.sessions.map((row) => row.sessionId);
  const state = checkState(ids, selected);
  const n = ids.length;
  const on = ids.filter((id) => selected.has(id)).length;
  const count = `${n} session${n === 1 ? "" : "s"}${state === "some" ? ` · ${on} checked` : ""}`;
  // Row clicks stop here, so a click never toggles twice through an ancestor.
  const open = (e: React.MouseEvent): void => {
    e.stopPropagation();
    onToggleOpen();
  };
  return (
    <div className="review-group">
      <div className={cn("review-row review-head", state === "on" && "checked")} onClick={open}>
        <TriStateCheckbox
          state={state}
          label={`Select every unattributed session in ${group.name}`}
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
              tz={tz}
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
  tz,
  now,
  onToggle,
}: {
  row: SessionRow;
  labels: ReadonlyMap<string, string>;
  checked: boolean;
  tz: string | undefined;
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
        {formatCalendarDay(row.lastActivity, tz, now)}
      </span>
      <span className="review-cost num">{formatCost(row.totalCost)}</span>
    </div>
  );
}
