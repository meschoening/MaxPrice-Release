import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HubPage } from "./HubPage";
import "./page.css";

// The Hub page's entry (ADR-0124 §7), page.html's one module. Its own query
// client, never lib/query.ts's: the tray app's defaults turn focus refetch off
// and retry once, and the page wants a focus refetch and no retry. The page's
// hook carries every option it relies on, so TanStack's defaults do here.
const queryClient = new QueryClient();

// The page names its host only from location.host, verbatim (ADR-0124 §7).
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <HubPage host={window.location.host} />
    </QueryClientProvider>
  </React.StrictMode>,
);
