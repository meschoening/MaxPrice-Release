import { createBrowserRouter, Navigate } from "react-router-dom";
import { Layout } from "@/components/Layout";
import { LivePage } from "@/pages/Live";
import { SessionDetailPage } from "@/pages/SessionDetail";
import { ProjectsPage } from "@/pages/Projects";
import { SettingsPage } from "@/pages/Settings";

export const router = createBrowserRouter([
  {
    path: "/",
    element: <Layout />,
    children: [
      { index: true, element: <Navigate to="/live" replace /> },
      { path: "live", element: <LivePage /> },
      { path: "sessions/:id", element: <SessionDetailPage /> },
      { path: "projects", element: <ProjectsPage /> },
      { path: "settings", element: <SettingsPage /> },
    ],
  },
]);
