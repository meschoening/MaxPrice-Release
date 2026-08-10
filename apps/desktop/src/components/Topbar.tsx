import { matchPath, useLocation, useNavigate } from "react-router-dom";
import { ArrowLeft, Monitor, Moon, Sun } from "lucide-react";
import { deriveProjectPath } from "@maxprice/shared";
import { useFilters } from "@/state/filters";
import { themeChipLabel, useTheme } from "@/lib/theme";
import { useSettings } from "@/state/use-settings";
import { useLiveStatus, type ConnectionState } from "@/state/use-live-status";
import { useMachineAxis } from "@/state/use-machine-axis";
import { useSessionRow } from "@/state/use-session-row";
import { liveSubtitle, machineName } from "@/lib/machines";
import { RefreshPill } from "@/components/refresh-pill";
import { cn } from "@/lib/utils";
import { RANGE_LABEL } from "@/lib/list-format";

const TITLES: Record<string, string> = {
  "/live": "Live",
  "/sessions": "Sessions",
  "/projects": "Projects",
  "/blocks": "Blocks",
  "/settings": "Settings",
};

// The floating pill topbar (glass.html): page title + streaming badge +
// subtitle on the left; refresh chip (with the connection-dot slot) and the
// theme chip on the right. The old topbar's separate reconnecting indicator
// is absorbed by the badge and the refresh chip's dot (the mock's
// connection-dot slot).
//
// The mock's other three right-hand chips are gone, each duplicating a
// surface that already owns it: the gear (the sidebar's /settings nav item —
// retiring the mock's deliberate "two views of one location" pairing), the
// cost-mode cycle (Settings › Data › Cost mode, the same durable
// settings.costMode), and the inert USD badge (Settings › Data › Currency;
// it was never clickable and USD is the only v1 currency). Accepted
// trade-off: a non-default cost mode now leaves no trace outside Settings.
export function Topbar() {
  const location = useLocation();
  const dateRange = useFilters((s) => s.dateRange);
  const isLive = location.pathname === "/live";
  const isSettings = location.pathname === "/settings";
  const title = TITLES[location.pathname] ?? "MaxPrice";
  // The session-detail route's chrome (M5, T6): a circular glass back chip at
  // the pill's left edge, the session as the topbar h1. The bare in-page
  // "← Back to sessions" link is absorbed here.
  const detailSessionId = matchPath("/sessions/:id", location.pathname)?.params.id;

  // The Live page's subtitle (resolved range + the ADR-0041 fleet/seed line)
  // moved into the topbar with the title (the T5/T6 rule: page title/subtitle
  // live in the pill). Other routes keep their range label as the subtitle
  // until their reskin milestones refine it.
  const machineAxis = useMachineAxis();
  const hubSeed = useLiveStatus((s) => s.hubSeed);
  const saturated = useLiveStatus((s) => s.saturation?.saturated ?? false);
  // The Settings page's subtitle is its old page-header line, not a range —
  // the form is range-independent (M6, T7).
  const subtitle = isLive
    ? liveSubtitle({
        dateRange,
        seed: hubSeed,
        machineCount: machineAxis.folded.length,
        fleetOn: machineAxis.enabled,
        saturated,
      })
    : isSettings
      ? "Durable app configuration, stored in settings.json."
      : RANGE_LABEL[dateRange];

  return (
    <header className={cn("topbar panel shrink-0", detailSessionId && "has-back")}>
      <div className="tb-left">
        {detailSessionId ? (
          <SessionHeading id={detailSessionId} />
        ) : (
          <div className="min-w-0">
            <div className="title-row">
              <h1>{title}</h1>
              {isLive ? <StreamingBadge /> : null}
            </div>
            <p className="subtitle truncate">{subtitle}</p>
          </div>
        )}
      </div>
      <div className="tb-right">
        <RefreshPill />
        <ThemeChip />
      </div>
    </header>
  );
}

// The /sessions/:id heading: back chip + "Session <id8>" + a context
// subtitle. The subtitle's project path / machine / date come from the
// session's `/api/sessions` row (`useSessionRow` — the list's own cache); a
// deep link outside the rail's range misses the row and falls back to the
// full uuid. Machine only renders under the ADR-0041 M6 gate.
function SessionHeading({ id }: { id: string }) {
  const navigate = useNavigate();
  const { data: settings } = useSettings();
  const machineAxis = useMachineAxis();
  const row = useSessionRow(id);
  const subtitle = row
    ? [
        deriveProjectPath(row.path),
        machineAxis.enabled ? machineName(row.machineId, machineAxis.directory) : null,
        new Date(row.lastActivity).toLocaleDateString(undefined, {
          month: "short",
          day: "numeric",
          year: "numeric",
          timeZone: settings?.timezone,
        }),
      ]
        .filter(Boolean)
        .join(" · ")
    : id;

  // `replace` so the select → /sessions/:id → Back round trip consumes one
  // history slot — pairs with the { replace: true } on the Sessions-list
  // row-click param writes. Without it the browser back button from the
  // returned list would re-enter /sessions/:id.
  const onBack = () => navigate(`/sessions?selected=${encodeURIComponent(id)}`, { replace: true });

  return (
    <>
      <button
        type="button"
        onClick={onBack}
        aria-label="Back to sessions"
        title="Back to sessions"
        className="chip icon-chip back-chip"
      >
        <ArrowLeft aria-hidden />
      </button>
      <div className="min-w-0">
        <div className="title-row">
          <h1>Session {id.slice(0, 8)}</h1>
        </div>
        <p className="subtitle truncate">{subtitle}</p>
      </div>
    </>
  );
}

// The theme chip cycles system → light → dark and shows the PREFERENCE, not
// the resolved mode (ADR-0043): "system" is a meaningful state of its own.
//
// Icon-only, on the Sun/Moon/Monitor convention: the word "system" was mute
// about which mode had actually resolved, and the monitor reads as "follow
// the device" without needing the word. The resolved mode needs no glyph of
// its own — it is self-evident from the screen you are reading it on.
//
// The label WAS the accessible name, so an explicit one is now required —
// `themeChipLabel` (@maxprice/shared), shared with the hub console's chip so
// the two announce the same thing. The ICONS stay per-app: this app has
// lucide-react, the hub console has no icon library and transcribes the same
// three glyphs by hand.
const THEME_ICON = { system: Monitor, light: Sun, dark: Moon } as const;

function ThemeChip() {
  const { pref, cycle } = useTheme();
  const Icon = THEME_ICON[pref];
  const label = themeChipLabel(pref);
  return (
    <button
      type="button"
      onClick={cycle}
      aria-label={label}
      title={label}
      className="chip icon-chip"
    >
      <Icon aria-hidden />
    </button>
  );
}

const STREAM_BADGE: Record<ConnectionState, { tone: string; text: string }> = {
  connected: { tone: "", text: "streaming" },
  reconnecting: { tone: "warn", text: "reconnecting" },
  disconnected: { tone: "bad", text: "offline" },
};

// Live page-head badge — reflects the SSE connection state (Part 3), worn as
// the glass badge beside the topbar title.
function StreamingBadge() {
  const connectionState = useLiveStatus((s) => s.connectionState);
  const badge = STREAM_BADGE[connectionState];
  return (
    <span className={cn("badge", badge.tone)}>
      <span className="conn-dot" aria-hidden />
      {badge.text}
    </span>
  );
}
