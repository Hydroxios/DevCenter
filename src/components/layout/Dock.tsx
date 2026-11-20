import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router";
import type { LucideIcon } from "lucide-react";
import { ArrowUpCircle, Minimize2, PanelBottomClose, Pin, Search } from "lucide-react";

import { footerNav, mainNav } from "@/app/navigation";
import { cn } from "@/lib/utils";
import { useFullscreen } from "@/stores/fullscreen";
import { PALETTE_SHORTCUT, usePalette } from "@/stores/palette";
import { useUpdates } from "@/stores/updates";

/** Taille d'une tuile au repos, agrandie au maximum, et rayon d'influence du curseur (px). */
const BASE = 44;
const MAX = 72;
const RANGE = 150;
const COLLAPSED_KEY = "devcenter.dock.collapsed";

function readCollapsed() {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

interface TileProps {
  label: string;
  icon: LucideIcon;
  active?: boolean;
  accent?: boolean;
  to?: string;
  onClick?: () => void;
  register: (el: HTMLElement | null) => void;
}

/** Tuile du dock : icône agrandie selon la proximité du curseur, libellé au survol, point si active. */
function Tile({ label, icon: Icon, active, accent, to, onClick, register }: TileProps) {
  const tile = cn(
    "flex items-center justify-center rounded-xl border transition-[background-color,border-color,color] duration-150",
    active
      ? "border-primary/40 bg-primary/10 text-primary"
      : accent
        ? "border-primary/30 bg-primary/8 text-primary hover:bg-primary/15"
        : "border-border bg-background/80 text-muted-foreground backdrop-blur-md hover:border-foreground/20 hover:text-foreground",
  );
  const inner = (
    <>
      <span
        className="pointer-events-none absolute bottom-full mb-3 rounded-md border bg-card px-2 py-1 text-xs whitespace-nowrap text-foreground opacity-0 shadow-lg transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
        aria-hidden
      >
        {label}
      </span>
      <span ref={register} className={tile} style={{ width: BASE, height: BASE }}>
        <Icon className="size-1/2 stroke-[1.5]" />
      </span>
    </>
  );
  const common = {
    "aria-label": label,
    className: "group relative flex flex-col items-center outline-none focus-visible:[&>span:last-child]:ring-2 focus-visible:[&>span:last-child]:ring-primary",
  };
  return (
    <div className="relative flex flex-col items-center">
      {to ? (
        <Link to={to} {...common} aria-current={active ? "page" : undefined}>
          {inner}
        </Link>
      ) : (
        <button type="button" onClick={onClick} {...common}>
          {inner}
        </button>
      )}
      <span className={cn("mt-1 size-1 rounded-full", active ? "bg-primary" : "bg-transparent")} />
    </div>
  );
}

function Separator() {
  return <span className="mx-1 mb-3 h-8 w-px self-end bg-border" aria-hidden />;
}

/**
 * Dock du mode plein écran : remplace la barre latérale, centré en bas, avec un effet
 * de grossissement des icônes sous le curseur.
 */
export function Dock() {
  const { pathname } = useLocation();
  const exit = useFullscreen((s) => s.set);
  const { status, update } = useUpdates();
  const tiles = useRef(new Set<HTMLElement>());
  const frame = useRef(0);
  const mouseX = useRef<number | null>(null);
  const reduced = useRef(false);
  // Replié : le dock se cache sous le bord et réapparaît quand la souris touche le bas de l'écran.
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [peek, setPeek] = useState(false);
  const visible = !collapsed || peek;

  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSED_KEY, collapsed ? "1" : "0");
    } catch {
      /* stockage indisponible */
    }
  }, [collapsed]);

  // Ctrl+B (comme pour la barre latérale) masque ou épingle le dock.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "b") {
        const t = e.target as HTMLElement | null;
        if (t?.closest("input, textarea, [contenteditable], .xterm")) return;
        e.preventDefault();
        setCollapsed((c) => !c);
        setPeek(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    reduced.current = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    return () => cancelAnimationFrame(frame.current);
  }, []);

  const register = useCallback((el: HTMLElement | null) => {
    if (el) tiles.current.add(el);
  }, []);

  // Mise à jour directe du DOM : pas de rendu React à chaque mouvement de souris.
  const layout = useCallback(() => {
    frame.current = 0;
    const x = mouseX.current;
    for (const el of tiles.current) {
      if (!el.isConnected) {
        tiles.current.delete(el);
        continue;
      }
      let size = BASE;
      if (x !== null) {
        const r = el.getBoundingClientRect();
        const t = Math.max(0, 1 - Math.abs(x - (r.left + r.width / 2)) / RANGE);
        size = BASE + (MAX - BASE) * t * t * (3 - 2 * t);
      }
      el.style.width = el.style.height = `${size}px`;
    }
  }, []);

  const schedule = useCallback(
    (x: number | null) => {
      mouseX.current = reduced.current ? null : x;
      if (!frame.current) frame.current = requestAnimationFrame(layout);
    },
    [layout],
  );

  const isActive = (path: string) => (path === "/" ? pathname === "/" : pathname.startsWith(path));
  const updateLabel =
    status === "installing" ? "Installation de la mise à jour…" : status === "available" ? `Version ${update?.version} disponible` : null;

  return (
    <>
      {/* Zone de rappel au ras du bord inférieur, avec une poignée discrète quand le dock est caché. */}
      {collapsed && (
        <div className="absolute inset-x-0 bottom-0 z-40 flex h-2 justify-center" onMouseEnter={() => setPeek(true)} aria-hidden>
          <span
            className={cn(
              "mt-auto mb-1 h-1 w-24 rounded-full bg-primary/40 transition-opacity duration-200",
              visible ? "opacity-0" : "opacity-100",
            )}
          />
        </div>
      )}
      {/* Flotte au-dessus du contenu : la page garde toute la hauteur de l'écran. */}
      <div
        className={cn(
          "pointer-events-none absolute inset-x-0 bottom-0 z-40 flex justify-center pb-3 transition-[translate,opacity] duration-200 ease-out motion-reduce:transition-none",
          visible ? "translate-y-0 opacity-100" : "translate-y-[calc(100%+8px)] opacity-0",
        )}
      >
        <nav
          aria-label="Navigation principale"
          onMouseMove={(e) => schedule(e.clientX)}
          onMouseLeave={() => {
            schedule(null);
            setPeek(false);
          }}
          onFocus={() => setPeek(true)}
          className={cn(
            "flex items-end gap-2 px-3 pt-2 pb-1",
            visible && "pointer-events-auto",
          )}
        >
          {mainNav.map((item) => (
            <Tile key={item.path} label={item.label} icon={item.icon} to={item.path} active={isActive(item.path)} register={register} />
          ))}
          <Separator />
          {footerNav.map((item) => (
            <Tile key={item.path} label={item.label} icon={item.icon} to={item.path} active={isActive(item.path)} register={register} />
          ))}
          {updateLabel && <Tile label={updateLabel} icon={ArrowUpCircle} to="/settings?tab=about" accent register={register} />}
          <Separator />
          <Tile label={`Rechercher (${PALETTE_SHORTCUT})`} icon={Search} onClick={() => usePalette.getState().setOpen(true)} register={register} />
          <Tile
            label={collapsed ? "Épingler le dock (Ctrl+B)" : "Masquer le dock (Ctrl+B)"}
            icon={collapsed ? Pin : PanelBottomClose}
            onClick={() => {
              setCollapsed((c) => !c);
              setPeek(false);
            }}
            register={register}
          />
          <Tile label="Quitter le plein écran (F11)" icon={Minimize2} onClick={() => exit(false)} register={register} />
        </nav>
      </div>
    </>
  );
}
