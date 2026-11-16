import { useState } from "react";
import { Link } from "react-router-dom";
import { formatCalendarDay, formatCost, type SessionRow } from "@maxprice/shared";
import { cn } from "@/lib/utils";
import { sessionTag } from "@/lib/session-assignment";
import { sessionListView } from "@/lib/project-sessions";
import type { MachineAxis } from "@/state/use-machine-axis";
import { MachineChip } from "./machine-chip";
import { ModelBadges } from "./model-badges";
import { SessionTag } from "./session-attribution";

export type ProjectSessionListProps = {
  // The selected row's sessions in the rail's range, costliest first
  // (`sessionsOfSlugs`). Undefined while the sessions query has no data.
  sessions: SessionRow[] | undefined;
  // The sessions query failed with nothing cached.
  failed: boolean;
  // The table's search text, as the table filters by it.
  search: string;
  // Past one tracked Organization (#312): the Organization tag (SessionTag)
  // beside an owner-less session's id.
  multi: boolean;
  labels: ReadonlyMap<string, string>;
  // Null while the machine axis is off: no machine chip.
  machineAxis: MachineAxis | null;
  tz: string | undefined;
  now: number;
};

// The Projects detail panel's third row (#640): the selected project's
// costliest sessions in range, every one under All, or the ones the table's
// search matched. Each row opens the session page as a push, so its Back chip
// returns here with the project still selected (`?selected=`). The caller keys
// it by the selected row, so All resets when the selection moves.
export function ProjectSessionList({
  sessions,
  failed,
  search,
  multi,
  labels,
  machineAxis,
  tz,
  now,
}: ProjectSessionListProps): React.ReactElement {
  const [showAll, setShowAll] = useState(false);
  const view = sessionListView(sessions ?? [], search, showAll);
  return (
    <section className="strip-sessions" aria-label="Project sessions">
      <div className="strip-sessions-head">
        {view.matching === null ? (
          <span className="eyebrow">{view.head}</span>
        ) : (
          <>
            <span className="eyebrow">Sessions matching</span>
            <span className="needle num" title={view.head}>
              “{view.matching}”
            </span>
          </>
        )}
        {sessions === undefined ? null : (
          <span className="count num">
            {view.shown.length} of {view.total} in range
          </span>
        )}
        {view.toggle === null ? null : (
          <button
            type="button"
            className="view-all"
            aria-pressed={showAll}
            onClick={() => setShowAll((v) => !v)}
          >
            {view.toggle}
          </button>
        )}
      </div>
      {view.shown.length === 0 ? (
        <p className="strip-sessions-empty">
          {sessions !== undefined
            ? "No sessions in range."
            : failed
              ? "Couldn’t load sessions."
              : "Loading…"}
        </p>
      ) : (
        <ul className={cn("strip-sessions-list thin-scroll", view.scrolls && "scrolls")}>
          {view.shown.map((s) => {
            const tag = multi ? sessionTag(s, labels) : null;
            return (
              <li key={s.sessionId}>
                <Link
                  to={`/sessions/${s.sessionId}`}
                  className={cn("strip-session", machineAxis !== null && "with-machine")}
                  title={s.sessionId}
                >
                  <b className="sid num">
                    {s.sessionId.slice(0, 8)}
                    {tag === null ? null : <SessionTag tag={tag} />}
                  </b>
                  {machineAxis === null ? null : (
                    <MachineChip id={s.machineId} machineAxis={machineAxis} />
                  )}
                  <ModelBadges models={s.modelsUsed} className="models" />
                  <b className="cost num">{formatCost(s.totalCost)}</b>
                  <span className="day num">{formatCalendarDay(s.lastActivity, tz, now)}</span>
                  <span className="open">Open →</span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
