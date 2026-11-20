// Catalogue des widgets du tableau de bord (séparé des composants pour le Fast Refresh de Vite).

import { Activity, Bot, CalendarClock, Clock, Cpu, GitCommitHorizontal, GitPullRequest, Gpu, HardDrive, Layers, ListOrdered, MemoryStick, Network, NotebookPen, Play, Server, Workflow } from "lucide-react";

import { ClockBody } from "./clock";
import { hasHistory, windowOf } from "./config";
import type { WidgetDef } from "./config";
import { CcusageWidget, CommitsBody, CoresBody, CpuBody, HardwareBody, MemoryBody, PortsBody, ProcessesBody, RunsBody, StorageBody, SystemBody, WidgetLink, WorkspacesBody } from "./widgets";
import { AutomationsBody } from "./widgets/automations";
import { GithubBody } from "./widgets/github";
import { NotesBody } from "./widgets/notes";
import { ServersBody } from "./widgets/servers";

/* ------------------------------------------------------------------ */
/* Catalogue                                                           */
/* ------------------------------------------------------------------ */

export const WIDGETS = {
  cpu: {
    title: "Processeur",
    description: "Charge totale et historique",
    icon: Cpu,
    size: { w: 6, h: 5, minW: 2, minH: 2 },
    aside: (_d, s) => hasHistory(s.chart) && <span className="meta">{windowOf(s)} min</span>,
    render: (d, s) => <CpuBody {...d} settings={s} />,
    options: ["window", "chart"],
    fit: "fill",
  },
  memory: {
    title: "Mémoire",
    description: "RAM, historique et swap",
    icon: MemoryStick,
    size: { w: 3, h: 5, minW: 2, minH: 2 },
    render: (d, s) => <MemoryBody {...d} settings={s} />,
    options: ["window", "chart"],
    fit: "fill",
  },
  system: {
    title: "Système",
    description: "Temps de fonctionnement et machine",
    icon: Clock,
    size: { w: 3, h: 5, minW: 2, minH: 2 },
    aside: () => <WidgetLink to="/system" />,
    render: (d) => <SystemBody {...d} />,
  },
  cores: {
    title: "Charge par cœur",
    description: "Un graphique par cœur logique",
    icon: Activity,
    size: { w: 8, h: 7, minW: 2, minH: 2 },
    aside: (d, s) =>
      d.snap && (
        <span className="meta">
          {d.snap.cpuPerCore.length} cœurs{hasHistory(s.chart) && ` · ${windowOf(s)} min`}
        </span>
      ),
    render: (d, s) => <CoresBody {...d} settings={s} />,
    options: ["window", "chart"],
    fit: "fill",
  },
  storage: {
    title: "Stockage",
    description: "Espace libre par disque",
    icon: HardDrive,
    size: { w: 4, h: 7, minW: 2, minH: 2 },
    render: (d) => <StorageBody {...d} />,
  },
  workspaces: {
    title: "Workspaces favoris",
    description: "Démarrage rapide des workspaces",
    icon: Layers,
    size: { w: 6, h: 4, minW: 2, minH: 2 },
    aside: () => <WidgetLink to="/workspaces">Tout voir</WidgetLink>,
    render: () => <WorkspacesBody />,
  },
  runs: {
    title: "Scripts",
    description: "En cours et récents, relance en un clic",
    icon: Play,
    size: { w: 6, h: 4, minW: 2, minH: 2 },
    aside: () => <WidgetLink to="/projects">Projets</WidgetLink>,
    render: () => <RunsBody />,
    bareWithoutHeader: true,
  },
  hardware: {
    title: "Carte graphique",
    description: "Charge GPU et température",
    icon: Gpu,
    size: { w: 4, h: 4, minW: 2, minH: 2 },
    aside: () => <WidgetLink to="/system" />,
    render: () => <HardwareBody />,
  },
  processes: {
    title: "Processus gourmands",
    description: "Les plus gourmands en CPU ou en mémoire",
    icon: ListOrdered,
    size: { w: 4, h: 7, minW: 2, minH: 2 },
    aside: () => <WidgetLink to="/system" />,
    render: (_d, s) => <ProcessesBody count={s.count} sort={s.sort} />,
    options: ["count", "sort"],
  },
  ports: {
    title: "Ports en écoute",
    description: "Ports de développement ouverts (3000–9999 ou scripts DevCenter)",
    icon: Network,
    size: { w: 4, h: 5, minW: 2, minH: 2 },
    aside: () => <WidgetLink to="/system" />,
    render: () => <PortsBody />,
  },
  commits: {
    title: "Commits",
    description: "Grille des contributions de tous les projets, façon GitHub",
    icon: GitCommitHorizontal,
    size: { w: 8, h: 4, minW: 3, minH: 2 },
    aside: () => <WidgetLink to="/projects">Projets</WidgetLink>,
    render: () => <CommitsBody />,
    fit: "fill",
  },
  clock: {
    title: "Horloge",
    description: "Heure et date, éléments affichés au choix",
    icon: CalendarClock,
    size: { w: 3, h: 3, minW: 2, minH: 2 },
    render: (_d, s) => <ClockBody settings={s} />,
    options: ["clock"],
    fit: "fill",
  },
  ccusage: {
    title: "Claude Code",
    description: "Coût et tokens par jour (ccusage)",
    icon: Bot,
    size: { w: 4, h: 4, minW: 2, minH: 2 },
    render: () => <CcusageWidget />,
    fit: "fill",
  },
  servers: {
    title: "Serveurs",
    description: "Serveurs SSH en ligne et latence",
    icon: Server,
    size: { w: 4, h: 4, minW: 2, minH: 2 },
    aside: () => <WidgetLink to="/servers" />,
    render: () => <ServersBody />,
    fit: "fill",
  },
  github: {
    title: "GitHub",
    description: "Pull requests et issues qui vous attendent",
    icon: GitPullRequest,
    size: { w: 5, h: 6, minW: 3, minH: 3 },
    render: () => <GithubBody />,
    fit: "fill",
  },
  automations: {
    title: "Automatisations",
    description: "Dernières exécutions, relance des favorites",
    icon: Workflow,
    size: { w: 5, h: 5, minW: 3, minH: 3 },
    aside: () => <WidgetLink to="/automations" />,
    render: () => <AutomationsBody />,
    fit: "fill",
  },
  notes: {
    title: "Notes",
    description: "Notes rapides et liste de tâches",
    icon: NotebookPen,
    size: { w: 4, h: 5, minW: 2, minH: 3 },
    render: () => <NotesBody widgetId="notes" />,
    fit: "fill",
  },
} satisfies Record<string, WidgetDef>;

export type WidgetType = keyof typeof WIDGETS;
// `Object.hasOwn` et non `in` : « toString », « constructor »… ne sont pas des widgets.
export const isWidgetType = (v: string): v is WidgetType => Object.hasOwn(WIDGETS, v);
