// Constantes, types et réglages du tableau de bord. Séparés des composants : un fichier qui
// n'exporte que des composants garde le Fast Refresh de Vite en développement.

import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

import type { SystemInfo, SystemSnapshot } from "@/types";

export const REFRESH_MS = 2000;
/** Nombre de mesures conservées (150 × 2 s = 5 minutes, la plus longue fenêtre proposée). */
export const HISTORY_MAX = 150;

/* ------------------------------------------------------------------ */
/* Réglages par widget                                                 */
/* ------------------------------------------------------------------ */

export const ACCENTS = ["cyan", "green", "amber", "violet", "rose", "blue"] as const;
export type Accent = (typeof ACCENTS)[number];
export type HistoryWindow = 1 | 2 | 5;
/** Style des graphiques d'historique ; « none » désactive le graphique. */
/** Style des graphiques : courbes d'historique, simple jauge (« gauge ») ou rien du tout (« none »). */
export type ChartStyle = "area" | "line" | "smooth" | "step" | "bars" | "gauge" | "none";
/** Vrai si le style affiche un historique (et donc une durée). */
export const hasHistory = (c: ChartStyle | undefined) => c !== "gauge" && c !== "none";
export type ProcessSort = "cpu" | "memory";
/** Périodes proposées pour le widget Claude Code, en jours. */
export const USAGE_RANGES = [7, 14, 30, 90, 365] as const;
export type UsageRange = (typeof USAGE_RANGES)[number];

/** Réglages enregistrés pour un widget (tous facultatifs : valeurs par défaut sinon). */
export interface WidgetSettings {
  title?: string;
  accent?: Accent;
  /** false = en-tête masqué hors édition. */
  header?: boolean;
  window?: HistoryWindow;
  chart?: ChartStyle;
  count?: number;
  sort?: ProcessSort;
}

/** Réglages propres à certains widgets (en plus du titre, de la couleur et de l'en-tête). */
export type OptionKey = "window" | "chart" | "count" | "sort";

export const windowOf = (s: WidgetSettings) => s.window ?? 2;
/** Nombre de mesures affichées pour la fenêtre choisie. */
export const pointsOf = (s: WidgetSettings) => (windowOf(s) * 60000) / REFRESH_MS;

/** Données système partagées par tous les widgets (une seule interrogation pour tout le tableau). */
export interface DashboardData {
  snap: SystemSnapshot | null;
  info: SystemInfo | null;
  history: { cpu: number[]; mem: number[]; cores: number[][] };
}

export interface WidgetDef {
  title: string;
  description: string;
  icon: LucideIcon;
  /** Taille par défaut et minimale, en cases de grille (12 colonnes). */
  size: { w: number; h: number; minW: number; minH: number };
  aside?: (d: DashboardData, s: WidgetSettings) => ReactNode;
  render: (d: DashboardData, s: WidgetSettings) => ReactNode;
  /** Réglages propres proposés dans la fenêtre de personnalisation. */
  options?: readonly OptionKey[];
  /** « fill » : le contenu s'étire lui-même (graphiques) ; sinon il est mis à l'échelle pour tenir. */
  fit?: "fill";
  /** Sans en-tête, le widget perd aussi son fond et sa bordure (seul le contenu reste). */
  bareWithoutHeader?: boolean;
}

/* ------------------------------------------------------------------ */
/* Fond animé du tableau de bord                                       */
/* ------------------------------------------------------------------ */

export const BACKGROUNDS = [
  { id: "none", label: "Aucun" },
  { id: "neural", label: "Réseau neuronal" },
  { id: "fog", label: "Brouillard" },
  { id: "bubbles", label: "Bulles" },
  { id: "halos", label: "Halos" },
  { id: "waves", label: "Vagues" },
  { id: "code", label: "Pluie de code" },
  { id: "circuit", label: "Circuit" },
  { id: "grid", label: "Grille rétro" },
  { id: "scope", label: "Oscilloscope CPU" },
  { id: "aurora", label: "Aurore" },
  { id: "stars", label: "Étoiles" },
  { id: "fireflies", label: "Lucioles" },
  { id: "flow", label: "Flux" },
] as const;
export type BackgroundKind = (typeof BACKGROUNDS)[number]["id"];

export interface BackgroundSettings {
  kind: BackgroundKind;
  /** Couleur dominante (palette des widgets). */
  accent: Accent;
  /** Intensité de 0.2 à 1. */
  intensity: number;
  /** Vitesse de 0.25 à 2. */
  speed: number;
}

export const DEFAULT_BACKGROUND: BackgroundSettings = { kind: "none", accent: "cyan", intensity: 0.6, speed: 1 };
