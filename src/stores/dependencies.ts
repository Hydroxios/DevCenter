import { create } from "zustand";

import { api } from "@/services/tauri";
import type { DependencyReport, DependencySummary } from "@/types";

/**
 * Santé des dépendances par projet. Les rapports sont gardés en base côté Rust : on charge les
 * résumés une fois (pastilles de la liste), le rapport complet à l'ouverture de l'onglet.
 * Une vérification continue même si l'utilisateur change de projet ou de page.
 */
interface DependenciesState {
  summaries: Record<number, DependencySummary>;
  reports: Record<number, DependencyReport | null>;
  checking: Record<number, boolean>;
  errors: Record<number, string | undefined>;
  init: () => void;
  loadReport: (id: number) => Promise<void>;
  check: (id: number) => Promise<void>;
}

let initialized = false;

function summarize(r: DependencyReport): DependencySummary {
  return {
    projectId: r.projectId,
    checkedAt: r.checkedAt,
    outdated: r.outdated.length,
    major: r.outdated.filter((p) => p.major).length,
    vulnCounts: r.vulnCounts,
  };
}

export const useDependencies = create<DependenciesState>((set, get) => ({
  summaries: {},
  reports: {},
  checking: {},
  errors: {},

  init: () => {
    if (initialized) return;
    initialized = true;
    api.dependencies
      .summaries()
      .then((list) => set({ summaries: Object.fromEntries(list.map((s) => [s.projectId, s])) }))
      .catch(() => {
        initialized = false;
      });
  },

  loadReport: async (id) => {
    if (id in get().reports) return;
    try {
      const report = await api.dependencies.report(id);
      set((s) => ({ reports: { ...s.reports, [id]: report } }));
    } catch (e) {
      set((s) => ({ errors: { ...s.errors, [id]: String(e) } }));
    }
  },

  check: async (id) => {
    if (get().checking[id]) return;
    set((s) => ({ checking: { ...s.checking, [id]: true }, errors: { ...s.errors, [id]: undefined } }));
    try {
      const report = await api.dependencies.check(id);
      set((s) => ({
        reports: { ...s.reports, [id]: report },
        summaries: { ...s.summaries, [id]: summarize(report) },
      }));
    } catch (e) {
      set((s) => ({ errors: { ...s.errors, [id]: String(e) } }));
    } finally {
      set((s) => ({ checking: { ...s.checking, [id]: false } }));
    }
  },
}));
