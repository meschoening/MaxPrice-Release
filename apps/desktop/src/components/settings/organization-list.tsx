import { useEffect, useId, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronRight } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  assignedHereText,
  excludedClaims,
  excludePatch,
  HOME_HINT,
  makeHomePatch,
  organizationListRows,
  presumptionLine,
  navigateToPresumptionReview,
  refusalSentence,
  renameSubmission,
  returnWrite,
  reviewScopePatch,
  trackingFacts,
  trackPatch,
  type LimitsPhrase,
  type OrganizationRowView,
} from "@/lib/organization-list-view";
import { runAssertionWrite } from "@/lib/assignment-writes";
import { presumptionCount } from "@/lib/session-assignment";
import { showToast } from "@/lib/toast";
import { useFilters } from "@/state/filters";
import { useLiveStatus } from "@/state/use-live-status";
import {
  organizationAssertionsQueryKey,
  putOrganizationAssertions,
  useOrganizationAssertions,
} from "@/state/use-organization-assertions";
import { useOrganizationScope } from "@/state/use-organization-scope";
import {
  organizationsQueryKey,
  renameOrganization,
  useOrganizations,
} from "@/state/use-organizations";
import { useSessions } from "@/state/use-sessions";
import { useSettings, useTimeDisplay, useUpdateSettings } from "@/state/use-settings";
import { cn } from "@/lib/utils";
import { RemoteControlHint } from "./home-organization-select";
import { ExcludeConfirm, TrackConfirm } from "./organization-tracking-dialog";

