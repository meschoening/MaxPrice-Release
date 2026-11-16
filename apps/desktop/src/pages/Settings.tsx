import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { ChevronDown } from "lucide-react";
import { DEFAULT_SETTINGS } from "@maxprice/shared";
import { useSettings, useUpdateSettings } from "@/state/use-settings";
import { useLiveStatus } from "@/state/use-live-status";
import { PathList } from "@/components/settings/PathList";
import { TimezoneSelect } from "@/components/settings/TimezoneSelect";
import { TimeFormatControl } from "@/components/settings/TimeFormatControl";
import { WeekControl } from "@/components/settings/WeekControl";
import { CostModeControl } from "@/components/settings/CostModeControl";
import { UpdatesSection } from "@/components/settings/UpdatesSection";
import { PricingSection } from "@/components/settings/pricing-section";
import { PRICING_SECTION_DESCRIPTION } from "@/lib/pricing-section";
import { BackgroundSection } from "@/components/settings/background-section";
import { backgroundResidencySupported } from "@/lib/background-residency";
import { isMacOS } from "@/lib/platform";
import { SETTINGS_SECTIONS as SECTION } from "@/lib/settings-sections";
import { AutostartSection } from "@/components/settings/autostart-section";
import { useAutostart } from "@/state/use-autostart";
import { TransparencySection } from "@/components/settings/TransparencySection";
import { ResetSection } from "@/components/settings/ResetSection";
import { AppInfoSection } from "@/components/settings/app-info-section";
import { HubSection } from "@/components/settings/hub-section";
import { StorageSection } from "@/components/settings/storage-section";
import { StorageActions } from "@/components/settings/storage-actions";
import { STORAGE_COPY } from "@/lib/storage-view";
import { disconnectHub } from "@/lib/hub-config";
import { Section } from "@/components/settings/settings-section";
import { AccountsCluster } from "@/components/settings/accounts/accounts-cluster";

// Settings page (`/settings`, ADR-0014) — the single-column editor for the
// durable `settings.json`, wearing Glass (M6, the T7
// `clusters` variant): grouped panels — Accounts (first since #639, #621's
// layout) / Data / Storage / Connections / Application — sections hairlined
// inside, the wash breathing between groups.
// The page title/subtitle live in the pill topbar (the T5/T6 rule). Reads via
// `useSettings`, writes via `useUpdateSettings`; its Cost mode section is the
// client's only control for the cost mode, the topbar's cost-mode chip having
// been retired.

// macOS is the one platform whose Reduce-transparency accessibility setting
// never reaches the WebView (no prefers-reduced-transparency in WebKit), so
// only macOS gets the app-side switch (same platform sniff as PathList).
const IS_MAC = isMacOS();
// Whether closing the window can mean anything but "quit" here (map #168).
// Read once, like IS_MAC: neither the host nor the platform changes under a
// running renderer.
const BACKGROUND_RESIDENCY = backgroundResidencySupported();

