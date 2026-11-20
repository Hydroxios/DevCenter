import { create } from "zustand";

const RECENT_KEY = "devcenter.palette.recent";
const MAX_RECENT = 8;

function loadRecent(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

interface PaletteState {
  open: boolean;
  /** Identifiants des dernières commandes exécutées, la plus récente en tête. */
  recent: string[];
  setOpen: (open: boolean) => void;
  toggle: () => void;
  remember: (id: string) => void;
}

/** Palette de commandes (Ctrl+K) : ouverture et commandes récentes (gardées d'une session à l'autre). */
export const usePalette = create<PaletteState>((set, get) => ({
  open: false,
  recent: loadRecent(),
  setOpen: (open) => set({ open }),
  toggle: () => set((s) => ({ open: !s.open })),
  remember: (id) => {
    const recent = [id, ...get().recent.filter((r) => r !== id)].slice(0, MAX_RECENT);
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(recent));
    } catch {
      /* stockage indisponible */
    }
    set({ recent });
  },
}));

/** Libellé du raccourci selon la plateforme. */
export const PALETTE_SHORTCUT = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform) ? "⌘K" : "Ctrl K";
