import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { cn } from "@/lib/utils";

interface TipState {
  rect: DOMRect;
  content: React.ReactNode;
}

/**
 * Infobulle personnalisée, partagée par tous les éléments d'un composant (une seule couche,
 * même pour des centaines de cases). `bind(contenu)` se répand sur l'élément survolé ;
 * `tip` est à rendre une fois dans le composant.
 */
export function useHoverTip() {
  const [state, setState] = useState<TipState | null>(null);
  const hide = useCallback(() => setState(null), []);
  const bind = useCallback(
    (content: React.ReactNode) => {
      const show = (e: React.SyntheticEvent<HTMLElement>) => setState({ rect: e.currentTarget.getBoundingClientRect(), content });
      return { onMouseEnter: show, onFocus: show, onMouseLeave: hide, onBlur: hide };
    },
    [hide],
  );
  const tip = state ? <TipBubble {...state} /> : null;
  return { bind, tip, hide };
}

const MARGIN = 8;

function TipBubble({ rect, content }: TipState) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; below: boolean } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    // Au-dessus de l'élément, ou en dessous s'il n'y a pas la place ; toujours dans la fenêtre.
    const below = rect.top - height - MARGIN < 4;
    const top = below ? rect.bottom + MARGIN : rect.top - height - MARGIN;
    const center = rect.left + rect.width / 2;
    const left = Math.max(4, Math.min(window.innerWidth - width - 4, center - width / 2));
    setPos({ left, top, below });
  }, [rect, content]);

  return createPortal(
    <div
      ref={ref}
      role="tooltip"
      className={cn(
        "pointer-events-none fixed z-[100] max-w-72 rounded-md border border-primary/30 bg-card/95 px-2.5 py-1.5 text-xs text-card-foreground shadow-xl shadow-black/50 backdrop-blur",
        "transition-opacity duration-100",
        pos ? "opacity-100" : "opacity-0",
      )}
      style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999 }}
    >
      {content}
    </div>,
    document.body,
  );
}
