// Logique pure de la disposition du tableau de bord : limites, réparation des chevauchements,
// lecture des réglages enregistrés. Séparée de la page pour être testée sans interface.

import type { LayoutItem } from "react-grid-layout";

import { ACCENTS, BACKGROUNDS, DEFAULT_BACKGROUND } from "./config";
import type { BackgroundSettings } from "./config";
import { WIDGETS, isWidgetType } from "./registry";
import type { WidgetType } from "./registry";

export const COLS = 12;
/** Le tableau tient toujours dans la fenêtre : 16 lignes dont la hauteur suit celle de l'écran. */
export const ROWS = 16;

/** Disposition d'origine (bouton « Réinitialiser »). */
export const DEFAULT_LAYOUT: { i: WidgetType; x: number; y: number }[] = [
  { i: "cpu", x: 0, y: 0 },
  { i: "memory", x: 6, y: 0 },
  { i: "system", x: 9, y: 0 },
  { i: "cores", x: 0, y: 5 },
  { i: "storage", x: 8, y: 5 },
  { i: "workspaces", x: 0, y: 12 },
  { i: "runs", x: 6, y: 12 },
];

/** Complète une position avec la taille par défaut et les limites du widget. */
export function withConstraints(item: { i: WidgetType; x: number; y: number; w?: number; h?: number }): LayoutItem {
  const { w, h, minW, minH } = WIDGETS[item.i].size;
  // Ramené dans les limites du tableau (dispositions enregistrées avant ce plafond).
  const cw = Math.min(Math.max(item.w ?? w, minW), COLS);
  const ch = Math.min(Math.max(item.h ?? h, minH), ROWS);
  const x = Math.max(0, Math.min(item.x, COLS - cw));
  const y = Math.max(0, Math.min(item.y, ROWS - ch));
  return { i: item.i, x, y, w: cw, h: ch, minW, minH };
}

export const defaultLayout = () => DEFAULT_LAYOUT.map(withConstraints);

/**
 * Remet une disposition (enregistrée ou renvoyée par la grille) en état : widgets inconnus
 * et doublons retirés, limites réappliquées, chevauchements réparés.
 */
export function normalizeLayout(items: readonly { i: string; x: number; y: number; w?: number; h?: number }[]): LayoutItem[] {
  const seen = new Set<string>();
  const known = items.filter((it) => isWidgetType(it.i) && !seen.has(it.i) && seen.add(it.i));
  return resolveOverlaps(known.map((it) => withConstraints(it as Parameters<typeof withConstraints>[0])));
}

/** Disposition enregistrée (JSON) ; disposition d'origine si absente ou illisible. */
export function parseLayout(raw: string | null): LayoutItem[] {
  if (!raw) return defaultLayout();
  try {
    // Les widgets disparus d'une version à l'autre sont ignorés ; les chevauchements enregistrés sont réparés.
    return normalizeLayout(JSON.parse(raw));
  } catch {
    return defaultLayout();
  }
}

/** Réglages du fond enregistrés (JSON), complétés et validés. */
export function parseBackground(raw: string | null): BackgroundSettings {
  try {
    const saved = JSON.parse(raw ?? "{}") as Partial<BackgroundSettings>;
    const bg = { ...DEFAULT_BACKGROUND, ...saved };
    // Valeurs inconnues (version précédente, fichier modifié) : retour au défaut.
    if (!BACKGROUNDS.some((b) => b.id === bg.kind)) bg.kind = DEFAULT_BACKGROUND.kind;
    if (!ACCENTS.includes(bg.accent)) bg.accent = DEFAULT_BACKGROUND.accent;
    bg.frameless = bg.frameless === true;
    return bg;
  } catch {
    return DEFAULT_BACKGROUND;
  }
}

/** Première place libre (de haut en bas, de gauche à droite) à la taille par défaut, sinon à la taille minimale. */
export function findFreeSpot(layout: LayoutItem[], type: WidgetType) {
  const { w, h, minW, minH } = WIDGETS[type].size;
  return findSpot(layout, w, h) ?? findSpot(layout, minW, minH);
}

const collide = (a: LayoutItem, b: LayoutItem) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

/**
 * Aucun widget ne doit en recouvrir un autre. Quand la grille pousse un widget vers le bas,
 * `withConstraints` le ramène dans le tableau… parfois sous un autre widget, qui le cache.
 * Chaque widget en conflit est donc déplacé vers la première place libre (à sa taille, sinon
 * à sa taille minimale). Faute de place, il garde sa position plutôt que de disparaître.
 */
export function resolveOverlaps(items: LayoutItem[]): LayoutItem[] {
  const placed: LayoutItem[] = [];
  const pending: LayoutItem[] = [];
  // Les plus grands gardent leur place : c'est le petit widget recouvert qui est déplacé.
  const bySize = [...items].sort((a, b) => b.w * b.h - a.w * a.h);
  for (const it of bySize) (placed.some((p) => collide(p, it)) ? pending : placed).push(it);
  for (const it of pending) {
    const spot = findSpot(placed, it.w, it.h) ?? findSpot(placed, it.minW ?? 1, it.minH ?? 1);
    placed.push(spot ? { ...it, ...spot } : it);
  }
  // Ordre d'origine conservé (la grille s'en sert pour les clés).
  return items.map((it) => placed.find((p) => p.i === it.i)!);
}

export function findSpot(layout: LayoutItem[], w: number, h: number) {
  const overlaps = (x: number, y: number) =>
    layout.some((it) => x < it.x + it.w && x + w > it.x && y < it.y + it.h && y + h > it.y);
  for (let y = 0; y + h <= ROWS; y++) {
    for (let x = 0; x + w <= COLS; x++) {
      if (!overlaps(x, y)) return { x, y, w, h };
    }
  }
  return null;
}
