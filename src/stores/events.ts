import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";

import { api, isTauri } from "@/services/tauri";
import type { AppEvent } from "@/types";

/** Même plafond que le tampon côté Rust. */
const MAX_EVENTS = 2000;

interface EventsState {
  events: AppEvent[];
  loaded: boolean;
  error: string | null;
  init: () => Promise<void>;
  clear: () => Promise<void>;
}

let initialized = false;

/** Ajoute des événements en gardant l'ordre chronologique, sans doublon ni dépassement. */
function merge(current: AppEvent[], incoming: AppEvent[]): AppEvent[] {
  const last = current.length ? current[current.length - 1].id : 0;
  const fresh = incoming.filter((e) => e.id > last);
  if (fresh.length === 0) return current;
  const all = current.concat(fresh);
  return all.length > MAX_EVENTS ? all.slice(all.length - MAX_EVENTS) : all;
}

/** Journal unifié : suivi des événements `events://*` émis par Rust. */
export const useEvents = create<EventsState>((set) => ({
  events: [],
  loaded: false,
  error: null,

  init: async () => {
    if (initialized || !isTauri()) return;
    initialized = true;
    // Abonnement d'abord, puis l'historique : aucun événement perdu entre les deux.
    const pending: AppEvent[] = [];
    let ready = false;
    await listen<AppEvent>("events://new", ({ payload }) => {
      if (!ready) pending.push(payload);
      else set((s) => ({ events: merge(s.events, [payload]) }));
    });
    await listen("events://cleared", () => set({ events: [] }));
    try {
      const backlog = await api.events.backlog();
      set({ events: merge(merge([], backlog), pending.sort((a, b) => a.id - b.id)), loaded: true, error: null });
    } catch (e) {
      set({ events: pending, loaded: true, error: String(e) });
    }
    ready = true;
  },

  clear: async () => {
    try {
      await api.events.clear();
      set({ events: [], error: null });
    } catch (e) {
      set({ error: String(e) });
    }
  },
}));
