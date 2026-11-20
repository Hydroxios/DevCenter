import { describe, expect, it } from "vitest";

import { ACCENTS, BACKGROUNDS, DEFAULT_BACKGROUND, HISTORY_MAX, REFRESH_MS, USAGE_RANGES, hasHistory, pointsOf, windowOf } from "./config";

describe("hasHistory", () => {
  it("est vrai pour les styles de courbe (et par défaut)", () => {
    for (const c of ["area", "line", "smooth", "step", "bars"] as const) expect(hasHistory(c)).toBe(true);
    expect(hasHistory(undefined)).toBe(true);
  });

  it("est faux pour la jauge et l'absence de graphique", () => {
    expect(hasHistory("gauge")).toBe(false);
    expect(hasHistory("none")).toBe(false);
  });
});

describe("windowOf / pointsOf", () => {
  it("prend 2 minutes par défaut", () => {
    expect(windowOf({})).toBe(2);
    expect(pointsOf({})).toBe(60);
  });

  it("convertit la fenêtre en nombre de mesures", () => {
    expect(pointsOf({ window: 1 })).toBe(60000 / REFRESH_MS);
    expect(pointsOf({ window: 5 })).toBe(150);
  });

  it("ne dépasse jamais l'historique conservé", () => {
    for (const window of [1, 2, 5] as const) expect(pointsOf({ window })).toBeLessThanOrEqual(HISTORY_MAX);
  });
});

describe("constantes", () => {
  it("a des identifiants de fond uniques, dont « none »", () => {
    const ids = BACKGROUNDS.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("none");
  });

  it("a un fond par défaut valide et dans les bornes", () => {
    expect(BACKGROUNDS.some((b) => b.id === DEFAULT_BACKGROUND.kind)).toBe(true);
    expect(ACCENTS).toContain(DEFAULT_BACKGROUND.accent);
    expect(DEFAULT_BACKGROUND.intensity).toBeGreaterThanOrEqual(0.2);
    expect(DEFAULT_BACKGROUND.intensity).toBeLessThanOrEqual(1);
    expect(DEFAULT_BACKGROUND.speed).toBeGreaterThanOrEqual(0.25);
    expect(DEFAULT_BACKGROUND.speed).toBeLessThanOrEqual(2);
    expect(DEFAULT_BACKGROUND.frameless).toBe(false);
  });

  it("propose des périodes croissantes", () => {
    expect([...USAGE_RANGES]).toEqual([...USAGE_RANGES].sort((a, b) => a - b));
  });
});
