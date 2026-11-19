import { Outlet, useLocation } from "react-router";

import { ErrorBoundary } from "@/components/ErrorBoundary";
import { useFullscreen } from "@/stores/fullscreen";
import { Dock } from "./Dock";
import { Sidebar } from "./Sidebar";
import { TitleBar } from "./TitleBar";

/**
 * Toutes les pages sont des pages « application » : pleine largeur, chacune gère ses zones
 * de défilement (gabarit commun dans `Page.tsx`). En plein écran, la barre de titre et la
 * barre latérale laissent place à un dock en bas.
 */
export function AppLayout() {
  const { pathname } = useLocation();
  const fullscreen = useFullscreen((s) => s.fullscreen);
  return (
    <div className="relative flex h-full flex-col overflow-hidden">
      {!fullscreen && <TitleBar />}
      <div className="flex min-h-0 flex-1">
        {!fullscreen && <Sidebar />}
        <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {/* Une erreur dans une page n'emporte pas la navigation ; changer de page la réinitialise. */}
          <ErrorBoundary key={pathname} scope={`page ${pathname}`}>
            <Outlet />
          </ErrorBoundary>
        </main>
      </div>
      {fullscreen && <Dock />}
    </div>
  );
}
