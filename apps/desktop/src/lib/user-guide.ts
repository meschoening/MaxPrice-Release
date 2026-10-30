import { openUrl } from "@tauri-apps/plugin-opener";
import { USER_GUIDE_PAGES, USER_GUIDE_URL } from "@maxprice/shared";
import { logClientEvent } from "./client-log";
import { insideTauri } from "./tauri";

// Settings › App info's User guide row (#564): the Desktop client's Overview,
// opened in the default browser. Only the main window's capability scopes the
// opener to the guide's URLs; the Popout links nowhere.
export const USER_GUIDE_HREF = `${USER_GUIDE_URL}${USER_GUIDE_PAGES.desktopClient}`;

// The link's click. Inside Tauri the webview would navigate itself away, so
// the URL goes to the opener instead; under Vite the browser follows the
// anchor's own href and target.
export function openUserGuide(event: React.MouseEvent<HTMLAnchorElement>): void {
  if (!insideTauri()) return;
  event.preventDefault();
  openUrl(USER_GUIDE_HREF).catch((err: unknown) => {
    logClientEvent(`app info: opening the User guide failed: ${String(err)}`);
  });
}
