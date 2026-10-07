import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useLiveStatus } from "@/state/use-live-status";
import {
  credentialForConnect,
  discoverOrgsViaSidecar,
  readCredential,
  writeCredential,
  pushCredentialToSidecar,
  syncCredential,
} from "@/lib/usage-credential";
import {
  formatWallClock,
  usageConnectionDot,
  usageConnectionLabel,
  usageConnectionTextClass,
  type TimeDisplay,
} from "@maxprice/shared";
import { useSettings, useTimeDisplay, useUpdateSettings } from "@/state/use-settings";
import { organizationsQueryKey, useOrganizations } from "@/state/use-organizations";
import { useOrganizationScope } from "@/state/use-organization-scope";
import { useUsageCurrent } from "@/state/use-usage-current";
import { useSettingsLastOpened } from "@/state/use-settings-last-opened";
import { keyStatusLine, showOrganizationList } from "@/lib/organization-list-view";
import { HomeOrganizationSelect } from "./home-organization-select";
import { OrganizationList } from "./organization-list";
import { isStale, STALE_USAGE_LINE } from "@/lib/stale-status";
import { cn } from "@/lib/utils";
import { dotVariant } from "@/lib/dot-variant";

// Settings → Claude account (ADR-0023 → ADR-0104). Paste a claude.ai
// sessionKey cookie; the sidecar discovers the orgs, asks each one's usage
// endpoint what it answers, and seeds the roster with them — nothing picks one:
// the tracked set decides what this machine polls. We store { sessionKey } in
// the OS keychain and push it to the sidecar (a legacy `orgId` not yet
// acknowledged rides along to be stamped — `credentialForConnect`). Live
// connection state comes from the `status:changed` SSE snapshot, which the
// sidecar updates on every poll — success AND failure.
//
// M6 (T7): the status line is a triad dot + the frozen labels from
// usage-status.ts — including the deliberate `expired` divergence (amber dot,
// red text); inputs/buttons are the T1 glass pieces; validation errors stay
// bare `--bad` text lines under their control. Past one Organization the line
// describes the key instead (`keyStatusLine`): the same dot and text mapping,
// applied to the key's state; its own phrasing; and a tracked count in place
// of the last reading.

// Format an ISO 8601 capturedAt as a clock time for the status line ("last
// reading 3:42 PM"). An unparseable value falls back to the raw string rather
// than rendering "Invalid Date".
//
// Before ADR-0060 this line was the app's one rogue clock: it read the HOST
// zone (never the Settings timezone) and took whatever hour cycle the host
// locale implied, so it could disagree with every other time on screen in both
// zone and shape. Routing it through `formatWallClock` fixes both at once —
// there is no longer a way to render a clock time without naming its zone.
function formatSampleTime(iso: string, display: TimeDisplay): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return formatWallClock(d, display);
}

