import { openUrl } from "@tauri-apps/plugin-opener";
import { USER_GUIDE_PAGES, USER_GUIDE_URL } from "@maxprice/shared";
import { logHubEvent } from "./hub-log";
import { insideTauri } from "./tauri";

// The App info card's User guide row (#564): the Hub tray app's Overview,
// opened in the default browser. Only the console's capability scopes the
// opener to the guide's URLs; the Popout links nowhere. A copy of the Desktop
// client's module: the two renderers share only packages/shared, which
// imports no Tauri plugin.
export const USER_GUIDE_HREF = `${USER_GUIDE_URL}${USER_GUIDE_PAGES.hubTrayApp}`;

// The link's click. Inside Tauri the webview would navigate itself away, so
// the URL goes to the opener instead; under Vite the browser follows the
// anchor's own href and target.
export function openUserGuide(event: React.MouseEvent<HTMLAnchorElement>): void {
  if (!insideTauri()) return;
  event.preventDefault();
  openUrl(USER_GUIDE_HREF).catch((err: unknown) => {
    logHubEvent(`app info: opening the User guide failed: ${String(err)}`);
  });
}
