import { Outlet, useLocation } from "react-router";

import { ErrorBoundary } from "@/components/ErrorBoundary";
import { Sidebar } from "./Sidebar";
import { TitleBar } from "./TitleBar";

/**
 * Toutes les pages sont des pages « application » : pleine largeur, chacune gère ses zones
 * de défilement (gabarit commun dans `Page.tsx`).
 */
export function AppLayout() {
  const { pathname } = useLocation();
  return (
    <div className="flex h-full flex-col overflow-hidden">
      <TitleBar />
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {/* Une erreur dans une page n'emporte pas la barre latérale ; changer de page la réinitialise. */}
          <ErrorBoundary key={pathname} scope={`page ${pathname}`}>
            <Outlet />
          </ErrorBoundary>
        </main>
      </div>
    </div>
  );
}
