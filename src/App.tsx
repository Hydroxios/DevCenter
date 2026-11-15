import { Suspense, lazy, useEffect } from "react";
import { HashRouter, Navigate, Route, Routes } from "react-router";

import { AppLayout } from "@/components/layout/AppLayout";
import { useApplyTheme } from "@/hooks/useTheme";
import { DashboardPage } from "@/modules/dashboard/DashboardPage";
import { AutomationsPage } from "@/modules/automations/AutomationsPage";
// Chargé à la demande : xterm.js alourdit le bundle principal.
const ServersPage = lazy(() => import("@/modules/servers/ServersPage").then((m) => ({ default: m.ServersPage })));
import { WorkspacesPage } from "@/modules/workspaces/WorkspacesPage";
import { ProjectsPage } from "@/modules/projects/ProjectsPage";
import { SystemPage } from "@/modules/system/SystemPage";
import { SettingsPage } from "@/modules/settings/SettingsPage";
import { useRuns } from "@/stores/runs";
import { useSettings } from "@/stores/settings";
import { useUpdates } from "@/stores/updates";
import { useWorkspaces } from "@/stores/workspaces";

export default function App() {
  const load = useSettings((s) => s.load);
  const initRuns = useRuns((s) => s.init);
  const initWorkspaces = useWorkspaces((s) => s.init);
  const initUpdates = useUpdates((s) => s.init);
  useEffect(() => {
    load();
    initUpdates();
    initWorkspaces();
    // Les scripts continuent de tourner quand on quitte la page Projets : on suit leur état partout.
    initRuns();
  }, [load, initRuns, initWorkspaces, initUpdates]);
  useApplyTheme();

  return (
    <HashRouter>
      <Routes>
        <Route element={<AppLayout />}>
          <Route index element={<DashboardPage />} />
          <Route path="system" element={<SystemPage />} />
          <Route path="projects" element={<ProjectsPage />} />
          <Route path="workspaces" element={<WorkspacesPage />} />
          <Route
            path="servers"
            element={
              <Suspense fallback={null}>
                <ServersPage />
              </Suspense>
            }
          />
          <Route path="automations" element={<AutomationsPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </HashRouter>
  );
}
