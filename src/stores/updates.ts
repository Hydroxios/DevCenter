import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";

import { log } from "@/lib/logger";
import { api, isTauri } from "@/services/tauri";
import type { UpdateInfo } from "@/types";

type Status = "idle" | "checking" | "upToDate" | "available" | "installing" | "error";

interface UpdatesState {
  version: string | null;
  status: Status;
  update: UpdateInfo | null;
  /** Octets téléchargés / total pendant l'installation. */
  progress: { downloaded: number; total: number | null } | null;
  error: string | null;
  checkedAt: number | null;
  init: () => void;
  /** `silent` : pas d'erreur affichée (vérification automatique au démarrage). */
  check: (silent?: boolean) => Promise<void>;
  install: () => Promise<void>;
}

let initialized = false;

export const useUpdates = create<UpdatesState>((set, get) => ({
  version: null,
  status: "idle",
  update: null,
  progress: null,
  error: null,
  checkedAt: null,

  init: () => {
    if (initialized || !isTauri()) return;
    initialized = true;
    api.updates.version().then((version) => set({ version })).catch(() => {});
    listen<{ downloaded: number; total: number | null }>("updater://progress", (e) => set({ progress: e.payload }));
    // Vérification discrète peu après le démarrage, puis toutes les 6 heures.
    window.setTimeout(() => get().check(true), 15_000);
    window.setInterval(() => get().check(true), 6 * 3600_000);
  },

  check: async (silent = false) => {
    const { status } = get();
    if (status === "checking" || status === "installing") return;
    set({ status: "checking", error: null });
    try {
      const update = await api.updates.check();
      set({ update, status: update ? "available" : "upToDate", checkedAt: Date.now() });
    } catch (e) {
      // Hors ligne ou aucune version publiée : on ne dérange pas l'utilisateur au démarrage.
      set({ status: silent ? "idle" : "error", error: silent ? null : String(e), checkedAt: Date.now() });
    }
  },

  install: async () => {
    set({ status: "installing", progress: null, error: null });
    try {
      await api.updates.install(); // relance l'application en cas de succès
    } catch (e) {
      log("error", `Échec de la mise à jour : ${String(e)}`);
      set({ status: "error", error: String(e) });
    }
  },
}));