export function UsageConnectionSection(): React.ReactElement {
  const connection = useLiveStatus((s) => s.usageConnection);
  const lastSampleAt = useLiveStatus((s) => s.usageLastSampleAt);
  const display = useTimeDisplay();
  // THE STALE RULE (lib/stale-status), shared verbatim with the sidebar foot —
  // which renders simultaneously with this page. `usageConnection` is a mirror
  // of sidecar-owned state refreshed only by `status:changed` frames, so once
  // the SSE channel is gone it holds its last value forever and a green
  // "Connected" starts asserting something nobody has confirmed since the drop.
  //
  // Only the stale rule is shared. The foot's sticky-connecting rule stays
  // foot-only: it buys steadiness on a permanent glance surface, but on an
  // action surface it would swallow feedback from the buttons below.
  const connectionState = useLiveStatus((s) => s.connectionState);
  const stale = isStale(connectionState);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const qc = useQueryClient();
  // Past one Organization the list replaces the Home select. This section is
  // always on the Settings page, so it stamps each visit and hands the list
  // the previous one for its `New` tag.
  const { data: roster } = useOrganizations();
  const lastOpenedAt = useSettingsLastOpened();

  async function connect(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const { orgs, error: discErr } = await discoverOrgsViaSidecar(key.trim());
      if (orgs.length === 0) {
        setError(
          discErr === "expired"
            ? "That session key looks invalid or expired."
            : "Couldn't reach Anthropic — check your connection and try again.",
        );
        return;
      }
      // The keychain first, so a failed push keeps the new key for the next
      // boot; an unacknowledged legacy `orgId` rides along to be stamped.
      const stored = credentialForConnect(key.trim(), await readCredential().catch(() => null));
      await writeCredential(stored);
      await syncCredential(stored);
      setKey("");
      void qc.invalidateQueries({ queryKey: organizationsQueryKey() });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function disconnect(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await writeCredential(null);
      await pushCredentialToSidecar(null);
      void qc.invalidateQueries({ queryKey: organizationsQueryKey() });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  // The status line's three presentation pieces, resolved together so the dot,
  // the text colour, and the label can never disagree about whether we still
  // believe the mirror. `variant` is the glass `.dot` triad, which is what this
  // line has always drawn — `dotVariant` translates usage-status.ts' Tailwind
  // `bg-*` class into it, so the frozen constant's `variant` drops straight in.
  // Stale OUTRANKS `expired`, exactly as in the foot, and takes the deliberate
  // `expired` dot/text divergence (amber dot, red text — usage-status.ts:56-59)
  // with it; that divergence is untouched on the non-stale path. Past one
  // Organization the key's line takes the non-stale path's place.
  const keyLine =
    roster !== undefined && showOrganizationList(roster) ? keyStatusLine(connection, roster) : null;
  const line = stale
    ? {
        variant: STALE_USAGE_LINE.variant,
        textClass: STALE_USAGE_LINE.textClass,
        label: STALE_USAGE_LINE.title,
      }
    : keyLine !== null
      ? {
          variant: dotVariant(usageConnectionDot(keyLine.connection)),
          textClass: usageConnectionTextClass(keyLine.connection),
          label: keyLine.text,
        }
      : {
          variant: dotVariant(usageConnectionDot(connection)),
          textClass: usageConnectionTextClass(connection),
          label: usageConnectionLabel(connection),
        };
  // Past one Organization each row carries its own read time, so the key's
  // line shows no last reading; its count is a claim about now, which the
  // stale line withdraws with the rest.
  const keyDetail = keyLine !== null && !stale ? keyLine.detail : null;

  return (
    <>
      {showOrganizationList(roster) ? (
        <OrganizationList lastOpenedAt={lastOpenedAt} />
      ) : (
        <HomeOrganizationSelect />
      )}

      <div className="status-line">
        <span className={cn("dot", line.variant)} aria-hidden />
        <span className={line.textClass}>{line.label}</span>
        {keyDetail !== null ? <span className="when">{keyDetail}</span> : null}
        {/* Kept when stale, unlike the foot's relative "sampled Nm ago": an
            ABSOLUTE last-reading time is a fact about the past that a dropped
            channel doesn't invalidate, so it stays true beside "state unknown"
            — and it is the one thing on this line still worth knowing. */}
        {keyLine === null && lastSampleAt !== null ? (
          <span className="when">— last reading {formatSampleTime(lastSampleAt, display)}</span>
        ) : null}
      </div>

      <div className="row-line">
        <input
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="Paste sessionKey cookie value"
          aria-label="claude.ai session key"
          className="input"
          // Allow pressing Enter to connect
          onKeyDown={(e) => {
            if (e.key === "Enter" && key.trim() !== "" && !busy) void connect();
          }}
        />
        <button
          type="button"
          className="chip"
          disabled={busy || key.trim() === ""}
          onClick={() => void connect()}
        >
          {busy ? "Connecting…" : "Connect"}
        </button>
        <button type="button" className="chip" disabled={busy} onClick={() => void disconnect()}>
          Disconnect
        </button>
      </div>

      {error !== null ? <p className="err">{error}</p> : null}

      <p className="helper">
        Shows real 5-hour and weekly subscription limits. The key is stored in the OS keychain and
        must be re-pasted when it expires (every few weeks). Find it in your browser&rsquo;s cookies
        for claude.ai under the name <code>sessionKey</code>.
      </p>

      <ModelLimitSwitch />
    </>
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
  // The Quota organization's reading, the one the status line describes
  // (ADR-0106 §8).
  const { quotaOrganization } = useOrganizationScope();
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
