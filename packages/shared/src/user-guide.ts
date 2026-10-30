// Where the User guide lives and the four pages the products open (ADR-0132
// §5, §6; ADR-0133 as amended). The product links read these, so code writes
// the URL once: the Desktop client's and the Hub tray app's App info rows, and
// the top-level `--help` of `maxprice` and `maxprice-hub` (#564, built by
// #569). The files that cannot import it, both apps' main-window capabilities
// and the release-notes skill and template, repeat it, and a test in each app
// and in scripts/release-tooling.test.ts holds each copy to it. The two
// READMEs link it as text: apps/guide/src/build.test.ts holds the overlay
// README's links, the mirror's front page, and the root README's one link is
// checked by hand.
//
// Each path is an output path in apps/guide/src/pages.ts, which
// apps/guide/src/pages.test.ts holds. Once a release ships one, it is in
// installed binaries, so it never changes (ADR-0131 §4).
//
// A leaf, which the binaries import as `@maxprice/shared/user-guide`:
// `maxprice --help` evaluates no Zod schema (apps/cli/src/main.ts's header),
// and the package's index evaluates all of them.
export const USER_GUIDE_URL = "https://meschoening.github.io/MaxPrice-Release/";

/** What the App info rows show: the URL without its scheme and its slash. */
export const USER_GUIDE_ADDRESS = USER_GUIDE_URL.replace(/^https:\/\//, "").replace(/\/$/, "");

/** Each product's Overview, relative to USER_GUIDE_URL. */
export const USER_GUIDE_PAGES = {
  desktopClient: "desktop-client/overview.html",
  hubTrayApp: "hub-tray-app/overview.html",
  headlessClient: "headless-client/overview.html",
  headlessHub: "headless-hub/overview.html",
} as const;
