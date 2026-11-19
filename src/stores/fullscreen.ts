import { create } from "zustand";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { log } from "@/lib/logger";
import { isTauri } from "@/services/tauri";

const KEY = "devcenter.fullscreen";

function readSaved() {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

/** Passe la fenêtre en plein écran (Tauri) ou le document (navigateur, mode dev). */
async function applyFullscreen(on: boolean) {
  if (isTauri()) {
    await getCurrentWindow().setFullscreen(on);
    return;
  }
  if (on && !document.fullscreenElement) await document.documentElement.requestFullscreen?.();
  if (!on && document.fullscreenElement) await document.exitFullscreen?.();
}

interface FullscreenState {
  /** Mode plein écran : barre de titre et barre latérale masquées, dock en bas. */
  fullscreen: boolean;
  init: () => void;
  set: (on: boolean) => Promise<void>;
  toggle: () => Promise<void>;
}

let initialized = false;

export const useFullscreen = create<FullscreenState>((set, get) => ({
  fullscreen: false,

  init: () => {
    if (initialized) return;
    initialized = true;
    // Restaure le mode de la dernière session.
    if (readSaved()) get().set(true);
    // Navigateur : Échap quitte le plein écran natif sans passer par nous.
    if (!isTauri()) {
      document.addEventListener("fullscreenchange", () => {
        if (!document.fullscreenElement && get().fullscreen) set({ fullscreen: false });
      });
    }
    // F11 bascule, comme dans les navigateurs.
    window.addEventListener("keydown", (e) => {
      if (e.key === "F11") {
        e.preventDefault();
        get().toggle();
      }
    });
  },

  set: async (on) => {
    set({ fullscreen: on });
    try {
      localStorage.setItem(KEY, on ? "1" : "0");
    } catch {
      /* stockage indisponible */
    }
    try {
      await applyFullscreen(on);
    } catch (e) {
      log("warn", `Bascule plein écran impossible : ${String(e)}`);
    }
  },

  toggle: () => get().set(!get().fullscreen),
}));
