import { create } from "zustand";

import { api, isTauri } from "@/services/tauri";
import { useSettings } from "@/stores/settings";

interface OnboardingState {
  open: boolean;
  /** Ouvre l'assistant au premier lancement : drapeau absent ET aucun projet (les anciens utilisateurs ne le voient pas). */
  maybeShow: () => Promise<void>;
  show: () => void;
  /** Ferme l'assistant (terminé ou ignoré) et mémorise le drapeau `onboardingDone`. */
  finish: () => Promise<void>;
}

let checked = false;

export const useOnboarding = create<OnboardingState>((set) => ({
  open: false,

  maybeShow: async () => {
    if (checked || !isTauri()) return;
    checked = true;
    if (useSettings.getState().settings.onboardingDone) return;
    try {
      const projects = await api.projects.list();
      if (projects.length === 0) set({ open: true });
    } catch {
      /* liste illisible : on n'impose pas l'assistant */
    }
  },

  show: () => set({ open: true }),

  finish: async () => {
    set({ open: false });
    if (!useSettings.getState().settings.onboardingDone) await useSettings.getState().update("onboardingDone", true);
  },
}));
