import { ChevronDown } from "lucide-react";
import { DEFAULT_SETTINGS } from "@maxprice/shared";
import { useSettings, useUpdateSettings } from "@/state/use-settings";
import { PathList } from "@/components/settings/PathList";
import { TimezoneSelect } from "@/components/settings/TimezoneSelect";
import { TimeFormatControl } from "@/components/settings/TimeFormatControl";
import { CostModeControl } from "@/components/settings/CostModeControl";
import { UpdatesSection } from "@/components/settings/UpdatesSection";
import { TransparencySection } from "@/components/settings/TransparencySection";
import { ResetSection } from "@/components/settings/ResetSection";
import { AppInfoSection } from "@/components/settings/app-info-section";
import { UsageConnectionSection } from "@/components/settings/usage-connection-section";
import { HubSection } from "@/components/settings/hub-section";
import { StorageSection } from "@/components/settings/storage-section";
import { StorageActions } from "@/components/settings/storage-actions";
import { STORAGE_COPY } from "@/lib/storage-view";
import { disconnectHub } from "@/lib/hub-config";

// Settings page (`/settings`, ADR-0014) — the single-column editor for the
// durable `settings.json`, wearing Glass per settings-glass.html (M6, the T7
// `clusters` variant): three grouped panels — Data / Connections /
// Application — sections hairlined inside, the wash breathing between groups.
// The page title/subtitle live in the pill topbar (the T5/T6 rule). Reads via
// `useSettings`, writes via `useUpdateSettings`; the topbar cost-mode chip
// shares both.

// macOS is the one platform whose Reduce-transparency accessibility setting
// never reaches the WebView (no prefers-reduced-transparency in WebKit), so
// only macOS gets the app-side switch (same platform sniff as PathList).
const IS_MAC = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform);

// One settings section — heading, dim description, and the control block
// (the T7 section grammar; hairline dividers come from `.s-section`).
function Section({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <section className="s-section" aria-label={title}>
      <h2>{title}</h2>
      <p className="desc">{description}</p>
      <div className="control">{children}</div>
    </section>
  );
}

export function SettingsPage(): React.ReactElement {
  // While the settings query loads, fall back to defaults so the page renders
  // a coherent form rather than blank controls.
  const { data: settings } = useSettings();
  const current = settings ?? DEFAULT_SETTINGS;
  const update = useUpdateSettings();

  // Reset tears down the hub too: writing DEFAULT_SETTINGS alone clears hubUrl
  // in settings.json but leaves the running sidecar hub-connected and the
  // keychain password alive. disconnectHub owns the keychain → settings → push
  // ordering (see lib/hub-config), shared with the hub section's Disconnect;
  // Reset passes DEFAULT_SETTINGS as its settings payload. Reset must not fail
  // on a down sidecar (or absent Tauri host), hence the warn-only catch.
  const reset = (): void => {
    void disconnectHub(() => update(DEFAULT_SETTINGS)).catch((e) =>
      console.warn("hub teardown failed on reset:", e),
    );
  };

  return (
    <div className="settings-form">
      <div className="cluster panel">
        <span className="cluster-head eyebrow">Data</span>

        <Section
          title="Claude data paths"
          description="Directories scanned for Claude Code JSONL usage logs."
        >
          <PathList
            paths={current.claudePaths}
            onChange={(claudePaths) => void update({ claudePaths })}
          />
        </Section>

        {/* One section, two settings: the zone decides which DAY an event
            buckets into, the format decides how a clock time READS (ADR-0060).
            The heading stays "Timezone" and the description carries the second
            control, following this page's habit of explaining in the dim line
            rather than in the title. */}
        <Section
          title="Timezone"
          description="Used for bucketing daily totals, and how times are displayed."
        >
          <TimezoneSelect
            value={current.timezone}
            onChange={(timezone) => void update({ timezone })}
          />
          <TimeFormatControl
            value={current.timeFormat}
            onChange={(timeFormat) => void update({ timeFormat })}
          />
        </Section>

        <Section title="Cost mode" description="How each row's cost is sourced from the JSONL.">
          <CostModeControl
            value={current.costMode}
            onChange={(costMode) => void update({ costMode })}
          />
        </Section>

        <Section title="Currency" description="Display currency for all costs.">
          <div className="row-line" style={{ width: "auto", gap: 10 }}>
            <div className="select-wrap cur-wrap">
              <select disabled value="USD" aria-label="Currency" className="input">
                <option value="USD">USD</option>
              </select>
              <ChevronDown aria-hidden />
            </div>
            <span className="hint-line">more in v0.2</span>
          </div>
        </Section>
      </div>

      {/* Storage is its own cluster (T3, #127), NOT a section inside
          Application: charted that way, it put a bar, a legend and a
          destructive button under the same heading weight as "Reset". Its own
          cluster also settles the facts-vs-actions split at the level where it
          works — a cluster head reading STORAGE above a section titled
          "Storage" would stutter; two verbs don't. */}
      <div className="cluster panel">
        <span className="cluster-head eyebrow">Storage</span>

        <Section title={STORAGE_COPY.title} description={STORAGE_COPY.desc}>
          <StorageSection />
        </Section>

        <Section title={STORAGE_COPY.actTitle} description={STORAGE_COPY.actDesc}>
          <StorageActions />
        </Section>
      </div>

      <div className="cluster panel">
        <span className="cluster-head eyebrow">Connections</span>

        <Section
          title="Claude account (usage limits)"
          description="Connect a claude.ai session key to show real 5-hour and weekly subscription limits."
        >
          <UsageConnectionSection />
        </Section>

        <Section
          title="Usage hub"
          description="Connect to an always-on hub that polls usage limits for every machine."
        >
          <HubSection />
        </Section>
      </div>

      <div className="cluster panel">
        <span className="cluster-head eyebrow">Application</span>

        <Section
          title="Updates"
          description="Check for a newer release of MaxPrice and install it."
        >
          <UpdatesSection />
        </Section>

        {IS_MAC ? (
          <Section
            title="Reduce transparency"
            description="Render surfaces opaque instead of frosted glass — stands in for the system Reduce-transparency setting, which macOS doesn't surface to the app."
          >
            <TransparencySection />
          </Section>
        ) : null}

        <Section title="Reset" description="Restore all settings to their defaults.">
          <ResetSection onReset={reset} />
        </Section>

        {/* Last in the cluster, after the two actions — facts, not things to
            do (T3's placement, map #100). Mostly read-once ones; the Sidecar
            row added on 2026-08-01 is the exception, and the description says
            so rather than letting a live row hide under "versions". */}
        <Section
          title="App info"
          description="Versions, where model prices come from, and whether the sidecar is running."
        >
          <AppInfoSection />
        </Section>
      </div>
    </div>
  );
}
