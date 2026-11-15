import { AppWindow, Code2, FolderOpen, Globe, Play, type LucideIcon } from "lucide-react";

import type { AppShortcut, Project, WorkspaceStep } from "@/types";

export const STEP_KINDS: { kind: WorkspaceStep["kind"]; label: string; icon: LucideIcon }[] = [
  { kind: "editor", label: "Ouvrir dans l'éditeur", icon: Code2 },
  { kind: "script", label: "Lancer un script", icon: Play },
  { kind: "app", label: "Lancer une application", icon: AppWindow },
  { kind: "folder", label: "Ouvrir le dossier", icon: FolderOpen },
  { kind: "url", label: "Ouvrir une URL", icon: Globe },
];

export const stepIcon = (kind: WorkspaceStep["kind"]) => STEP_KINDS.find((k) => k.kind === kind)!.icon;

export function stepLabel(step: WorkspaceStep, projects: Project[], apps: AppShortcut[]): string {
  const project = (id: number) => projects.find((p) => p.id === id)?.name ?? "projet supprimé";
  switch (step.kind) {
    case "editor":
      return `${project(step.projectId)} dans l'éditeur`;
    case "folder":
      return `Dossier de ${project(step.projectId)}`;
    case "script":
      return `${project(step.projectId)} › ${step.script}${step.openBrowser ? " + navigateur" : ""}`;
    case "app":
      return `${apps.find((a) => a.id === step.appId)?.name ?? "application supprimée"}${step.closeOnStop ? " (fermée à l'arrêt)" : ""}`;
    case "url":
      return step.url;
  }
}

export function defaultStep(kind: WorkspaceStep["kind"], projects: Project[], apps: AppShortcut[]): WorkspaceStep {
  const projectId = projects[0]?.id ?? 0;
  switch (kind) {
    case "editor":
      return { kind, projectId };
    case "folder":
      return { kind, projectId };
    case "script":
      return { kind, projectId, script: "dev", openBrowser: true };
    case "app":
      return { kind, appId: apps[0]?.id ?? 0, closeOnStop: false };
    case "url":
      return { kind, url: "http://localhost:3000" };
  }
}
