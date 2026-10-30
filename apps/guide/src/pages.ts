// The User guide's manifest (ADR-0131 §11): every page, in navigation order,
// with its source file, output path, navigation label and section. The build
// renders exactly these pages, and a relative link between source files is
// rewritten through this list to the target's output path (ADR-0135 §3).
//
// Output paths are flat `.html` files under dist/ (ADR-0131 §4). Four of them
// are permanent, because the products link them (ADR-0133 as amended):
// packages/shared/src/user-guide.ts names those four, and pages.test.ts holds
// each one here. Every other path may change until something outside the guide
// links it.
import { posix } from "node:path";

/** The sidebar's groups, in order (ADR-0133 §1). The Landing page has none. */
export const SECTIONS = [
  "Desktop client",
  "Hub tray app",
  "Headless client",
  "Headless Hub",
  "Concepts",
] as const;

export type Section = (typeof SECTIONS)[number];

export type Page = {
  /**
   * Repo-relative, forward-slashed: a guide page under apps/guide/pages/, or a
   * manual. Relative links resolve against it, so a link works on GitHub too.
   */
  source: string;
  /** Relative to dist/, mirroring the source's path under pages/. */
  out: string;
  label: string;
  /** null for the Landing page alone. */
  section: Section | null;
  /**
   * A manual's sections the Reference page leaves out, each written as its
   * heading line (ADR-0133 §3). The build fails when one is missing from the
   * manual, so a renamed heading cannot leak back into the page.
   */
  drop?: readonly string[];
};

/** The guide's app directory, repo-relative: Vite's root. */
export const APP_DIR = "apps/guide";

/** Where every guide page's Markdown lives, repo-relative. */
export const PAGES_DIR = `${APP_DIR}/pages`;

/**
 * Where the screenshots live, repo-relative: each a `<name>.light.png` and
 * `<name>.dark.png` pair (ADR-0134 §7), which a page shows by naming the light
 * frame (ADR-0135 §3).
 */
export const SCREENSHOTS_DIR = `${APP_DIR}/screenshots`;

/**
 * Every frame is captured at device scale factor 2 (ADR-0134 §7), so a page
 * shows it at half its pixel size: its size in the window it was taken from.
 */
export const SCREENSHOT_SCALE = 2;

/**
 * The note the scaffold gave every page until a content slice wrote it
 * (#566). Every page is written now, and pages.test.ts fails on any `.md` file
 * under pages/ whose text says "not written yet", in any case (#565 Q1).
 */
export const STUB_NOTE = "> [!NOTE]\n> This page is not written yet.\n";

/** The relative href from one page's output to another's. */
export function hrefBetween(from: Page, to: Page): string {
  return posix.relative(posix.dirname(from.out), to.out);
}

function guidePage(section: Section, path: string, label: string): Page {
  return { source: `${PAGES_DIR}/${path}.md`, out: `${path}.html`, label, section };
}

export const PAGES: readonly Page[] = [
  { source: `${PAGES_DIR}/index.md`, out: "index.html", label: "Home", section: null },

  guidePage("Desktop client", "desktop-client/overview", "Overview"),
  guidePage("Desktop client", "desktop-client/install", "Install"),
  guidePage("Desktop client", "desktop-client/first-run", "First run"),
  guidePage("Desktop client", "desktop-client/live", "Live"),
  guidePage("Desktop client", "desktop-client/sessions", "Sessions"),
  guidePage("Desktop client", "desktop-client/projects", "Projects"),
  guidePage("Desktop client", "desktop-client/blocks", "Blocks"),
  guidePage("Desktop client", "desktop-client/filters", "Filters and the Organization scope"),
  guidePage("Desktop client", "desktop-client/settings", "Settings"),
  guidePage("Desktop client", "desktop-client/tray", "Tray and Popout"),
  guidePage("Desktop client", "desktop-client/join-a-hub", "Join a Hub"),
  guidePage("Desktop client", "desktop-client/update", "Update"),
  guidePage("Desktop client", "desktop-client/troubleshooting", "Troubleshooting"),

  guidePage("Hub tray app", "hub-tray-app/overview", "Overview"),
  guidePage("Hub tray app", "hub-tray-app/install", "Install"),
  guidePage("Hub tray app", "hub-tray-app/popout-and-console", "The Popout and the console"),
  guidePage("Hub tray app", "hub-tray-app/join-clients", "Join clients"),
  guidePage("Hub tray app", "hub-tray-app/update-and-quit", "Update and quit"),
  guidePage("Hub tray app", "hub-tray-app/troubleshooting", "Troubleshooting"),

  guidePage("Headless client", "headless-client/overview", "Overview"),
  {
    source: "apps/cli/README.md",
    out: "headless-client/reference.html",
    label: "Reference",
    section: "Headless client",
    // The guide has its own navigation.
    drop: ["## Contents"],
  },

  guidePage("Headless Hub", "headless-hub/overview", "Overview"),
  {
    source: "apps/hub/README.md",
    out: "headless-hub/reference.html",
    label: "Reference",
    section: "Headless Hub",
    // Building from source is outside the guide's audience.
    drop: ["## Contents", "### From source", "## Development"],
  },
  guidePage("Headless Hub", "headless-hub/hub-page", "The Hub page"),

  guidePage("Concepts", "concepts/organizations", "Organizations"),
  guidePage("Concepts", "concepts/blocks", "Blocks and usage limits"),
  guidePage("Concepts", "concepts/cost-modes", "Cost modes and pricing"),
  guidePage("Concepts", "concepts/projects", "Projects"),
  guidePage("Concepts", "concepts/hubs", "Hubs and the fleet"),
  guidePage("Concepts", "concepts/archive", "The archive and where data lives"),
];
