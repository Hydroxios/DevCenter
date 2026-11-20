import type { LayoutItem } from "react-grid-layout";
import { describe, expect, it } from "vitest";

import { DEFAULT_BACKGROUND } from "./config";
import {
  COLS,
  DEFAULT_LAYOUT,
  ROWS,
  defaultLayout,
  findFreeSpot,
  findSpot,
  normalizeLayout,
  parseBackground,
  parseLayout,
  resolveOverlaps,
  withConstraints,
} from "./layout";
import { WIDGETS, isWidgetType } from "./registry";

const overlap = (a: LayoutItem, b: LayoutItem) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
const noOverlap = (items: LayoutItem[]) =>
  items.every((a, i) => items.every((b, j) => i === j || !overlap(a, b)));
const inBounds = (it: LayoutItem) => it.x >= 0 && it.y >= 0 && it.x + it.w <= COLS && it.y + it.h <= ROWS;

describe("isWidgetType", () => {
  it("reconnaît les widgets du catalogue", () => {
    for (const k of Object.keys(WIDGETS)) expect(isWidgetType(k)).toBe(true);
  });

  it("refuse les types inconnus, y compris les propriétés héritées d'Object", () => {
    expect(isWidgetType("nope")).toBe(false);
    expect(isWidgetType("toString")).toBe(false);
    expect(isWidgetType("constructor")).toBe(false);
    expect(isWidgetType("__proto__")).toBe(false);
  });
});

describe("withConstraints", () => {
  it("applique la taille par défaut et les minimums du widget", () => {
    const { w, h, minW, minH } = WIDGETS.cpu.size;
    expect(withConstraints({ i: "cpu", x: 0, y: 0 })).toEqual({ i: "cpu", x: 0, y: 0, w, h, minW, minH });
  });

  it("remonte une taille trop petite au minimum", () => {
    const it = withConstraints({ i: "cpu", x: 0, y: 0, w: 1, h: 1 });
    expect(it.w).toBe(WIDGETS.cpu.size.minW);
    expect(it.h).toBe(WIDGETS.cpu.size.minH);
  });

  it("plafonne la taille et ramène la position dans le tableau", () => {
    const it = withConstraints({ i: "cpu", x: 50, y: 99, w: 40, h: 40 });
    expect(it).toMatchObject({ x: 0, y: 0, w: COLS, h: ROWS });
    const moved = withConstraints({ i: "cpu", x: 10, y: 15, w: 4, h: 3 });
    expect(moved).toMatchObject({ x: COLS - 4, y: ROWS - 3 });
    expect(withConstraints({ i: "cpu", x: -3, y: -1 })).toMatchObject({ x: 0, y: 0 });
  });
});

describe("defaultLayout", () => {
  it("contient les widgets d'origine, dans le tableau et sans chevauchement", () => {
    const layout = defaultLayout();
    expect(layout.map((it) => it.i)).toEqual(DEFAULT_LAYOUT.map((it) => it.i));
    expect(layout.every(inBounds)).toBe(true);
    expect(noOverlap(layout)).toBe(true);
  });
});

describe("findSpot / findFreeSpot", () => {
  it("prend la première case libre de haut en bas, de gauche à droite", () => {
    expect(findSpot([], 3, 2)).toEqual({ x: 0, y: 0, w: 3, h: 2 });
    const layout = [withConstraints({ i: "cpu", x: 0, y: 0, w: 6, h: 4 })];
    expect(findSpot(layout, 6, 4)).toEqual({ x: 6, y: 0, w: 6, h: 4 });
    expect(findSpot(layout, 7, 4)).toEqual({ x: 0, y: 4, w: 7, h: 4 });
  });

  it("renvoie null quand le tableau est plein", () => {
    const full = [withConstraints({ i: "cpu", x: 0, y: 0, w: COLS, h: ROWS })];
    expect(findSpot(full, 1, 1)).toBeNull();
    expect(findFreeSpot(full, "memory")).toBeNull();
  });

  it("retombe sur la taille minimale faute de place à la taille par défaut", () => {
    // Il ne reste qu'une bande de 2 lignes en bas du tableau.
    const layout = [withConstraints({ i: "cores", x: 0, y: 0, w: COLS, h: ROWS - 2 })];
    const { minW, minH } = WIDGETS.cpu.size;
    expect(findFreeSpot(layout, "cpu")).toEqual({ x: 0, y: ROWS - 2, w: minW, h: minH });
  });
});

