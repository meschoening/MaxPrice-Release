import { useEffect } from "react";
import type { HubDaemonState, HubRowStatus } from "@maxprice/shared";
import orbSvg from "../../src-tauri/icons/icon-source.svg?raw";
import { pageFavicon, pageTitle } from "./tab";

// Writes the tab's title and favicon (tab.ts) to the document after each poll.
// The favicon swaps the href of page.html's one icon link, never adds a second:
// a browser may keep showing whichever link it read first.
export function useTab(daemon: HubDaemonState, status: HubRowStatus | undefined): void {
  const title = pageTitle(daemon);
  const favicon = pageFavicon(daemon, status, orbSvg);

  useEffect(() => {
    document.title = title;
  }, [title]);

  useEffect(() => {
    if (favicon === null) return;
    document.querySelector<HTMLLinkElement>('link[rel="icon"]')?.setAttribute("href", favicon);
  }, [favicon]);
}
