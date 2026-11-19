import * as React from "react";
import { createPortal } from "react-dom";
import type { LucideIcon } from "lucide-react";
import { create } from "zustand";

import { cn } from "@/lib/utils";

/**
 * Menu contextuel (clic droit) unique pour toute l'application.
 *
 * Usage : `onContextMenu={contextMenu(() => [...entrées])}` sur n'importe quel élément.
 * Les entrées sont calculées au moment du clic, donc toujours à jour. Un seul menu est
 * ouvert à la fois ; il se ferme sur Échap, clic extérieur, défilement ou redimensionnement.
 */

export type ContextMenuItem =
  | {
      label: string;
      icon?: LucideIcon;
      onSelect: () => unknown;
      /** Action destructive (texte rouge). */
      danger?: boolean;
      disabled?: boolean;
      /** Texte d'aide aligné à droite (raccourci, valeur…). */
      hint?: string;
    }
  | { separator: true }
  | { heading: string };

/** `false`/`null` permettent d'écrire `cond && { … }` dans la liste. */
export type ContextMenuEntry = ContextMenuItem | false | null | undefined;

interface OpenMenu {
  x: number;
  y: number;
  items: ContextMenuItem[];
  /**
   * Boîte de dialogue qui contient l'élément cliqué : le menu y est rendu pour rester dans
   * son piège à focus (sinon Radix le considère « à l'extérieur » et ferme la fenêtre).
   */
  container: HTMLElement | null;
}

interface MenuState {
  open: OpenMenu | null;
  show: (menu: OpenMenu) => void;
  close: () => void;
}

const useMenu = create<MenuState>((set) => ({
  open: null,
  show: (menu) => set({ open: menu }),
  close: () => set({ open: null }),
}));

const isAction = (i: ContextMenuItem): i is Extract<ContextMenuItem, { onSelect: () => unknown }> => "onSelect" in i;

/** Nettoie la liste : retire les entrées vides et les séparateurs en trop (début, fin, doublons). */
function normalize(entries: ContextMenuEntry[]): ContextMenuItem[] {
  const out: ContextMenuItem[] = [];
  for (const e of entries) {
    if (!e) continue;
    if ("separator" in e && (out.length === 0 || "separator" in out[out.length - 1])) continue;
    out.push(e);
  }
  while (out.length && "separator" in out[out.length - 1]) out.pop();
  return out;
}

/** Ouvre le menu à la position du pointeur. */
export function openContextMenu(e: React.MouseEvent | MouseEvent, entries: ContextMenuEntry[]) {
  const items = normalize(entries);
  e.preventDefault();
  e.stopPropagation();
  if (items.length === 0) return;
  const target = (e.currentTarget ?? e.target) as Element | null;
  const container = (target?.closest?.("[role='dialog']") as HTMLElement | null) ?? null;
  useMenu.getState().show({ x: e.clientX, y: e.clientY, items, container });
}

/** Gestionnaire `onContextMenu` prêt à l'emploi. */
export function contextMenu(build: () => ContextMenuEntry[]) {
  return (e: React.MouseEvent) => openContextMenu(e, build());
}

/** Copie dans le presse-papiers (entrée « Copier … » des menus). */
export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    /* presse-papiers indisponible */
  }
}

/** Champs où le menu natif (copier/coller) reste utile. */
function isEditable(target: EventTarget | null) {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return !!el.closest("input, textarea, [contenteditable=''], [contenteditable='true'], .xterm");
}

/**
 * À monter une fois (dans `App`). Rend le menu ouvert et remplace le menu natif du webview
 * (Actualiser, Inspecter…) partout sauf dans les champs de saisie et sur du texte sélectionné.
 */
