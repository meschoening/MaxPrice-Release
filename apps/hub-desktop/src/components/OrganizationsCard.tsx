import { useState } from "react";
import {
  checkOrganizationLabel,
  ORGANIZATION_LABEL_MAX,
  type HubOrganization,
  type UsageConnection,
} from "@maxprice/shared";
import { useHubOrganizations } from "@/state/use-hub-organizations";
import { useHubStatus } from "@/state/use-hub-status";
import { useNowTick } from "@/state/use-now-tick";
import { useRenameOrganization } from "@/state/use-organization-mutations";
import { showToast } from "@/lib/toast";
import {
  discoveredOrganizations,
  formatCount,
  limitsAnswerText,
  organizationLabels,
  organizationSubline,
} from "@/lib/presentation";

// The Organizations card (#294): every Organization the Hub's key discovered,
// shown only once there is more than one (with one, the Claude account card's
// Organization row names it). Modelled on the Machines card: a Limits-answer
// dot, the Organization label, the short id where the label lacks it and the
// answer in words, with the last read and last sample beneath. Rename is the row's only action, so it is
// a chip rather than a kebab, and opens the Machines card's inset recipe.
// Labels go through the Organization directory, so every machine sees them.

// What the content needs of the rename mutation. `submit`'s `done` runs on
// success only, so a refusal keeps the inset open with the Hub's words.
export type OrganizationRename = {
  pending: boolean;
  error: string | null;
  submit: (uuid: string, label: string | null, done: () => void) => void;
  reset: () => void;
};

export function OrganizationsCard(): React.ReactElement {
  const { data: status } = useHubStatus();
  const { data } = useHubOrganizations();
  const now = useNowTick();
  const mutation = useRenameOrganization();
  const rename: OrganizationRename = {
    pending: mutation.isPending,
    error: mutation.isError ? mutation.error.message : null,
    submit: (uuid, label, done) =>
      mutation.mutate(
        { uuid, label },
        {
          onSuccess: () => {
            done();
            showToast(label === null ? "Label reset" : "Organization renamed");
          },
        },
      ),
    reset: mutation.reset,
  };
  return (
    <OrganizationsCardContent
      rows={data?.organizations}
      connection={status?.usageConnection ?? "disconnected"}
      now={now}
      rename={rename}
    />
  );
}

export function OrganizationsCardContent({
  rows,
  connection,
  now,
  rename,
}: {
  rows: readonly HubOrganization[] | undefined;
  connection: UsageConnection;
  now: number;
  rename: OrganizationRename;
}): React.ReactElement | null {
  // The uuid whose rename inset is open; one at a time.
  const [open, setOpen] = useState<string | null>(null);

  const discovered = discoveredOrganizations(rows, connection);
  if (discovered.length <= 1) return null;
  // Over every row the roster answers, never just the listed ones, so a
  // collision suffix reads as it does on the account row and the Home lines.
  const labels = organizationLabels(rows ?? []);

  const toggle = (uuid: string): void => {
    if (open === uuid) {
      setOpen(null);
      return;
    }
    setOpen(uuid);
    rename.reset();
  };

  return (
    <section className="panel card" aria-label="Organizations">
      <div className="card-head">
        <span className="eyebrow">Organizations</span>
        <span className="status">{formatCount(discovered.length)}</span>
      </div>
      <div>
        {discovered.map((row) => {
          const label = labels.get(row.uuid) ?? row.label;
          const answer = limitsAnswerText(row.limits);
          // A collision suffix or the default label already carries the short
          // id; repeating it would only truncate the label it disambiguates.
          const short = row.uuid.slice(0, 8);
          return (
            <div key={row.uuid} className="mrow">
              <div className="mrow-top">
                <span aria-hidden className={`dot ${answer.dot}`} />
                <span className="mname">{label}</span>
                {label.includes(short) ? null : <span className="mid">{short}</span>}
                <span className="mcount">{answer.text}</span>
                <button
                  type="button"
                  className="chip"
                  aria-label={`rename ${label}`}
                  aria-expanded={open === row.uuid}
                  onClick={() => toggle(row.uuid)}
                >
                  Rename…
                </button>
              </div>
              <p className="msub">{organizationSubline(row, now)}</p>
              {open === row.uuid ? (
                <OrganizationRenameFlow row={row} rename={rename} onClose={() => setOpen(null)} />
              ) : null}
            </div>
          );
        })}
      </div>
      <p className="hint">
        Labels are shared with every machine&rsquo;s Settings through the Organization directory.
      </p>
    </section>
  );
}

// The rename inset. The draft starts at the bare label: the collision suffix is
// render-time, never a rename. Save waits for a label the rename rules accept;
// their limit counts code points, so it is checked here rather than with
// maxLength (UTF-16 units). "Use default" clears a rename back to the plan word
// or short id.
export function OrganizationRenameFlow({
  row,
  rename,
  onClose,
}: {
  row: HubOrganization;
  rename: OrganizationRename;
  onClose: () => void;
}): React.ReactElement {
  const [draft, setDraft] = useState(row.label);
  const check = checkOrganizationLabel(draft);
  return (
    <div className="flow mflow">
      <div className="btns">
        <input
          className="input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          aria-label="organization label"
          style={{ flex: 1 }}
        />
        <button
          type="button"
          className="chip active"
          disabled={rename.pending || !check.ok}
          onClick={() => {
            if (check.ok) rename.submit(row.uuid, check.label, onClose);
          }}
        >
          {rename.pending ? "Saving…" : "Save"}
        </button>
        {row.renamed ? (
          <button
            type="button"
            className="chip"
            disabled={rename.pending}
            onClick={() => rename.submit(row.uuid, null, onClose)}
          >
            Use default
          </button>
        ) : null}
        <button type="button" className="chip ghost-btn" onClick={onClose}>
          Cancel
        </button>
      </div>
      {!check.ok && check.reason === "too-long" ? (
        <p className="err">{`Use ${ORGANIZATION_LABEL_MAX} characters or fewer.`}</p>
      ) : null}
      {rename.error !== null ? <p className="err">{rename.error}</p> : null}
    </div>
  );
}
