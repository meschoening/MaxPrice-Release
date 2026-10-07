import { ChevronDown } from "lucide-react";
import { displayOrganizationLabels, type OrganizationsResponse } from "@maxprice/shared";
import { useOrganizations } from "@/state/use-organizations";
import { useSettings, useUpdateSettings } from "@/state/use-settings";

// Settings → Claude account: the Home organization (GLOSSARY.md, ADR-0098).
// MaxPrice shows usage for exactly one organization; this is where it is
// chosen. Each option is the Organization label the sidecar resolved (the
// user's rename, else a plan word, else a short id), and two that match carry
// their short id — never an upstream name and never a count: the app does not
// acknowledge that other usage exists. "(current login)" marks every
// Organization a watched root's login names right now. Hints when Claude
// Code's `remoteControlAtStartup` is off (ADR-0101). Hidden until the sidecar
// has answered; an empty list (nothing known) renders nothing.
export function HomeOrganizationSelect(): React.ReactElement | null {
  const { data } = useOrganizations();
  const { data: settings } = useSettings();
  const update = useUpdateSettings();
  if (data === undefined) return null;
  return (
    <HomeOrganizationSelectContent
      data={data}
      value={settings?.homeOrganization ?? data.home ?? ""}
      onSelect={(uuid) => {
        void update({ homeOrganization: uuid });
      }}
    />
  );
}

// The pure composition — the roster and the chosen home handed in so the
// markup is testable under static rendering (the query hooks resolve to their
// initial state there).
export function HomeOrganizationSelectContent({
  data,
  value,
  onSelect,
}: {
  data: OrganizationsResponse;
  value: string;
  onSelect: (uuid: string) => void;
}): React.ReactElement | null {
  if (data.organizations.length === 0) return null;
  const known = data.organizations.some((o) => o.uuid === value);
  const labels = displayOrganizationLabels(data.organizations);
  return (
    <>
      <div className="row-line">
        <div className="select-wrap">
          <select
            className="input"
            aria-label="Home organization"
            value={known ? value : ""}
            onChange={(e) => {
              if (e.target.value !== "") onSelect(e.target.value);
            }}
          >
            {known ? null : <option value="">Choose an organization…</option>}
            {data.organizations.map((o) => (
              <option key={o.uuid} value={o.uuid}>
                {labels.get(o.uuid) ?? o.label}
                {o.currentLogin ? " (current login)" : ""}
              </option>
            ))}
          </select>
          <ChevronDown aria-hidden />
        </div>
      </div>
      <p className="subline">MaxPrice shows usage for this organization only.</p>
      {data.remoteControlAtStartup ? null : <RemoteControlHint />}
    </>
  );
}

// ADR-0101: the one nudge that keeps interactive CLI sessions attributable,
// shown while Claude Code's `remoteControlAtStartup` is off. Setup guidance;
// names no hidden usage and no count.
export function RemoteControlHint(): React.ReactElement {
  return (
    <p className="hint-line">
      Turn on Remote Control at startup in Claude Code (/config) so every terminal session records
      its organization.
    </p>
  );
}
