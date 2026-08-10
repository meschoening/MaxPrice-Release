import { NavLink } from "react-router-dom";
import { Activity, Folder, Layers, Settings, Terminal } from "lucide-react";
import { cn } from "@/lib/utils";
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
export function Sidebar() {
  return (
    <aside
      className="panel thin-scroll w-[252px] shrink-0 max-h-full overflow-y-auto flex flex-col px-4 py-[18px]"
      aria-label="Navigation and filters"
    >
      {/* Orb + wordmark only: the version chip moved to Settings › App info
          (map #100), where it sits beside the engine version it wants
          comparing against. */}
      <div className="identity">
        <span className="logo dollar" aria-hidden />
        <span className="wordmark">MaxPrice</span>
      </div>

      <nav className="nav" aria-label="Primary">
        {NAV.map((n) => (
          <NavLink key={n.to} to={n.to} className={({ isActive }) => cn(isActive && "active")}>
            {() => (
              <>
                <n.icon aria-hidden />
                {n.label}
                {/* The Live pulse rides the nav item on every page (T5 mock:
                    "Live keeps the pulse dot" while Sessions is active). */}
                {n.showDot ? <span className="pulse" aria-label="live" /> : null}
              </>
            )}
          </NavLink>
        ))}
      </nav>

      <div className="sep" aria-hidden />
      <FilterRail />
      <StatusBar />
    </aside>
  );
}