// Settings → Claude account past one Organization (ADR-0098): every
// Organization the roster knows, one row each, in place of the Home select.
// A row is its label (click to rename in place) and tags, then the plan word a
// rename hides and the Limits answer in words; `Make Home` and the tracked
// switch sit at its end, and the chevron opens its facts. No row carries a
// usage count; an Excluded row's facts count the sessions claimed for it
// (#312). The row views come from lib/organization-list-view.
//
// `Make Home` writes a Home change inside an unchanged tracked set
// (`makeHomePatch`), so the sidecar walks nothing and it needs no
// confirmation. The switch changes the set, so it confirms first: tracking an
// untracked row, excluding a tracked one (organization-tracking-dialog). Every
// one of these patches is built inside the settings write chain, from the
// settings as the write before it left them. The switch acts only where the
// row can toggle.
//
// #312 adds two lines. Past one tracked Organization (`multi`, ruling 7), the
// Home-scoped, all-time sessions query counts the sessions presumed under Home
// (ruling 4) for the line above the Home hint, whose Review opens the Sessions
// page's owner-less view. While any row is Excluded, the assertion map counts
// each Excluded Organization's claims (ruling 2) for its facts' `Assigned`
// line, whose Return them clears them. Neither query runs otherwise: a list
// with one tracked Organization asks for no sessions, and a single-Organization
// machine never mounts the list at all.
export function OrganizationList({
  lastOpenedAt,
}: {
  // The previous Settings visit, stamped by the page (useSettingsLastOpened).
  lastOpenedAt: string | null;
}): React.ReactElement | null {
  const { data } = useOrganizations();
  const { data: settings } = useSettings();
  const update = useUpdateSettings();
  const key = useLiveStatus((s) => s.usageConnection);
  const hubConnection = useLiveStatus((s) => s.hubConnection);
  const display = useTimeDisplay();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [confirm, setConfirm] = useState<{ uuid: string; mode: "track" | "exclude" } | null>(null);
  const { multi } = useOrganizationScope();
  // Home scope (`organization` absent) and all time (no dates), through the
  // ADR-0004 hook; asked only past one tracked Organization.
  const sessions = useSessions(
    { mode: settings?.costMode ?? "auto", tz: settings?.timezone },
    { enabled: multi },
  );
  const presumed =
    multi && sessions.data !== undefined ? presumptionCount(sessions.data.sessions) : null;
  const assertions = useOrganizationAssertions({
    enabled: data?.organizations.some((org) => !org.tracked) ?? false,
  });
  // One Return them at a time: a click while its PUT is out does nothing.
  const returning = useRef(false);
  // Only a connected client's answers are certainly the Hub's map: every
  // failed hub state hands them back to this machine's poller, and
  // `connecting` can hold either.
  const hubSourced = hubConnection === "connected";
  const rows =
    data === undefined
      ? []
      : organizationListRows({
          roster: data,
          home: settings?.homeOrganization ?? data.home,
          settings: settings ?? null,
          key,
          hubSourced,
          lastOpenedAt,
          display,
        });
  // The open dialog reads its row from the list as it is now, and closes once
  // that row is gone or has already become what the dialog would make it.
  const confirmRow = confirm === null ? undefined : rows.find((row) => row.uuid === confirm.uuid);
  const stale =
    confirm !== null &&
    (confirmRow === undefined || confirmRow.tracked !== (confirm.mode === "exclude"));
  useEffect(() => {
    if (stale) setConfirm(null);
  }, [stale]);

  if (data === undefined) return null;
  const entry =
    confirm === null ? undefined : data.organizations.find((org) => org.uuid === confirm.uuid);
  const Confirm = confirm?.mode === "exclude" ? ExcludeConfirm : TrackConfirm;
  return (
    <>
      <OrganizationListContent
        rows={rows}
        remoteControlAtStartup={data.remoteControlAtStartup}
        onRename={async (uuid, label) => {
          try {
            qc.setQueryData(organizationsQueryKey(), await renameOrganization(uuid, label));
            return null;
          } catch (e) {
            return e instanceof Error ? e.message : String(e);
          }
        }}
        onMakeHome={(row) => {
          void update((current) => makeHomePatch(current, row.uuid, row.tracked));
        }}
        onToggleTracked={(row) =>
          setConfirm({ uuid: row.uuid, mode: row.tracked ? "exclude" : "track" })
        }
        presumed={presumed}
        onReview={() => {
          // The count is all-time and Home's: show all time, and leave a scope
          // on another Organization, which would hide every session counted.
          // The page opens once the scope write has landed, so it never shows
          // the old scope first; a failed write is toasted by the writer.
          useFilters.getState().setDateRange("all");
          void navigateToPresumptionReview(
            update((current) =>
              reviewScopePatch(current.organizationScope, current.homeOrganization),
            ),
            navigate,
          );
        }}
        assertions={assertions}
        onReturn={(row, sessionIds) => {
          if (returning.current) return;
          // The Sessions page's write runner, so the toasts, the Undo and a
          // failure's error read as they do there. Settings holds no selection.
          void runAssertionWrite(returnWrite(sessionIds, row.uuid), {
            put: putOrganizationAssertions,
            invalidate: () =>
              void qc.invalidateQueries({ queryKey: organizationAssertionsQueryKey() }),
            toast: showToast,
            setPending: (pending) => {
              returning.current = pending;
            },
            clearSelection: () => {},
          });
        }}
      />
      {confirm !== null && !stale && confirmRow !== undefined && entry !== undefined ? (
        <Confirm
          key={`${confirm.mode} ${confirm.uuid}`}
          row={confirmRow}
          facts={trackingFacts(entry, key, hubConnection, hubSourced)}
          // A write that resolves with nothing to write (the settings already
          // say so) closes the dialog like one that wrote.
          onConfirm={() =>
            update((current) =>
              confirm.mode === "track"
                ? trackPatch(current, confirm.uuid)
                : excludePatch(current, confirm.uuid),
            )
          }
          // Only this dialog: a write that settles after it went stale leaves
          // one opened since alone.
          onClose={() => setConfirm((current) => (current === confirm ? null : current))}
        />
      ) : null}
    </>
  );
}

