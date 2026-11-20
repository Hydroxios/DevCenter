import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";

import { api, isTauri } from "@/services/tauri";
import type { AppShortcut, Project, Tunnel, Workspace, WorkspaceInput } from "@/types";

interface WorkspacesState {
  workspaces: Workspace[] | null;
  /** Projets et applications, pour afficher les étapes par leur nom. */
  projects: Project[];
  apps: AppShortcut[];
  /** Tunnels SSH (étapes « Ouvrir / Fermer un tunnel »). */
  tunnels: Tunnel[];
  /** Workspace en cours de démarrage/arrêt (bouton occupé). */
  busy: number | null;
  error: string | null;
  init: () => Promise<void>;
  refresh: () => Promise<void>;
  refreshRefs: () => Promise<void>;
  save: (input: WorkspaceInput) => Promise<boolean>;
  remove: (id: number) => Promise<void>;
  toggleFavorite: (w: Workspace) => Promise<void>;
  start: (id: number) => Promise<void>;
  stop: (id: number) => Promise<void>;
  clearError: () => void;
}

let initialized = false;

export const useWorkspaces = create<WorkspacesState>((set, get) => {
  const guard = async (fn: () => Promise<void>) => {
    try {
      await fn();
      set({ error: null });
    } catch (e) {
      set({ error: String(e) });
    }
  };

  return {
    workspaces: null,
    projects: [],
    apps: [],
    tunnels: [],
    busy: null,
    error: null,

    init: async () => {
      if (initialized || !isTauri()) return;
      initialized = true;
      await listen("workspace://changed", () => get().refresh());
      await Promise.all([get().refresh(), get().refreshRefs()]);
    },

    refresh: () => guard(async () => set({ workspaces: await api.workspaces.list() })),

    refreshRefs: () =>
      guard(async () => {
        const [projects, apps, tunnels] = await Promise.all([api.projects.list(), api.apps.list(), api.tunnels.list()]);
        set({ projects, apps, tunnels });
      }),

    save: async (input) => {
      try {
        set({ workspaces: await api.workspaces.save(input), error: null });
        return true;
      } catch (e) {
        set({ error: String(e) });
        return false;
      }
    },

    remove: (id) => guard(async () => set({ workspaces: await api.workspaces.remove(id) })),

    toggleFavorite: (w) => guard(async () => set({ workspaces: await api.workspaces.setFavorite(w.id, !w.favorite) })),

    start: async (id) => {
      set({ busy: id });
      await guard(async () => {
        await api.workspaces.start(id);
        await get().refresh();
      });
      set({ busy: null });
    },

    stop: async (id) => {
      set({ busy: id });
      await guard(async () => {
        await api.workspaces.stop(id);
        await get().refresh();
      });
      set({ busy: null });
    },

    clearError: () => set({ error: null }),
  };
});