describe("resolveOverlaps", () => {
  it("laisse une disposition valide intacte", () => {
    const layout = defaultLayout();
    expect(resolveOverlaps(layout)).toEqual(layout);
  });

  it("déplace le plus petit widget recouvert et conserve l'ordre", () => {
    const big = withConstraints({ i: "cores", x: 0, y: 0, w: 8, h: 7 });
    const small = withConstraints({ i: "system", x: 2, y: 2, w: 3, h: 5 });
    const out = resolveOverlaps([small, big]);
    expect(out.map((it) => it.i)).toEqual(["system", "cores"]);
    expect(out[1]).toEqual(big);
    expect(out[0]).toMatchObject({ x: 8, y: 0, w: 3, h: 5 });
    expect(noOverlap(out)).toBe(true);
  });

  it("garde la position d'un widget qui ne trouve aucune place", () => {
    const full = withConstraints({ i: "cores", x: 0, y: 0, w: COLS, h: ROWS });
    const small = withConstraints({ i: "system", x: 1, y: 1 });
    const out = resolveOverlaps([full, small]);
    expect(out[1]).toEqual(small);
  });
});

describe("normalizeLayout", () => {
  it("ignore les widgets inconnus et les doublons", () => {
    const out = normalizeLayout([
      { i: "cpu", x: 0, y: 0, w: 6, h: 5 },
      { i: "ancien-widget", x: 0, y: 5, w: 4, h: 4 },
      { i: "toString", x: 0, y: 5, w: 4, h: 4 },
      { i: "cpu", x: 6, y: 0, w: 6, h: 5 },
    ]);
    expect(out.map((it) => it.i)).toEqual(["cpu"]);
    expect(out[0]).toMatchObject({ x: 0, y: 0 });
  });

  it("répare les chevauchements et les débordements", () => {
    const out = normalizeLayout([
      { i: "cpu", x: 0, y: 0, w: 6, h: 5 },
      { i: "memory", x: 3, y: 2, w: 3, h: 5 },
      { i: "storage", x: 11, y: 20, w: 4, h: 7 },
    ]);
    expect(out.every(inBounds)).toBe(true);
    expect(noOverlap(out)).toBe(true);
  });
});

describe("parseLayout", () => {
  it("rend la disposition d'origine si rien n'est enregistré ou si c'est illisible", () => {
    expect(parseLayout(null)).toEqual(defaultLayout());
    expect(parseLayout("")).toEqual(defaultLayout());
    expect(parseLayout("{pas du json")).toEqual(defaultLayout());
    expect(parseLayout('{"i":"cpu"}')).toEqual(defaultLayout());
  });

  it("relit une disposition enregistrée", () => {
    const saved = [
      { i: "cpu" as const, x: 0, y: 0, w: 6, h: 5 },
      { i: "memory" as const, x: 6, y: 0, w: 3, h: 5 },
    ];
    expect(parseLayout(JSON.stringify(saved))).toEqual(saved.map(withConstraints));
  });

  it("accepte une disposition vide (tous les widgets retirés)", () => {
    expect(parseLayout("[]")).toEqual([]);
  });
});

describe("parseBackground", () => {
  it("rend le fond par défaut sans réglage ou si c'est illisible", () => {
    expect(parseBackground(null)).toEqual(DEFAULT_BACKGROUND);
    expect(parseBackground("{oups")).toEqual(DEFAULT_BACKGROUND);
  });

  it("complète un réglage partiel (ancienne version sans « frameless »)", () => {
    expect(parseBackground('{"kind":"stars","intensity":0.4}')).toEqual({ ...DEFAULT_BACKGROUND, kind: "stars", intensity: 0.4 });
  });

  it("remplace les valeurs inconnues par les valeurs par défaut", () => {
    const bg = parseBackground('{"kind":"lava","accent":"pink","frameless":"yes"}');
    expect(bg.kind).toBe(DEFAULT_BACKGROUND.kind);
    expect(bg.accent).toBe(DEFAULT_BACKGROUND.accent);
    expect(bg.frameless).toBe(false);
  });

  it("conserve les réglages valides", () => {
    const saved = { kind: "aurora", accent: "violet", intensity: 0.8, speed: 1.5, frameless: true };
    expect(parseBackground(JSON.stringify(saved))).toEqual(saved);
  });

  it("ne modifie jamais l'objet par défaut", () => {
    parseBackground('{"kind":"stars","frameless":true}');
    expect(DEFAULT_BACKGROUND).toEqual({ kind: "none", accent: "cyan", intensity: 0.6, speed: 1, frameless: false });
  });
});