// The pure composition — the rows handed in so the markup is testable under
// static rendering. `initialOpen` and `initialEditing` seed the disclosure and
// the rename editor for that rendering only.
export function OrganizationListContent({
  rows,
  remoteControlAtStartup,
  presumed,
  assertions,
  onRename,
  onMakeHome,
  onToggleTracked,
  onReview,
  onReturn,
  initialOpen,
  initialEditing,
}: {
  rows: OrganizationRowView[];
  remoteControlAtStartup: boolean;
  // The sessions presumed under Home (#312 ruling 4); null while not asked
  // (one tracked Organization) or not answered. Hidden at null and 0.
  presumed: number | null;
  // sessionId → uuid (GET /api/organization-assertions), for each Excluded
  // row's `Assigned` fact. Empty while not asked.
  assertions: Readonly<Record<string, string>>;
  // Resolves null once saved, else the refusal to show under the input.
  onRename: (uuid: string, label: string | null) => Promise<string | null>;
  onMakeHome: (row: OrganizationRowView) => void;
  onToggleTracked?: (row: OrganizationRowView) => void;
  onReview: () => void;
  // Clear the claims `sessionIds` hold for `row`.
  onReturn: (row: OrganizationRowView, sessionIds: string[]) => void;
  initialOpen?: string;
  initialEditing?: string;
}): React.ReactElement {
  const [open, setOpen] = useState<string | null>(initialOpen ?? null);
  const [editing, setEditing] = useState<string | null>(initialEditing ?? null);
  const labels = useRef(new Map<string, HTMLButtonElement>());
  // Where keyboard focus goes when the control holding it goes away: its
  // row's label — at once if it is mounted, else once its editor closes.
  const refocus = useRef<string | null>(null);
  const focusLabel = (uuid: string): void => {
    const label = labels.current.get(uuid);
    if (label === undefined) refocus.current = uuid;
    else label.focus();
  };
  useEffect(() => {
    if (refocus.current === null) return;
    const label = labels.current.get(refocus.current);
    if (label === undefined) return;
    label.focus();
    refocus.current = null;
  }, [editing]);
  const presumption = presumptionLine(presumed, rows.find((row) => row.isHome)?.label);

  return (
    <>
      <div className="org-list" role="list" aria-label="Organizations">
        {rows.map((row) => (
          <OrganizationListItem
            key={row.uuid}
            row={row}
            open={open === row.uuid}
            editing={editing === row.uuid}
            labelRef={(el) => {
              if (el === null) labels.current.delete(row.uuid);
              else labels.current.set(row.uuid, el);
            }}
            onToggleOpen={() => setOpen(open === row.uuid ? null : row.uuid)}
            onEdit={() => setEditing(row.uuid)}
            onEditDone={(returnFocus) => {
              if (returnFocus) focusLabel(row.uuid);
              // A save that lands after another label was opened leaves that
              // editor open.
              setEditing((current) => (current === row.uuid ? null : current));
            }}
            onRename={onRename}
            onMakeHome={(target) => {
              // The button goes once its row is Home, and the row moves to the
              // top; its label keeps the focus through both.
              onMakeHome(target);
              focusLabel(target.uuid);
            }}
            onToggleTracked={onToggleTracked}
            claims={excludedClaims(row, assertions)}
            onReturn={onReturn}
          />
        ))}
      </div>
      {/* One child slot holds both lines, so the list keeps the ids it rendered
          with before the presumption line existed. */}
      <>
        {presumption === null ? null : (
          <p className="hint-line">
            {presumption}
            {" · "}
            <button type="button" className="org-list-link" onClick={onReview}>
              Review
            </button>
          </p>
        )}
        <p className="hint-line">{HOME_HINT}</p>
      </>
      {remoteControlAtStartup ? null : <RemoteControlHint />}
    </>
  );
}

function OrganizationListItem({
  row,
  open,
  editing,
  labelRef,
  onToggleOpen,
  onEdit,
  onEditDone,
  onRename,
  onMakeHome,
  onToggleTracked,
  claims,
  onReturn,
}: {
  row: OrganizationRowView;
  open: boolean;
  editing: boolean;
  labelRef: (el: HTMLButtonElement | null) => void;
  onToggleOpen: () => void;
  onEdit: () => void;
  onEditDone: (returnFocus: boolean) => void;
  onRename: (uuid: string, label: string | null) => Promise<string | null>;
  onMakeHome: (row: OrganizationRowView) => void;
  onToggleTracked?: (row: OrganizationRowView) => void;
  // The sessions claimed for this row while it is Excluded (`excludedClaims`).
  claims: string[];
  onReturn: (row: OrganizationRowView, sessionIds: string[]) => void;
}): React.ReactElement {
  const factsId = useId();
  return (
    <div role="listitem" className={cn("org-list-item", open && "open")}>
      <div className={cn("org-list-row", !row.tracked && "off")}>
        <button
          type="button"
          className="org-list-chevron"
          aria-expanded={open}
          aria-controls={factsId}
          aria-label={`Details for ${row.label}`}
          onClick={onToggleOpen}
        >
          <ChevronRight aria-hidden />
        </button>
        <div className="org-list-main">
          <div className="org-list-name">
            {editing ? (
              <RenameField row={row} onRename={onRename} onDone={onEditDone} />
            ) : (
              <button
                type="button"
                ref={labelRef}
                className="org-list-label"
                title="Rename"
                onClick={onEdit}
              >
                {row.label}
              </button>
            )}
            {row.tags.home ? <span className="org-list-tag home">Home</span> : null}
            {row.tags.isNew ? <span className="org-list-tag new">New</span> : null}
            {row.tags.currentLogin ? <span className="org-list-tag">current login</span> : null}
          </div>
          <div className="org-list-meta">
            {row.reingesting ? (
              <span className="org-list-reading">Reading its history…</span>
            ) : (
              <>
                {row.planWord !== null ? <span>{row.planWord} · </span> : null}
                <LimitsText phrase={row.limits} />
              </>
            )}
          </div>
        </div>
        {row.canMakeHome ? (
          <button
            type="button"
            className="org-list-link"
            aria-label={`Make ${row.label} Home`}
            onClick={() => onMakeHome(row)}
          >
            Make Home
          </button>
        ) : null}
        <button
          type="button"
          role="switch"
          aria-checked={row.tracked}
          aria-disabled={row.canToggleTracked ? undefined : true}
          aria-label={`Track ${row.label}`}
          title={row.switchDisabledReason ?? undefined}
          className="toggle"
          onClick={() => {
            if (row.canToggleTracked) onToggleTracked?.(row);
          }}
        >
          <span className="track" aria-hidden />
        </button>
      </div>
      {open ? (
        <div id={factsId} className="org-list-facts">
          <dl className="ai-pairs">
            <dt>Plan</dt>
            <dd>{row.facts.plan}</dd>
            <dt>Limits</dt>
            <dd>
              <LimitsText phrase={row.facts.limits} />
            </dd>
            {row.facts.lastSample !== null ? (
              <>
                <dt>Last sample</dt>
                <dd>{row.facts.lastSample}</dd>
              </>
            ) : null}
            <dt>Seen on</dt>
            <dd>{row.facts.seenOn}</dd>
            {claims.length > 0 ? (
              <>
                <dt>Assigned</dt>
                <dd>
                  {assignedHereText(claims.length)}
                  {" · "}
                  <button
                    type="button"
                    className="org-list-link"
                    onClick={() => onReturn(row, claims)}
                  >
                    Return them
                  </button>
                </dd>
              </>
            ) : null}
            <dt>Id</dt>
            <dd className="num">{row.facts.id}</dd>
          </dl>
        </div>
      ) : null}
    </div>
  );
}

