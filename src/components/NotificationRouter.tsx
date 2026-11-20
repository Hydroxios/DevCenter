import { useEffect } from "react";
import { useNavigate } from "react-router";
import { listen } from "@tauri-apps/api/event";

import { isTauri } from "@/services/tauri";
import type { NotificationTarget } from "@/types";

/** URL de l'élément ouvert au clic sur une notification Windows. */
export function targetUrl(t: NotificationTarget): string {
  switch (t.kind) {
    case "run":
      return `/projects?project=${t.projectId}&run=${t.runId}`;
    case "automation":
      return `/automations?automation=${t.automationId}${t.runId !== null ? `&run=${t.runId}` : ""}`;
    case "workspace":
      return `/workspaces?workspace=${t.workspaceId}`;
    case "projects":
      return "/projects";
  }
}

/** Clic sur une notification (ou « Voir les logs ») : Rust ramène la fenêtre, on navigue. */
export function NotificationRouter() {
  const navigate = useNavigate();
  useEffect(() => {
    if (!isTauri()) return;
    const unlisten = listen<NotificationTarget>("notification://open", (e) => navigate(targetUrl(e.payload)));
    return () => {
      unlisten.then((f) => f());
    };
  }, [navigate]);
  return null;
}
