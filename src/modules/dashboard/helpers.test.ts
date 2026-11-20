import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CcusageDay } from "@/types";
import { dayKey, streaks } from "./activity";
import { rangeLabel, usageDays, usd } from "./usage";

// Midi en heure locale : loin des changements de jour, quel que soit le fuseau.
const TODAY = new Date(2026, 2, 10, 12, 0, 0);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(TODAY);
});
afterEach(() => vi.useRealTimers());

const daysAgo = (n: number) => {
  const d = new Date(TODAY);
  d.setDate(d.getDate() - n);
  return dayKey(d);
};

describe("dayKey", () => {
  it("formate en AAAA-MM-JJ local, avec zéros", () => {
    expect(dayKey(new Date(2026, 0, 5))).toBe("2026-01-05");
    expect(dayKey(new Date(2026, 11, 31, 23, 59))).toBe("2026-12-31");
  });
});

describe("streaks", () => {
  it("vaut zéro sans activité", () => {
    expect(streaks(new Map())).toEqual({ current: 0, longest: 0 });
  });

  it("compte la série en cours jusqu'à aujourd'hui", () => {
    const counts = new Map([daysAgo(0), daysAgo(1), daysAgo(2)].map((k) => [k, 1]));
    expect(streaks(counts)).toEqual({ current: 3, longest: 3 });
  });

  it("garde la série d'hier si aujourd'hui est encore vide", () => {
    const counts = new Map([
      [daysAgo(0), 0],
      [daysAgo(1), 2],
      [daysAgo(2), 1],
    ]);
    expect(streaks(counts)).toEqual({ current: 2, longest: 2 });
  });

  it("casse la série en cours après un jour vide", () => {
    const counts = new Map([daysAgo(2), daysAgo(3)].map((k) => [k, 1]));
    expect(streaks(counts).current).toBe(0);
  });

  it("trouve la plus longue série, même ancienne et dans le désordre", () => {
    const counts = new Map<string, number>([
      [daysAgo(0), 1],
      [daysAgo(20), 1],
      [daysAgo(10), 1],
      [daysAgo(11), 1],
      [daysAgo(12), 1],
      [daysAgo(13), 0],
      [daysAgo(14), 1],
    ]);
    expect(streaks(counts)).toEqual({ current: 1, longest: 3 });
  });

  it("enchaîne les jours à travers un changement de mois", () => {
    const counts = new Map(["2026-02-27", "2026-02-28", "2026-03-01"].map((k) => [k, 1]));
    expect(streaks(counts).longest).toBe(3);
  });
});

describe("usd / rangeLabel", () => {
  it("affiche deux décimales sous 100 $, aucune au-delà", () => {
    expect(usd(0)).toBe("$0.00");
    expect(usd(3.456)).toBe("$3.46");
    expect(usd(99.99)).toBe("$99.99");
    expect(usd(1234.5)).toBe("$1235");
  });

  it("nomme les périodes", () => {
    expect(rangeLabel(7)).toBe("7 jours");
    expect(rangeLabel(365)).toBe("1 an");
  });
});

describe("usageDays", () => {
  const day = (period: string, totalCost: number, totalTokens: number): CcusageDay => ({
    period,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    totalTokens,
    totalCost,
    modelsUsed: [],
  });

  it("renvoie les N derniers jours, aujourd'hui en dernier, jours vides compris", () => {
    const report = { daily: [day(daysAgo(0), 1.5, 100), day(daysAgo(2), 3, 300), day(daysAgo(30), 9, 900)] };
    const days = usageDays(report, 4);
    expect(days.map((d) => d.key)).toEqual([daysAgo(3), daysAgo(2), daysAgo(1), daysAgo(0)]);
    expect(days.map((d) => d.cost)).toEqual([0, 3, 0, 1.5]);
    expect(days.map((d) => d.tokens)).toEqual([0, 300, 0, 100]);
    expect(days[1].r).toBe(report.daily[1]);
    expect(days[0].r).toBeUndefined();
  });

  it("place chaque date à minuit local", () => {
    const [d] = usageDays({ daily: [] }, 1);
    expect(d.date.getHours()).toBe(0);
    expect(d.key).toBe(dayKey(TODAY));
  });
});
