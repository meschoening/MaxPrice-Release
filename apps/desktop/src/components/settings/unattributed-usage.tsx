import { useCallback, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { homeOrganizationOf, organizationLabel, sessionProjectName } from "@maxprice/shared";
import { useSettings } from "@/state/use-settings";
import { useOrganizationLabels } from "@/state/use-organizations";
import {
  organizationAssertionsQueryKey,
  putOrganizationAssertions,
} from "@/state/use-organization-assertions";
import {
  useMembershipChooserOptions,
  useUnattributedRows,
} from "@/state/use-unattributed-sessions";
import { useEscapeToDeselect } from "@/state/use-escape-deselect";
import {
  assignableOptions,
  groupOwnerless,
  pruneSelection,
  type ChooserOption,
} from "@/lib/session-assignment";
import {
  runAssertionWrite,
  runAssignPick,
  type AssertionWrite,
  type AssertionWriteDeps,
} from "@/lib/assignment-writes";
import {
  GATEWAYS_SECTION_PATH,
  homeMembershipLabel,
  showsGatewayHint,
  unattributedDescription,
  unattributedPill,
  unattributedShown,
} from "@/lib/unattributed-usage";
import { SETTINGS_SECTIONS } from "@/lib/settings-sections";
import { showToast } from "@/lib/toast";
import { AssignExcludedConfirm } from "@/components/assign-excluded-confirm";
import { UnattributedReviewContent } from "@/components/unattributed-review";
import { Section } from "./settings-section";

// Settings › Unattributed usage (#620 item 4, #639): the sessions whose usage
// has no Attribution evidence and no Membership assertion over the last 30
// days, grouped by project, and `Assign to…`, which writes a Membership
// assertion (ADR-0137 §5) moving each selected session's evidence-less rows
// to that Membership on every machine. A written session reads `assigned`,
// so it leaves the list once the sidecar's usage:new round refreshes the
// sessions query. It reads its own query, never the rail's.
//
// It renders only while it lists a session (`unattributedShown`, #672), with
// one Membership to assign to or several. Selection, search and the open
// groups are component state, so leaving Settings clears them.

export interface UnattributedUsageProps {
  // The Gateway hint's Connect a Gateway (ADR-0141 §4). By default it opens
  // Settings at the Gateways subsection's anchor.
  onConnectGateway?: () => void;
}

// The empty selection (and no groups opened), shared so an unchanged empty
// state keeps its identity.
const NONE: ReadonlySet<string> = new Set();

// A pick in an Excluded Organization waiting on its confirm: the write as the
// selection stood at the pick, which is what the dialog's count describes.
interface ExcludedPick {
  write: AssertionWrite;
  label: string;
  organization: string;
}

export function UnattributedUsage({
  onConnectGateway,
}: UnattributedUsageProps): React.ReactElement | null {
  const { data: settings } = useSettings();
  const labels = useOrganizationLabels();
  const options = useMembershipChooserOptions();
  const { query, rows: loadedRows } = useUnattributedRows();
  const loaded = loadedRows !== undefined;
  const rows = useMemo(() => loadedRows ?? [], [loadedRows]);
  const shown = options !== undefined && unattributedShown(loadedRows, query.error !== null);
  const navigate = useNavigate();

  const [selection, setSelection] = useState<ReadonlySet<string>>(NONE);
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState<ReadonlySet<string>>(NONE);
  const [pending, setPending] = useState(false);
  const [excludedPick, setExcludedPick] = useState<ExcludedPick | null>(null);

  // A write, or any refresh, can take a selected session out of the list
  // (assigned now, or past the 30 days), so the selection follows the loaded
  // rows. Adjusted during render rather than in an effect, so the bar never
  // paints a stale count. Only loaded data prunes.
  const live = useMemo(
    () => (loaded ? pruneSelection(selection, rows) : selection),
    [loaded, rows, selection],
  );
  if (live !== selection) setSelection(live);

  const groups = useMemo(
    () => groupOwnerless(rows, { search, projectName: sessionProjectName, labels }),
    [rows, search, labels],
  );
  const selectedRows = useMemo(() => rows.filter((s) => live.has(s.sessionId)), [rows, live]);
  const clearSelection = useCallback(() => setSelection(NONE), []);
  // Esc clears the selection, except an Esc that closes the chooser or the
  // confirm, which Radix has already handled.
  useEscapeToDeselect(clearSelection, { skipHandled: true });

  const qc = useQueryClient();
  const writeDeps = useMemo<AssertionWriteDeps>(
    () => ({
      put: putOrganizationAssertions,
      invalidate: () => void qc.invalidateQueries({ queryKey: organizationAssertionsQueryKey() }),
      toast: showToast,
      setPending,
      clearSelection,
    }),
    [qc, clearSelection],
  );

  if (settings === undefined) return null;

  // The chooser has closed itself by now. A tracked pick writes at once, one
  // in an Excluded Organization confirms first; a success clears the
  // selection and toasts with Undo, a failure keeps it and toasts the error.
  const assign = (option: ChooserOption): void => {
    if (pending) return;
    runAssignPick(option, selectedRows, {
      ...writeDeps,
      confirm: (write, label) =>
        setExcludedPick({
          write,
          label,
          organization: organizationLabel(labels, option.organizationUuid),
        }),
    });
  };
  const connectGateway = onConnectGateway ?? (() => void navigate(GATEWAYS_SECTION_PATH));

  return (
    <>
      {shown ? (
        <Section
          title={SETTINGS_SECTIONS.unattributedUsage}
          badge={
            <span className={rows.length > 0 ? "pill warn-p" : "pill"}>
              {loaded ? unattributedPill(rows) : "…"}
            </span>
          }
          description={unattributedDescription(
            homeMembershipLabel(options, homeOrganizationOf(settings), labels),
          )}
        >
          {showsGatewayHint(rows) ? (
            <div className="inset unattributed-gateway" role="note">
              <p className="lead">These sessions look like they ran through a Gateway</p>
              <button type="button" className="chip" onClick={connectGateway}>
                Connect a Gateway
              </button>
            </div>
          ) : null}
          <UnattributedReviewContent
            groups={groups}
            labels={labels}
            selected={live}
            open={open}
            search={search}
            tz={settings.timezone}
            now={Date.now()}
            options={assignableOptions(options)}
            pending={pending}
            error={query.error}
            onSearch={setSearch}
            onOpenChange={setOpen}
            onSelectionChange={setSelection}
            onAssign={assign}
          />
        </Section>
      ) : null}
      {/* Outside the section: assigning its last sessions hides it, and the
          confirm stays until its write resolves. */}
      {excludedPick === null ? null : (
        <AssignExcludedConfirm
          count={excludedPick.write.sessionIds.length}
          label={excludedPick.label}
          organization={excludedPick.organization}
          onConfirm={async () => {
            if (!(await runAssertionWrite(excludedPick.write, writeDeps))) {
              throw new Error(excludedPick.write.failure);
            }
          }}
          onClose={() => setExcludedPick(null)}
        />
      )}
    </>
  );
}
