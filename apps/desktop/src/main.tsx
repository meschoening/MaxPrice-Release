import React from "react";
import ReactDOM from "react-dom/client";
import { RouterProvider } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import { router } from "./routes/router";
import { Popout } from "./components/Popout";
import { currentWindowLabel } from "./lib/tauri";
import { isMacOS } from "./lib/platform";
import { queryClient } from "./lib/query";
import "./styles/globals.css";

// ONE bundle, branched on the webview window's label (the hub's ADR-0050
// pattern; map #168 / M2): the app mounts the router, the tray popout mounts
// <Popout/>. One dist, one CSP, shared lib/ + query-client setup — the popout
// parsing the app's bundle is noise on a warm, pre-created local webview.
// Crucially the popout branch never touches the router, so it can never run
// `showAppWindow()` (ADR-0066) and put the hidden MAIN window on screen.
const label = currentWindowLabel();

// The popout paints its own opaque ground (T3: it floats over the desktop,
// which backdrop-filter cannot blur through) — globals.css scopes the whole
// popout recipe under this body class, the hub's pattern.
if (label === "popout") {
  document.body.classList.add("popout-window");
  // macOS only, and stamped HERE rather than queried in CSS: the popout's
  // corners are rounded on both platforms but by different hands — Win11's DWM
  // curves the undecorated window itself, while macOS rounds nothing, so Rust
  // masks the window layer and this class curves the frame to match it.
  // Drawing our radius inside DWM's would leave a sliver of ground between the
  // two curves. Synchronous by design: a frame of square corners would be
  // visible on every open.
  if (isMacOS()) document.body.classList.add("popout-rounded");
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      {label === "popout" ? <Popout /> : <RouterProvider router={router} />}
    </QueryClientProvider>
  </React.StrictMode>,
);
