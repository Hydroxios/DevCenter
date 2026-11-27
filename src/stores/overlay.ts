import { create } from "zustand";

/**
 * Widgets flottants : posés librement au-dessus de toutes les pages, déplaçables et
 * redimensionnables. Positions gardées dans le navigateur (préférence d'affichage locale).
 */

export type FloatingType = "spotify" | "clock" | "notes";

export interface FloatingWidget {
  id: string;
  type: FloatingType;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Ordre d'empilement (le plus grand est au-dessus). */
  z?: number;
  /** Réduit à sa barre de titre. */
  collapsed?: boolean;
}

const KEY = "devcenter.overlay";
const TYPES: FloatingType[] = ["spotify", "clock", "notes"];

interface Saved {
  widgets: FloatingWidget[];
  hidden: boolean;
}

function load(): Saved {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<Saved> | null;
    const widgets = Array.isArray(v?.widgets)
      ? v.widgets.filter(
          (w): w is FloatingWidget =>
            !!w && typeof w.id === "string" && TYPES.includes(w.type) && [w.x, w.y, w.w, w.h].every((n) => Number.isFinite(n)),
        )
      : [];
    return { widgets, hidden: v?.hidden === true };
  } catch {
    return { widgets: [], hidden: false };
  }
}

function save(s: Saved) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* stockage indisponible */
  }
}

export const topZ = (ws: FloatingWidget[]) => ws.reduce((m, w) => Math.max(m, w.z ?? 0), 0);

interface OverlayState extends Saved {
  add: (type: FloatingType, size: { w: number; h: number }) => void;
  remove: (id: string) => void;
  /** Position/taille ; enregistré seulement avec `commit` (fin du glisser). */
  update: (id: string, patch: Partial<Omit<FloatingWidget, "id" | "type">>, commit?: boolean) => void;
  /** Passe le widget au premier plan (l'ordre de la liste ne change pas : le DOM reste stable pendant un glisser). */
  front: (id: string) => void;
  setHidden: (hidden: boolean) => void;
  toggleHidden: () => void;
}

export const useOverlay = create<OverlayState>((set, get) => {
  const persist = () => save({ widgets: get().widgets, hidden: get().hidden });
  return {
    ...load(),
    add: (type, size) => {
      const n = get().widgets.length;
      // En cascade depuis le coin supérieur droit, pour ne pas empiler exactement.
      const x = Math.max(16, window.innerWidth - size.w - 32 - n * 24);
      const y = 64 + n * 24;
      const id = `${type}-${Date.now().toString(36)}`;
      set((s) => ({ widgets: [...s.widgets, { id, type, x, y, ...size, z: topZ(s.widgets) + 1 }], hidden: false }));
      persist();
    },
    remove: (id) => {
      set((s) => ({ widgets: s.widgets.filter((w) => w.id !== id) }));
      persist();
    },
    update: (id, patch, commit = false) => {
      set((s) => ({ widgets: s.widgets.map((w) => (w.id === id ? { ...w, ...patch } : w)) }));
      if (commit) persist();
    },
    front: (id) => {
      const ws = get().widgets;
      const top = topZ(ws);
      const w = ws.find((x) => x.id === id);
      if (!w || ((w.z ?? 0) === top && ws.filter((x) => (x.z ?? 0) === top).length === 1)) return;
      set({ widgets: ws.map((x) => (x.id === id ? { ...x, z: top + 1 } : x)) });
      persist();
    },
    setHidden: (hidden) => {
      set({ hidden });
      persist();
    },
    toggleHidden: () => get().setHidden(!get().hidden),
  };
});