function LimitsText({ phrase }: { phrase: LimitsPhrase }): React.ReactElement {
  return (
    <span className="org-list-limits">
      <span className={cn("dot", phrase.tone)} aria-hidden />
      {phrase.text}
    </span>
  );
}

// The in-place rename. Enter saves and Escape cancels; leaving the field saves
// too, unless a key already settled this draft or its refusal is still showing
// (saving it again would only be refused again). Editing the draft clears the
// refusal. An unrenamed Organization's field starts empty, its default label
// the placeholder; saving it empty clears a rename. Two residuals are
// accepted: a refusal to a blur-save made by opening another row's editor is
// never shown (the label keeps its old text), and a draft typed while a save
// is in flight is dropped when that save closes the field.
function RenameField({
  row,
  onRename,
  onDone,
}: {
  row: OrganizationRowView;
  onRename: (uuid: string, label: string | null) => Promise<string | null>;
  onDone: (returnFocus: boolean) => void;
}): React.ReactElement {
  const [draft, setDraft] = useState(row.renamed ? row.bareLabel : "");
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const settled = useRef(false);
  const saving = useRef(false);
  const errorId = useId();

  // Focus goes back to the label only if it is still in the field: a save
  // that lands after the user moved on leaves their focus where it is.
  function close(): void {
    onDone(document.activeElement === input.current);
  }

  async function save(): Promise<void> {
    if (saving.current) return;
    const submission = renameSubmission(draft, row);
    if (submission.kind === "noop") return close();
    if (submission.kind === "invalid") return setError(submission.error);
    saving.current = true;
    const refusal = await onRename(row.uuid, submission.label);
    saving.current = false;
    if (refusal === null) close();
    else setError(refusalSentence(refusal));
  }

  return (
    <span className="org-list-rename">
      <input
        ref={input}
        className="input"
        aria-label="Organization label"
        aria-invalid={error !== null ? true : undefined}
        aria-describedby={error !== null ? errorId : undefined}
        // Opened from the label it replaces, so focus moves with it.
        autoFocus
        placeholder={row.defaultLabel}
        value={draft}
        onChange={(e) => {
          settled.current = false;
          setError(null);
          setDraft(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            settled.current = true;
            void save();
          } else if (e.key === "Escape") {
            e.preventDefault();
            settled.current = true;
            onDone(true);
          }
        }}
        onBlur={() => {
          if (settled.current || error !== null) return;
          settled.current = true;
          void save();
        }}
      />
      {error !== null ? (
        <span id={errorId} className="err">
          {error}
        </span>
      ) : null}
    </span>
  );
}
