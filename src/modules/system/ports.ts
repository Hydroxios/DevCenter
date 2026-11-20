// Outils partagés par l'onglet « Ports en écoute » et le widget du tableau de bord.

import { useCallback } from "react";

import { useWorkspaces } from "@/stores/workspaces";
import type { ListeningPort } from "@/types";

export const portUrl = (port: number) => `http://localhost:${port}`;
export const portKey = (p: ListeningPort) => `${p.protocol}-${p.port}-${p.pid}`;

/** Nom du projet DevCenter d'un port (ou null). */
export function useRunLabel() {
  const projects = useWorkspaces((s) => s.projects);
  return useCallback(
    (p: ListeningPort) => {
      if (!p.run) return null;
      const project = projects.find((x) => x.id === p.run!.projectId)?.name ?? `Projet ${p.run.projectId}`;
      return `${project} · ${p.run.script}`;
    },
    [projects],
  );
}
