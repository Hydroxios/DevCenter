import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cn, formatBytes, formatDuration, formatRelative } from "./utils";

describe("cn", () => {
  it("joint les classes et ignore les valeurs fausses", () => {
    expect(cn("a", false, null, undefined, "b", { c: true, d: false })).toBe("a b c");
  });

  it("laisse tailwind-merge résoudre les conflits (la dernière gagne)", () => {
    expect(cn("px-2 py-1", "px-4")).toBe("py-1 px-4");
    expect(cn("text-red-500", "text-primary")).toBe("text-primary");
  });
});

describe("formatBytes", () => {
  it("affiche 0 o pour zéro ou une valeur absente", () => {
    expect(formatBytes(0)).toBe("0 o");
    expect(formatBytes(NaN)).toBe("0 o");
  });

  it("choisit l'unité binaire adaptée", () => {
    expect(formatBytes(512)).toBe("512.0 o");
    expect(formatBytes(1024)).toBe("1.0 Ko");
    expect(formatBytes(1536)).toBe("1.5 Ko");
    expect(formatBytes(1024 ** 2 * 3)).toBe("3.0 Mo");
    expect(formatBytes(1024 ** 3 * 16)).toBe("16.0 Go");
    expect(formatBytes(1024 ** 4 * 2)).toBe("2.0 To");
  });

  it("plafonne à l'unité la plus grande", () => {
    expect(formatBytes(1024 ** 5)).toBe("1024.0 To");
  });

  it("respecte le nombre de décimales demandé", () => {
    expect(formatBytes(1536, 0)).toBe("2 Ko");
    expect(formatBytes(1536, 2)).toBe("1.50 Ko");
  });
});

describe("formatDuration", () => {
  it("affiche les minutes sous une heure", () => {
    expect(formatDuration(0)).toBe("0 min");
    expect(formatDuration(59)).toBe("0 min");
    expect(formatDuration(125)).toBe("2 min");
  });

  it("affiche heures et minutes sous un jour", () => {
    expect(formatDuration(3600)).toBe("1 h 0 min");
    expect(formatDuration(3600 * 5 + 60 * 7)).toBe("5 h 7 min");
  });

  it("affiche jours et heures au-delà", () => {
    expect(formatDuration(86400)).toBe("1 j 0 h");
    expect(formatDuration(86400 * 3 + 3600 * 4 + 59 * 60)).toBe("3 j 4 h");
  });
});

describe("formatRelative", () => {
  const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);
  const now = NOW / 1000;
  const rtf = new Intl.RelativeTimeFormat("fr", { numeric: "auto" });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it("utilise les secondes sous une minute", () => {
    expect(formatRelative(now)).toBe(rtf.format(0, "second"));
    expect(formatRelative(now - 30)).toBe(rtf.format(-30, "second"));
  });

  it("monte d'unité selon l'écart", () => {
    expect(formatRelative(now - 5 * 60)).toBe(rtf.format(-5, "minute"));
    expect(formatRelative(now - 3 * 3600)).toBe(rtf.format(-3, "hour"));
    expect(formatRelative(now - 2 * 86400)).toBe(rtf.format(-2, "day"));
    expect(formatRelative(now - 60 * 86400)).toBe(rtf.format(-2, "month"));
    expect(formatRelative(now - 2 * 365 * 86400)).toBe(rtf.format(-2, "year"));
  });

  it("gère les dates futures", () => {
    expect(formatRelative(now + 3600)).toBe(rtf.format(1, "hour"));
  });

  it("produit un texte français", () => {
    expect(formatRelative(now - 3 * 3600)).toMatch(/il y a 3 heures/);
  });
});
