import { ChevronDown } from "lucide-react";
import { useOrganizations } from "@/state/use-organizations";
import { useSettings, useUpdateSettings } from "@/state/use-settings";

// Settings → Claude account: the Home organization (CONTEXT.md, ADR-0098).
// MaxPrice shows usage for exactly one organization; this is where it is
// chosen. Labels only — a plan word or a short id, never an upstream name and
// never a count: the app does not acknowledge that other usage exists. Hints
// when Claude Code's `remoteControlAtStartup` is off (ADR-0101). Hidden until
// the sidecar has answered; an empty list (nothing known) renders nothing.
export function HomeOrganizationSelect(): React.ReactElement | null {
  const { data } = useOrganizations();
  const { data: settings } = useSettings();
  const update = useUpdateSettings();
  if (data === undefined || data.organizations.length === 0) return null;
  const value = settings?.homeOrganization ?? data.home ?? "";
  const known = data.organizations.some((o) => o.uuid === value);
  return (
    <>
      <div className="row-line">
        <div className="select-wrap">
          <select
            className="input"
            aria-label="Home organization"
            value={known ? value : ""}
            onChange={(e) => {
              if (e.target.value !== "") void update({ homeOrganization: e.target.value });
            }}
          >
            {known ? null : <option value="">Choose an organization…</option>}
            {data.organizations.map((o) => (
              <option key={o.uuid} value={o.uuid}>
                {o.label}
                {o.currentLogin ? " (current login)" : ""}
              </option>
            ))}
          </select>
          <ChevronDown aria-hidden />
        </div>
      </div>
      <p className="subline">MaxPrice shows usage for this organization only.</p>
      {data.remoteControlAtStartup ? null : (
        // ADR-0101: the one nudge that keeps interactive CLI sessions
        // attributable. Setup guidance; names no hidden usage and no count.
        <p className="hint-line">
          Turn on Remote Control at startup in Claude Code (/config) so every terminal session
          records its organization.
        </p>
      )}
    </>
  );
}
