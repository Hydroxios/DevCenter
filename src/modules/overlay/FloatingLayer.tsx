import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Eye, EyeOff, Trash2, X } from "lucide-react";

import { ErrorBoundary } from "@/components/ErrorBoundary";
import type { ContextMenuEntry } from "@/components/ui/context-menu";
import { openContextMenu } from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";
import type { FloatingWidget } from "@/stores/overlay";
import { topZ, useOverlay } from "@/stores/overlay";
import { FLOATING, FLOATING_TYPES } from "./registry";

/** Raccourci pour afficher / masquer tous les widgets flottants. */
export const OVERLAY_SHORTCUT = "Ctrl+Shift+W";
const HEADER = 28;
/** Part minimale d'un widget qui reste à l'écran quand on le pousse hors de la fenêtre. */
const KEEP = 48;

function useViewport() {
  const [size, setSize] = useState({ w: window.innerWidth, h: window.innerHeight });
  useEffect(() => {
    const on = () => setSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  return size;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));

/** Entrées du menu « Widgets flottants » (barre de titre, dock, clic droit sur un widget). */
export function overlayMenu(): ContextMenuEntry[] {
  const { add, hidden, toggleHidden, widgets, remove } = useOverlay.getState();
  return [
    { heading: "Ajouter un widget flottant" },
    ...FLOATING_TYPES.map((t) => ({
      label: FLOATING[t].title,
      icon: FLOATING[t].icon,
      onSelect: () => add(t, FLOATING[t].size),
    })),
    widgets.length > 0 && { separator: true as const },
    widgets.length > 0 && {
      label: hidden ? "Afficher les widgets" : "Masquer les widgets",
      icon: hidden ? Eye : EyeOff,
      hint: OVERLAY_SHORTCUT,
      onSelect: toggleHidden,
    },
    widgets.length > 0 && {
      label: "Tout retirer",
      icon: Trash2,
      danger: true,
      onSelect: () => widgets.forEach((w) => remove(w.id)),
    },
  ];
}

function Floating({ widget, top, viewport }: { widget: FloatingWidget; top: boolean; viewport: { w: number; h: number } }) {
  const def = FLOATING[widget.type];
  const { update, remove, front } = useOverlay.getState();
  const drag = useRef<{ dx: number; dy: number; mode: "move" | "resize"; w: number; h: number; px: number; py: number } | null>(null);
  const [active, setActive] = useState(false);

  const height = widget.collapsed ? HEADER : widget.h;
  // Affichage borné à la fenêtre (sans modifier la position enregistrée).
  const x = clamp(widget.x, KEEP - widget.w, viewport.w - KEEP);
  const y = clamp(widget.y, 0, viewport.h - HEADER);

  const start = (mode: "move" | "resize") => (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest("button") && mode === "move") return;
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { mode, dx: e.clientX - x, dy: e.clientY - y, w: widget.w, h: widget.h, px: e.clientX, py: e.clientY };
    setActive(true);
    front(widget.id);
  };
  const move = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    if (d.mode === "move") {
      update(widget.id, {
        x: clamp(e.clientX - d.dx, KEEP - widget.w, viewport.w - KEEP),
        y: clamp(e.clientY - d.dy, 0, viewport.h - HEADER),
      });
    } else {
      update(widget.id, {
        w: clamp(d.w + e.clientX - d.px, def.min.w, viewport.w - x),
        h: clamp(d.h + e.clientY - d.py, def.min.h, viewport.h - y),
      });
    }
  };
  const end = () => {
    if (!drag.current) return;
    drag.current = null;
    setActive(false);
    update(widget.id, {}, true);
  };

  return (
    <section
      aria-label={def.title}
      onPointerDownCapture={() => front(widget.id)}
      onContextMenu={(e) => {
        if ((e.target as HTMLElement).closest("input, textarea")) return;
        openContextMenu(e, [
          { label: widget.collapsed ? "Déplier" : "Replier", icon: widget.collapsed ? ChevronDown : ChevronUp, onSelect: () => update(widget.id, { collapsed: !widget.collapsed }, true) },
          { label: "Retirer", icon: X, danger: true, onSelect: () => remove(widget.id) },
          { separator: true },
          ...overlayMenu(),
        ]);
      }}
      className={cn(
        "group/float pointer-events-auto absolute flex flex-col overflow-hidden rounded-xl border bg-card/85 shadow-2xl shadow-black/40 backdrop-blur-xl transition-[box-shadow,border-color]",
        top ? "border-foreground/15" : "border-border",
        active && "border-primary/50 select-none",
      )}
      style={{ left: x, top: y, width: widget.w, height, zIndex: widget.z ?? 0 }}
    >
      <header
        onPointerDown={start("move")}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
        onDoubleClick={() => update(widget.id, { collapsed: !widget.collapsed }, true)}
        className={cn("flex shrink-0 cursor-grab items-center gap-2 border-b border-transparent pr-1 pl-2.5", active && "cursor-grabbing", widget.collapsed ? "" : "group-hover/float:border-border")}
        style={{ height: HEADER }}
      >
        <def.icon className="size-3.5 shrink-0 stroke-[1.5] text-primary" aria-hidden />
        <span className="eyebrow flex-1 truncate text-[10px]">{def.title}</span>
        <div className="flex opacity-0 transition-opacity group-hover/float:opacity-100 focus-within:opacity-100">
          <button
            type="button"
            aria-label={widget.collapsed ? "Déplier" : "Replier"}
            title={widget.collapsed ? "Déplier" : "Replier"}
            onClick={() => update(widget.id, { collapsed: !widget.collapsed }, true)}
            className="flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-foreground/[0.08] hover:text-foreground"
          >
            {widget.collapsed ? <ChevronDown className="size-3.5" /> : <ChevronUp className="size-3.5" />}
          </button>
          <button
            type="button"
            aria-label="Retirer"
            title="Retirer"
            onClick={() => remove(widget.id)}
            className="flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-destructive/15 hover:text-destructive"
          >
            <X className="size-3.5" />
          </button>
        </div>
      </header>
      {!widget.collapsed && (
        <>
          <div className="min-h-0 flex-1 [container-type:size]">
            <ErrorBoundary scope={`widget flottant ${widget.type}`}>{def.render({ width: widget.w, height: widget.h - HEADER }, widget.id)}</ErrorBoundary>
          </div>
          {/* Poignée de redimensionnement (coin inférieur droit). */}
          <div
            aria-hidden
            onPointerDown={start("resize")}
            onPointerMove={move}
            onPointerUp={end}
            onPointerCancel={end}
            className="absolute right-0 bottom-0 size-4 cursor-nwse-resize opacity-0 transition-opacity group-hover/float:opacity-100"
          >
            <svg viewBox="0 0 10 10" className="absolute right-1 bottom-1 size-2 stroke-muted-foreground" fill="none" strokeWidth={1.2}>
              <path d="M9 3L3 9M9 6.5L6.5 9" />
            </svg>
          </div>
        </>
      )}
    </section>
  );
}

/**
 * Calque des widgets flottants, au-dessus de toutes les pages. Le calque lui-même laisse
 * passer la souris : seuls les widgets la capturent.
 */
export function FloatingLayer() {
  const widgets = useOverlay((s) => s.widgets);
  const hidden = useOverlay((s) => s.hidden);
  const viewport = useViewport();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === "w") {
        e.preventDefault();
        useOverlay.getState().toggleHidden();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (hidden || widgets.length === 0) return null;
  const top = topZ(widgets);
  return (
    <div className="pointer-events-none fixed inset-0 z-30" aria-label="Widgets flottants">
      {widgets.map((w) => (
        <Floating key={w.id} widget={w} top={(w.z ?? 0) === top} viewport={viewport} />
      ))}
    </div>
  );
}
