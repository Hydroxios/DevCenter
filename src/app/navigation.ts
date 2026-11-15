import type { LucideIcon } from "lucide-react";
import {
  Cpu,
  FolderGit2,
  LayoutDashboard,
  Layers,
  Server,
  Settings as SettingsIcon,
  Workflow,
} from "lucide-react";

export interface NavItem {
  path: string;
  label: string;
  icon: LucideIcon;
  /** Phase de la roadmap où le module devient fonctionnel. */
  phase: number;
}

/** Registre des modules : ajouter un module = ajouter une entrée ici + une route dans App.tsx. */
export const mainNav: NavItem[] = [
  { path: "/", label: "Dashboard", icon: LayoutDashboard, phase: 1 },
  { path: "/system", label: "Système", icon: Cpu, phase: 2 },
  { path: "/projects", label: "Projets", icon: FolderGit2, phase: 3 },
  { path: "/workspaces", label: "Workspaces", icon: Layers, phase: 4 },
  { path: "/servers", label: "Serveurs", icon: Server, phase: 5 },
  { path: "/automations", label: "Automatisations", icon: Workflow, phase: 6 },
];

export const footerNav: NavItem[] = [{ path: "/settings", label: "Paramètres", icon: SettingsIcon, phase: 1 }];

export const CURRENT_PHASE = 7;
