import { useOrganizations } from "@/state/use-organizations";
import { useScope } from "@/state/use-scope";
import { useSettings, useUpdateSettings } from "@/state/use-settings";
import { useUsageCurrent } from "@/state/use-usage-current";

// The Claude section's foot (#639): the two pieces Settings › Claude account
// carried that are Claude's and not one Account's — the Model-limit switch and
// the Remote Control hint.

export function ClaudeSectionFoot(): React.ReactElement {
  const { data: roster } = useOrganizations();
  return (
    <>
      <ModelLimitSwitch />
      {roster === undefined || roster.remoteControlAtStartup ? null : <RemoteControlHint />}
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

// The Model-scoped weekly limit opt-in (GLOSSARY.md): a switch that renders
// ONLY while the current sample carries a scoped window — an account without
// one would otherwise see an inert toggle — and, on, adds a "<Model> limit"
// row to the tray popout beneath the weekly limit. The label names the model
// from the wire. The Rust shell reads the field from settings.json to size
// the popout, and `write_settings` already kicks its poller, so the flip
// resizes the next open with no further wiring. Same switch recipe as the
// Background section.
function ModelLimitSwitch(): React.ReactElement | null {
  // The Quota organization's reading (ADR-0106 §8).
  const { quotaOrganization } = useScope();
  const { data: usage } = useUsageCurrent(quotaOrganization);
  const { data: settings } = useSettings();
  const update = useUpdateSettings();
  const window = usage?.sample?.weeklyModel;
  if (window === undefined) return null;
  const on = settings?.showModelLimit ?? false;
  return (
    <>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        onClick={() => void update({ showModelLimit: !on })}
        className="toggle"
      >
        <span className="track" aria-hidden />
        Show model limit in tray popout
      </button>
      <p className="subline">
        Adds a &ldquo;{window.model} limit&rdquo; row beneath the weekly limit — the weekly cap
        Anthropic applies to {window.model} alone.
      </p>
    </>
  );
}