export function SettingsPage(): React.ReactElement {
  // While the settings query loads, fall back to defaults so the page renders
  // a coherent form rather than blank controls.
  const { data: settings } = useSettings();
  const current = settings ?? DEFAULT_SETTINGS;
  const update = useUpdateSettings();
  const unlistedConfigDirRoots = useLiveStatus((s) => s.unlistedConfigDirRoots);

  // Gates the whole "Start at login" section: hidden until the shell answers
  // (an IPC round trip, so no flash) and hidden for good on "unsupported" —
  // Linux (autostart is out of this map's scope there, T6) and the Tauri-less
  // Vite debug host. The section component shares the query via its cache.
  const autostartState = useAutostart().data;

  // The ⌘K finder opens a section as `/settings#settings-<title>` (#640).
  // Keyed on the location, so choosing the same section again scrolls again.
  const location = useLocation();
  useEffect(() => {
    if (location.hash === "") return;
    document.getElementById(location.hash.slice(1))?.scrollIntoView({ block: "start" });
  }, [location.key, location.hash]);

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
      {/* Settings › Accounts (#621, #639): the strips, the Home membership,
          each Provider's Account cards, the Gateways and Unattributed usage.
          `?connect=<account>` opens that Account's Connect (#638's D3). */}
      <AccountsCluster />

      <div className="cluster panel">
        <span className="cluster-head eyebrow">Data</span>

        <Section
          title={SECTION.claudePaths}
          description="Directories scanned for Claude Code JSONL usage logs."
        >
          <PathList
            paths={current.claudePaths}
            unlisted={unlistedConfigDirRoots}
            onChange={(claudePaths) => void update({ claudePaths })}
          />
        </Section>

        {/* One section, two settings: the zone decides which DAY an event
            buckets into, the format decides how a clock time READS (ADR-0060).
            The heading stays "Timezone" and the description carries the second
            control, following this page's habit of explaining in the dim line
            rather than in the title. */}
        <Section
          title={SECTION.timezone}
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

        {/* Week sits under Timezone because the anchored modes are wall-clock:
            a custom weekday/time resolves in the zone chosen just above. */}
        <Section title={SECTION.week} description="What “this week” means across the app.">
          <WeekControl value={current.week} onChange={(week) => void update({ week })} />
        </Section>

        <Section
          title={SECTION.costMode}
          description="How each row's cost is sourced from the JSONL."
        >
          <CostModeControl
            value={current.costMode}
            onChange={(costMode) => void update({ costMode })}
          />
        </Section>

        <Section title={SECTION.currency} description="Display currency for all costs.">
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

        <Section title={SECTION.diskUsage} description={STORAGE_COPY.desc}>
          <StorageSection />
        </Section>

        <Section title={SECTION.cleanUp} description={STORAGE_COPY.actDesc}>
          <StorageActions />
        </Section>
      </div>

      <div className="cluster panel">
        <span className="cluster-head eyebrow">Connections</span>

        <Section
          title={SECTION.usageHub}
          description="Connect to an always-on hub that polls usage limits for every machine."
        >
          <HubSection />
        </Section>
      </div>

      <div className="cluster panel">
        <span className="cluster-head eyebrow">Application</span>

        {/* Placement (map #168's "Settings copy + placement" fog, settled at
            M4): the two residency toggles lead Application — Background first
            (it governs the more common gesture), Start at login beneath it.
            Both self-hide where they cannot mean anything: Background off
            Linux/outside Tauri, Start at login on an "unsupported" state. */}
        {BACKGROUND_RESIDENCY ? (
          <Section
            title={SECTION.background}
            description="Keep MaxPrice running after the window closes."
          >
            <BackgroundSection />
          </Section>
        ) : null}

        {autostartState !== undefined && autostartState !== "unsupported" ? (
          <Section title={SECTION.autostart} description="Open MaxPrice automatically at sign-in.">
            <AutostartSection />
          </Section>
        ) : null}

        <Section
          title={SECTION.updates}
          description="Check for a newer release of MaxPrice and install it."
        >
          <UpdatesSection />
        </Section>

        {/* Directly after Updates: the two "ask upstream" actions share a
            grammar and a job, so they read as a pair (ADR-0085). */}
        <Section title={SECTION.pricing} description={PRICING_SECTION_DESCRIPTION}>
          <PricingSection />
        </Section>

        {IS_MAC ? (
          <Section
            title={SECTION.transparency}
            description="Render surfaces opaque instead of frosted glass — stands in for the system Reduce-transparency setting, which macOS doesn't surface to the app."
          >
            <TransparencySection />
          </Section>
        ) : null}

        <Section title={SECTION.reset} description="Restore all settings to their defaults.">
          <ResetSection onReset={reset} />
        </Section>

        {/* Last in the cluster, after the actions — facts, not things to do
            (T3's placement, map #100). The Pricing data row moved out to
            Settings › Pricing (ADR-0085). Mostly read-once ones; the Sidecar
            row added on 2026-08-01 is the exception, and the description says
            so rather than letting a live row hide under "versions", as it
            names the User guide row that closes the section (#564). */}
        <Section
          title={SECTION.appInfo}
          description="Versions, whether the sidecar is running, and the User guide."
        >
          <AppInfoSection />
        </Section>
      </div>
    </div>
  );
}
