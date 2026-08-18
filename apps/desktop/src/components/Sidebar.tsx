import { useEffect, useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import {
  Activity,
  Folder,
  Layers,
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
  SlidersHorizontal,
  Terminal,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useFilters } from "@/state/filters";
import { useSettings, useUpdateSettings } from "@/state/use-settings";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { FilterRail } from "./FilterRail";
import { StatusBar } from "./StatusBar";

const NAV = [
  { to: "/live", label: "Live", icon: Activity, showDot: true },
  { to: "/sessions", label: "Sessions", icon: Terminal, showDot: false },
  { to: "/projects", label: "Projects", icon: Folder, showDot: false },
  { to: "/blocks", label: "Blocks", icon: Layers, showDot: false },
  { to: "/settings", label: "Settings", icon: Settings, showDot: false },
] as const;

// The detached frosted sidebar (glass.html): identity, pill nav (Settings
// in-list, pulse dot on Live), then the absorbed filter rail. The old
// StatusBar's diagnostics live at the foot — relocation only, behaviors
// frozen (M2; the mock world has no status bar surface).
//
// SINCE T11 (map #151, ADR-0073) IT IS ONE PANEL AT TWO WIDTHS. 252 collapses
// to a 64px icon rail, and every difference between the two is a custom
// property set in `globals.css` §"the sidebar collapses to an icon rail" — the
// same nodes at two widths, never two markups. Nothing is re-homed: the filter
// rail and the status foot keep their exact composition, so `foot-status.ts`'s
// sticky-connecting and stale rules run once, here, as they always did.
//
// The state is "collapsed = the user collapsed it OR the window is too narrow",
// and the two halves live in different places on purpose:
//
//   · the WINDOW's half is a container query on `frame` (< 1072px) and is
//     invisible from here — this component never measures anything, which is
//     what keeps T1's vocabulary CSS-only;
//   · the USER's half is `settings.sidebarCollapsed`, read below.
//
// Because JS cannot see the first half, the two toggles that write those two
// halves are BOTH mounted and CSS picks one: `.sb-toggle-persist` above the
// threshold (where an expanded sidebar fits, so the click is a durable choice)
// and `.sb-toggle-flyout` below it (where it cannot fit, so the click is a
// transient peek that writes nothing). They wear the same shape, so the user
// sees one control that always does the only sensible thing at that width.
export function Sidebar() {
  const { data: settings } = useSettings();
  const collapsed = settings?.sidebarCollapsed ?? false;
  const update = useUpdateSettings();
  // The transient flyout — the panel widened over the content while the window
  // is too narrow to hold it in flow. Deliberately component state and not a
  // setting: it must never survive a relaunch, and `.sidebar` keeps its 64px
  // slot while it is open so expanding OVERLAYS and never pushes (pushing would
  // put narrow back at 452 content and destroy the band above it).
  const [flyout, setFlyout] = useState(false);
  const location = useLocation();

  // Non-modal dismissal: Esc, or a mousedown outside the panel. Deliberately
  // NOT on interaction inside it — several filters get flipped while watching
  // the chart, which is the whole reason the flyout is not a modal.
  useEffect(() => {
    if (!flyout) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFlyout(false);
    };
    const onDown = (e: MouseEvent) => {
      // The filter menus portal OUT of the panel, so a click on a project
      // checkbox is "outside" by DOM position while being inside by intent.
      const t = e.target as HTMLElement;
      if (!t.closest(".sidebar, [data-radix-popper-content-wrapper]")) setFlyout(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [flyout]);

  // NAVIGATING DISMISSES IT (the question T4 left open). A filter flip is
  // deliberately not a dismissal because its result is behind the panel and the
  // user wants several; a navigation's result IS the page behind the panel, so
  // leaving the flyout up covers the thing the click asked to see. This effect
  // catches every route change (the foot's "Session expired" link included);
  // the nav items also clear it on click, for a click on the page already open.
  useEffect(() => {
    setFlyout(false);
  }, [location.pathname]);

  return (
    // The slot. Its width is the layout's — 252 or 64 — and the panel inside is
    // absolutely positioned within it, which is what makes the flyout an
    // overlay. `data-collapsed` is the user's half of the state; the window's
    // half is the container query, and either one collapses the panel.
    <aside
      className={cn("sidebar", flyout && "open")}
      data-collapsed={collapsed || undefined}
      aria-label="Navigation and filters"
    >
      <div className="sidebar-panel panel thin-scroll">
        {/* Orb + wordmark only: the version chip moved to Settings › App info
            (map #100), where it sits beside the engine version it wants
            comparing against. Collapsed, the orb alone is the identity. */}
        <div className="identity">
          <span className="logo dollar" aria-hidden />
          <span className="sb-label wordmark">MaxPrice</span>
        </div>

        <nav className="nav" aria-label="Primary">
          {NAV.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              // Always present, so a collapsed icon says its own name on hover.
              // Redundant while expanded (the label is right there) and accepted:
              // the alternative needs the width this component cannot see.
              title={n.label}
              onClick={() => setFlyout(false)}
              className={({ isActive }) => cn(isActive && "active")}
            >
              {() => (
                <>
                  <n.icon aria-hidden />
                  {/* The clipped label keeps the link's accessible name while
                      collapsed — it is zero-width, not removed. */}
                  <span className="sb-label">{n.label}</span>
                  {/* The Live pulse rides the nav item on every page (T5 mock:
                      "Live keeps the pulse dot" while Sessions is active), and
                      travels from the icon's corner to the pill's right edge
                      as the panel widens. */}
                  {n.showDot ? <span className="pulse" aria-label="live" /> : null}
                </>
              )}
            </NavLink>
          ))}
        </nav>

        {/* One element, two readings: a 32px hairline over the filter door
            collapsed, the sidebar's full-width separator expanded. */}
        <div className="sep" aria-hidden />

        {/* The filter door — collapsed only. It exists so the expansion is the
            way to the WORDS, not the only way to the surfaces: the fields are
            one click away without widening anything. Its leaf is FilterRail
            verbatim, and only mounts while open, so at rest there is exactly
            one rail in the tree (the hidden one below). */}
        <Popover>
          <PopoverTrigger className="sb-door" title="Filters" aria-label="Filters">
            <SlidersHorizontal aria-hidden />
            <FilterBadge />
          </PopoverTrigger>
          <PopoverContent side="right" align="start" sideOffset={10} className="menu filter-leaf">
            <FilterRail />
          </PopoverContent>
        </Popover>

        {/* `visibility: hidden` while collapsed, not just zero-height: an
            invisible rail that is still tabbable is a trap. */}
        <div className="sb-fields">
          <FilterRail />
        </div>

        <div className="sb-foot">
          <StatusBar />
          {/* Above the collapse threshold: a durable choice, worth 188px of
              content — at viewport 1280 the click is exactly the duo → 3-up
              flip the tiles gained at T10. */}
          <button
            type="button"
            className="sb-toggle sb-toggle-persist"
            onClick={() => {
              setFlyout(false);
              void update({ sidebarCollapsed: !collapsed });
            }}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-pressed={collapsed}
          >
            {collapsed ? <PanelLeftOpen aria-hidden /> : <PanelLeftClose aria-hidden />}
            <span className="sb-label">Collapse</span>
          </button>
          {/* Below it: the transient flyout. Writes nothing — there is no room
              for 252px of sidebar down here whatever the user prefers. */}
          <button
            type="button"
            className="sb-toggle sb-toggle-flyout"
            onClick={() => setFlyout((v) => !v)}
            title={flyout ? "Collapse sidebar" : "Expand sidebar"}
            aria-label={flyout ? "Collapse sidebar" : "Expand sidebar"}
            aria-expanded={flyout}
          >
            {flyout ? <PanelLeftClose aria-hidden /> : <PanelLeftOpen aria-hidden />}
            <span className="sb-label">Collapse</span>
          </button>
        </div>
      </div>
    </aside>
  );
}

// How many filter axes are narrowed, as a badge on the collapsed door — the
// one thing the closed door cannot otherwise say. Date range is excluded: it
// always has a value, so counting it would mean the badge never reads zero.
function FilterBadge(): React.ReactElement | null {
  const projects = useFilters((s) => s.projects);
  const models = useFilters((s) => s.models);
  const machines = useFilters((s) => s.machines);
  const count =
    (projects.length > 0 ? 1 : 0) + (models.length > 0 ? 1 : 0) + (machines.length > 0 ? 1 : 0);
  if (count === 0) return null;
  return <span className="sb-badge">{count}</span>;
}
