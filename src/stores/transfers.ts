import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";

import { api, isTauri } from "@/services/tauri";
import type { FileTransfer } from "@/types";

interface TransfersState {
  transfers: Record<number, FileTransfer>;
  init: () => Promise<void>;
  /** Ajoute ou met à jour (réponse d'une commande, avant le premier événement). */
  upsert: (list: FileTransfer[]) => void;
  cancel: (id: number) => Promise<void>;
  dismiss: (id: number) => Promise<void>;
  dismissFinished: (serverId: number) => Promise<void>;
}

let initialized = false;

/** Transferts de fichiers SSH : état synchronisé avec Rust via l'événement `sftp://transfer`. */
export const useTransfers = create<TransfersState>((set, get) => ({
  transfers: {},

  init: async () => {
    if (initialized || !isTauri()) return;
    initialized = true;
    await listen<FileTransfer>("sftp://transfer", ({ payload }) => {
      set((s) => ({ transfers: { ...s.transfers, [payload.id]: payload } }));
    });
    try {
      const list = await api.servers.transfers();
      get().upsert(list);
    } catch {
      /* liste indisponible : les événements suivants la reconstruiront */
    }
  },

  upsert: (list) =>
    set((s) => {
      const transfers = { ...s.transfers };
      // Un événement plus récent (progression) ne doit pas être écrasé par la réponse initiale.
      for (const t of list) transfers[t.id] = pickNewer(transfers[t.id], t);
      return { transfers };
    }),

  cancel: async (id) => {
    await api.servers.cancelTransfer(id).catch(() => {});
  },

  dismiss: async (id) => {
    await api.servers.dismissTransfer(id).catch(() => {});
    const { [id]: _t, ...transfers } = get().transfers;
    set({ transfers });
  },

  dismissFinished: async (serverId) => {
    const done = Object.values(get().transfers).filter((t) => t.serverId === serverId && t.status !== "running");
    await Promise.all(done.map((t) => api.servers.dismissTransfer(t.id).catch(() => {})));
    set((s) => {
      const transfers = { ...s.transfers };
      for (const t of done) delete transfers[t.id];
      return { transfers };
    });
  },
}));

function pickNewer(prev: FileTransfer | undefined, next: FileTransfer): FileTransfer {
  if (!prev) return next;
  if (prev.status !== "running") return prev;
  return prev.transferred > next.transferred ? prev : next;
}
