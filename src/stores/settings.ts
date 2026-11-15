import { create } from "zustand";

import { api, isTauri } from "@/services/tauri";
import type { Settings } from "@/types";

const DEFAULTS: Settings = { theme: "dark", closeToTray: true, editorPath: null, remoteEnabled: false, remotePort: 47820, projectsRoot: null };

interface SettingsState {
  settings: Settings;
  loaded: boolean;
  error: string | null;
  load: () => Promise<void>;
  update: <K extends keyof Settings>(key: K, value: Settings[K]) => Promise<void>;
}

export const useSettings = create<SettingsState>((set, get) => ({
  settings: DEFAULTS,
  loaded: false,
  error: null,

  load: async () => {
    if (!isTauri()) return set({ loaded: true });
    try {
      set({ settings: await api.settings.get(), loaded: true, error: null });
    } catch (e) {
      set({ loaded: true, error: String(e) });
    }
  },

  update: async (key, value) => {
    const previous = get().settings;
    // Mise à jour optimiste, annulée si Rust refuse la valeur.
    set({ settings: { ...previous, [key]: value } });
    if (!isTauri()) return;
    try {
      set({ settings: await api.settings.set(key, value), error: null });
    } catch (e) {
      set({ settings: previous, error: String(e) });
    }
  },
}));