export function ContextMenuHost() {
  const open = useMenu((s) => s.open);
  const close = useMenu((s) => s.close);
  const ref = React.useRef<HTMLDivElement>(null);
  const [pos, setPos] = React.useState<{ left: number; top: number } | null>(null);
  const [active, setActive] = React.useState(-1);

  // Menu natif : seulement là où il sert (saisie, sélection de texte).
  React.useEffect(() => {
    const onNative = (e: MouseEvent) => {
      if (e.defaultPrevented) return;
      if (isEditable(e.target)) return;
      if (window.getSelection()?.toString()) return;
      if (import.meta.env.DEV && e.shiftKey) return; // Maj+clic droit : menu natif (Inspecter) en dev
      e.preventDefault();
    };
    window.addEventListener("contextmenu", onNative);
    return () => window.removeEventListener("contextmenu", onNative);
  }, []);

  // Position : on garde le menu entièrement dans la fenêtre.
  React.useLayoutEffect(() => {
    if (!open || !ref.current) {
      setPos(null);
      return;
    }
    const { width, height } = ref.current.getBoundingClientRect();
    const margin = 6;
    let left = open.x;
    let top = open.y;
    if (left + width > window.innerWidth - margin) left = Math.max(margin, open.x - width);
    if (top + height > window.innerHeight - margin) top = Math.max(margin, window.innerHeight - height - margin);
    // Dans une boîte de dialogue (transformée), `fixed` est relatif à celle-ci.
    if (open.container) {
      const r = open.container.getBoundingClientRect();
      left -= r.left;
      top -= r.top;
    }
    setPos({ left, top });
    setActive(-1);
    ref.current.focus();
  }, [open]);

  React.useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) close();
    };
    const onClose = () => close();
    // Échap ferme le menu sans fermer la boîte de dialogue en dessous (Radix écoute en capture sur document).
    const onEsc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      close();
    };
    window.addEventListener("keydown", onEsc, true);
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("wheel", onClose, { passive: true });
    window.addEventListener("resize", onClose);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("keydown", onEsc, true);
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("wheel", onClose);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("blur", onClose);
    };
  }, [open, close]);

  if (!open) return null;

  const items = open.items;
  const actionable = items.map((it, i) => (isAction(it) && !it.disabled ? i : -1)).filter((i) => i >= 0);

  const run = (it: ContextMenuItem) => {
    if (!isAction(it) || it.disabled) return;
    close();
    // Après fermeture : une action qui ouvre une boîte de dialogue reçoit bien le focus.
    queueMicrotask(() => {
      try {
        const r = it.onSelect();
        if (r instanceof Promise) r.catch(() => {});
      } catch {
        /* l'action gère ses erreurs */
      }
    });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const step = (dir: 1 | -1) => {
      if (actionable.length === 0) return;
      const at = actionable.indexOf(active);
      const next = at < 0 ? (dir === 1 ? 0 : actionable.length - 1) : (at + dir + actionable.length) % actionable.length;
      setActive(actionable[next]);
    };
    switch (e.key) {
      case "Escape":
      case "Tab":
        e.preventDefault();
        close();
        break;
      case "ArrowDown":
        e.preventDefault();
        step(1);
        break;
      case "ArrowUp":
        e.preventDefault();
        step(-1);
        break;
      case "Home":
        e.preventDefault();
        setActive(actionable[0] ?? -1);
        break;
      case "End":
        e.preventDefault();
        setActive(actionable[actionable.length - 1] ?? -1);
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        if (active >= 0) run(items[active]);
        break;
    }
  };

  return createPortal(
    <div
      ref={ref}
      role="menu"
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
      style={{ pointerEvents: "auto", ...(pos ?? { left: open.x, top: open.y, visibility: "hidden" }) }}
      className="fixed z-[100] min-w-48 max-w-80 overflow-hidden rounded-lg border bg-card p-1 text-sm text-card-foreground shadow-xl shadow-black/40 outline-none"
    >
      {items.map((it, i) => {
        if ("separator" in it) return <div key={i} role="separator" className="-mx-1 my-1 h-px bg-border" />;
        if ("heading" in it)
          return (
            <div key={i} className="truncate px-2 pt-1.5 pb-1 font-mono text-[11px] tracking-wide text-muted-foreground uppercase">
              {it.heading}
            </div>
          );
        const Icon = it.icon;
        return (
          <button
            key={i}
            type="button"
            role="menuitem"
            disabled={it.disabled}
            tabIndex={-1}
            onMouseEnter={() => setActive(it.disabled ? -1 : i)}
            onMouseLeave={() => setActive(-1)}
            onClick={() => run(it)}
            className={cn(
              "flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors disabled:pointer-events-none disabled:opacity-40",
              it.danger ? "text-destructive" : "text-foreground/90",
              active === i && (it.danger ? "bg-destructive/10" : "bg-foreground/[0.07] text-foreground"),
            )}
          >
            {Icon ? <Icon className={cn("size-4 shrink-0", !it.danger && "text-muted-foreground")} /> : <span className="size-4 shrink-0" />}
            <span className="min-w-0 flex-1 truncate">{it.label}</span>
            {it.hint && <span className="shrink-0 pl-3 font-mono text-xs text-muted-foreground">{it.hint}</span>}
          </button>
        );
      })}
    </div>,
    open.container ?? document.body,
  );
}
