import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";

import { api, isTauri } from "@/services/tauri";
import type { RunInfo } from "@/types";

const MAX_LINES = 2000;

interface RunsState {
  runs: Record<number, RunInfo>;
  logs: Record<number, string[]>;
  error: string | null;
  init: () => Promise<void>;
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
  error: null,

  init: async () => {
    if (initialized || !isTauri()) return;
    initialized = true;

    await listen<RunInfo>("runner://status", ({ payload }) => {
      set((s) => {
        const runs = { ...s.runs, [payload.id]: payload };
        // Rust remplace l'ancienne exécution terminée d'un même script : on fait pareil ici.
        for (const r of Object.values(runs)) {
          if (r.id !== payload.id && r.projectId === payload.projectId && r.script === payload.script && r.status !== "running") {
            delete runs[r.id];
          }
        }
        return { runs };
      });
    });

    await listen<{ runId: number; line: string }>("runner://log", ({ payload }) => {
      set((s) => {
        const prev = s.logs[payload.runId] ?? [];
        const next = prev.length >= MAX_LINES ? [...prev.slice(prev.length - MAX_LINES + 1), payload.line] : [...prev, payload.line];
        return { logs: { ...s.logs, [payload.runId]: next } };
      });
    });

    try {
      const list = await api.runner.list();
      set({ runs: Object.fromEntries(list.map((r) => [r.id, r])) });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  loadLogs: async (runId) => {
    try {
      const lines = await api.runner.logs(runId);
      set((s) => ({ logs: { ...s.logs, [runId]: lines } }));
    } catch {
      /* exécution supprimée entre-temps */
    }
  },

  start: async (projectId, script) => {
    try {
      const run = await api.runner.run(projectId, script);
      set((s) => ({ runs: { ...s.runs, [run.id]: run }, logs: { ...s.logs, [run.id]: s.logs[run.id] ?? [] }, error: null }));
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

  dismiss: async (runId) => {
    await api.runner.dismiss(runId).catch(() => {});
    const { [runId]: _r, ...runs } = get().runs;
    const { [runId]: _l, ...logs } = get().logs;
    set({ runs, logs });
  },
}));

export const runsForProject = (runs: Record<number, RunInfo>, projectId: number) =>
  Object.values(runs).filter((r) => r.projectId === projectId);
