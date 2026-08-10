import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { App } from "./App";
import { Popout, PopoutErrorBoundary, TrayTooltip } from "./Popout";
import { currentWindowLabel } from "./lib/tauri";
import { queryClient } from "./lib/query";
import "./styles/globals.css";

// ONE bundle, branched on the webview window's label (ADR-0050): the console
// mounts <App/>, the tray popout mounts <Popout/>. One dist, one CSP, shared
// lib/ + query-client setup — the popout parsing the console's bundle is noise
// on a warm, pre-created local webview. The body class scopes the popout's
// opaque composite material in globals.css.
const label = currentWindowLabel();
if (label === "popout") document.body.classList.add("popout-window");

// The popout tree is the one branch that gets an error boundary: it is a
// frameless tray window with no titlebar, no menu and no reload, so an
// uncaught render error would strand the user with a blank 224x224 square.
// <TrayTooltip/> sits OUTSIDE the boundary as a render-nothing sibling — the
// tray tooltip is the only hub UI while both windows are hidden, and it must
// keep writing even if the popout's own tree is down (see Popout.tsx).
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      {label === "popout" ? (
        <>
          <TrayTooltip />
          <PopoutErrorBoundary>
            <Popout />
          </PopoutErrorBoundary>
        </>
      ) : (
        <App />
      )}
    </QueryClientProvider>
  </React.StrictMode>,
);
