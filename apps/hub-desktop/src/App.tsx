import { HubStatusCard } from "@/components/HubStatusCard";
import { ClaudeAccountCard } from "@/components/ClaudeAccountCard";
import { AccessCard } from "@/components/AccessCard";
import { ClientsRosterCard } from "@/components/ClientsRosterCard";
import { MachinesCard } from "@/components/MachinesCard";
import { UpdatesCard } from "@/components/UpdatesCard";
import { ToastHost } from "@/components/toast";
import { useHubMachines } from "@/state/use-hub-machines";
import { useHubStream } from "@/state/use-hub-stream";
import { NowTickProvider } from "@/state/use-now-tick";
import { themeChipLabel, useTheme } from "@/lib/theme";

export function App(): React.ReactElement {
  useHubStream();
  const machines = useHubMachines();

  // The tray tooltip is NOT driven from here anymore (ADR-0050, amending
  // ADR-0049): the popout webview owns it — it is the semantic tray surface,
  // always-alive like this window, and exactly one writer keeps the string
  // coherent. Popout.tsx carries the effect and its logging discipline.

  // The pill-header shell (NOTES §Hub console, T1): the lens orb + wordmark,
  // sticky at a 10px inset so cards slide beneath the frost. No bg on the tree
  // — the body paints the glass wash (ADR-0043).
  //
  // Identity only, and now a LONE wordmark: the version moved down to the App
  // info card, which is its sole home (map #143 — the client's own precedent,
  // map #100 T3, where the version left the sidebar identity row). The
  // `.identity` wrapper went with it rather than staying around one child: its
  // entire documented purpose was making the 14px wordmark and the 10.5px
  // version share a baseline, and a flex group around a lone child is a gap
  // that never applies. `.hub-header > .chip` already owns the auto margin, so
  // nothing else moved.
  //
  // The header's overall dot/label was removed earlier as a duplicate of the
  // Hub status card's own dot/label — the same overallDot/overallLabel pair,
  // rendered a few pixels below it, "Daemon unreachable" override included. The
  // tray tooltip still carries that state for the window-hidden case (the
  // effect above); nothing else read the header copy.
  return (
    <NowTickProvider>
      <header className="hub-header">
        <span className="logo rack" aria-hidden />
        <span className="wordmark">MaxPrice Hub</span>
        <ThemeChip />
      </header>
      <main className="cards">
        <HubStatusCard />
        <ClaudeAccountCard />
        <AccessCard />
        {machines.data === null ? <ClientsRosterCard /> : <MachinesCard />}
        <UpdatesCard />
      </main>
      <ToastHost />
    </NowTickProvider>
  );
}

// The theme chip cycles system → light → dark and shows the PREFERENCE, not
// the resolved mode (ADR-0043): "system" is a meaningful state of its own.
//
// Icon-only on the Sun/Moon/Monitor convention, matching the client topbar
// chip's ICONOGRAPHY — the two apps share one design system, so a worded chip
// here beside an iconic one there would be exactly the drift to avoid; the
// accessible name is now literally the same function (`themeChipLabel`,
// @maxprice/shared) rather than a second copy of the template. The glyphs are
// transcribed Lucide paths rather than an import: the hub console carries no
// icon library (see CaretIcon in MachinesCard), and three glyphs don't justify
// adding one. Geometry is the stylesheet's business, not this comment's: the
// hub header sizes its chip through its own `.chip` rule.
const THEME_ICON = { system: MonitorIcon, light: SunIcon, dark: MoonIcon } as const;

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
      <Icon />
    </button>
  );
}

// Lucide `sun` / `moon` / `monitor` (v1.16.0, ISC), transcribed in CaretIcon's
// house recipe: 24-box viewBox, currentColor stroke, round caps and joins.
function IconFrame({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {children}
    </svg>
  );
}

function SunIcon(): React.ReactElement {
  return (
    <IconFrame>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2" />
      <path d="M12 20v2" />
      <path d="m4.93 4.93 1.41 1.41" />
      <path d="m17.66 17.66 1.41 1.41" />
      <path d="M2 12h2" />
      <path d="M20 12h2" />
      <path d="m6.34 17.66-1.41 1.41" />
      <path d="m19.07 4.93-1.41 1.41" />
    </IconFrame>
  );
}

function MoonIcon(): React.ReactElement {
  return (
    <IconFrame>
      <path d="M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401" />
    </IconFrame>
  );
}

function MonitorIcon(): React.ReactElement {
  return (
    <IconFrame>
      <rect width="20" height="14" x="2" y="3" rx="2" />
      <line x1="8" x2="16" y1="21" y2="21" />
      <line x1="12" x2="12" y1="17" y2="21" />
    </IconFrame>
  );
}
