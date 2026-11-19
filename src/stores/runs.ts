import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";

import { api, isTauri } from "@/services/tauri";
import type { RunInfo } from "@/types";

const MAX_LINES = 2000;
const RECENT_KEY = "devcenter.runs.recent";
const MAX_RECENT = 12;

/** Script lancé récemment (gardé d'une session à l'autre pour le relancer en un clic). */
export interface RecentScript {
  projectId: number;
  script: string;
  /** Horodatage Unix (secondes) du dernier lancement. */
  lastRunAt: number;
}

function loadRecent(): RecentScript[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]") as RecentScript[];
  } catch {
    return [];
  }
}

function saveRecent(recent: RecentScript[]) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(recent));
  } catch {
    /* stockage indisponible */
  }
}

/** Place le script en tête des récents (sans doublon), en gardant les plus récents. */
function withRecent(recent: RecentScript[], run: RunInfo): RecentScript[] {
  const others = recent.filter((r) => !(r.projectId === run.projectId && r.script === run.script));
  const prev = recent.find((r) => r.projectId === run.projectId && r.script === run.script);
  const lastRunAt = Math.max(run.startedAt, prev?.lastRunAt ?? 0);
  return [{ projectId: run.projectId, script: run.script, lastRunAt }, ...others]
    .sort((a, b) => b.lastRunAt - a.lastRunAt)
    .slice(0, MAX_RECENT);
}

interface RunsState {
  runs: Record<number, RunInfo>;
  logs: Record<number, string[]>;
  /**
   * Nombre de lignes retirées en tête de `logs` (tampon plein) depuis le chargement :
   * `logBase + index` identifie une ligne de façon stable (clé React).
   */
  logBase: Record<number, number>;
  error: string | null;
  recent: RecentScript[];
  init: () => Promise<void>;
  forgetRecent: (projectId: number, script: string) => void;
  loadLogs: (runId: number) => Promise<void>;
  start: (projectId: number, script: string) => Promise<RunInfo | null>;
  stop: (runId: number) => Promise<void>;
  dismiss: (runId: number) => Promise<void>;
}

let initialized = false;

/** Exécutions de scripts : état synchronisé avec Rust via les événements `runner://*`. */
export const useRuns = create<RunsState>((set, get) => ({
  runs: {},
  logs: {},
  logBase: {},
  error: null,
  recent: loadRecent(),

  init: async () => {
    if (initialized || !isTauri()) return;
    initialized = true;

    await listen<RunInfo>("runner://status", ({ payload }) => {
      set((s) => {
        const runs = { ...s.runs, [payload.id]: payload };
        const recent = payload.status === "running" ? withRecent(s.recent, payload) : s.recent;
        if (recent !== s.recent) saveRecent(recent);
        // Rust remplace l'ancienne exécution terminée d'un même script : on fait pareil ici.
        for (const r of Object.values(runs)) {
          if (r.id !== payload.id && r.projectId === payload.projectId && r.script === payload.script && r.status !== "running") {
            delete runs[r.id];
          }
        }
        return { runs, recent };
      });
    });

    // Les lignes arrivent par lots (au plus un événement toutes les 50 ms par exécution).
    await listen<{ runId: number; lines: string[] }>("runner://log", ({ payload }) => {
      set((s) => {
        const { runId, lines } = payload;
        const prev = s.logs[runId] ?? [];
        const all = prev.concat(lines);
        const drop = Math.max(0, all.length - MAX_LINES);
        return {
          logs: { ...s.logs, [runId]: drop ? all.slice(drop) : all },
          logBase: drop ? { ...s.logBase, [runId]: (s.logBase[runId] ?? 0) + drop } : s.logBase,
        };
      });
    });

    try {
      const list = await api.runner.list();
      const recent = list.reduce(withRecent, get().recent);
      saveRecent(recent);
      set({ runs: Object.fromEntries(list.map((r) => [r.id, r])), recent });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  loadLogs: async (runId) => {
    try {
      const lines = await api.runner.logs(runId);
      set((s) => ({ logs: { ...s.logs, [runId]: lines }, logBase: { ...s.logBase, [runId]: 0 } }));
    } catch {
      /* exécution supprimée entre-temps */
    }
  },

  start: async (projectId, script) => {
    try {
      const run = await api.runner.run(projectId, script);
      set((s) => {
        const recent = withRecent(s.recent, run);
        saveRecent(recent);
        return { runs: { ...s.runs, [run.id]: run }, logs: { ...s.logs, [run.id]: s.logs[run.id] ?? [] }, recent, error: null };
      });
      return run;
    } catch (e) {
      set({ error: String(e) });
      return null;
    }
  },

  stop: async (runId) => {
    try {
      await api.runner.stop(runId);
    } catch (e) {
      set({ error: String(e) });
    }
  },

  forgetRecent: (projectId, script) => {
    const recent = get().recent.filter((r) => !(r.projectId === projectId && r.script === script));
    saveRecent(recent);
    set({ recent });
  },

  dismiss: async (runId) => {
    await api.runner.dismiss(runId).catch(() => {});
    const { [runId]: _r, ...runs } = get().runs;
    const { [runId]: _l, ...logs } = get().logs;
    const { [runId]: _b, ...logBase } = get().logBase;
    set({ runs, logs, logBase });
  },
}));

export const runsForProject = (runs: Record<number, RunInfo>, projectId: number) =>
  Object.values(runs).filter((r) => r.projectId === projectId);
