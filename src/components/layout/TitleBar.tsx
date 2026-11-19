import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Maximize2 } from "lucide-react";

import { cn } from "@/lib/utils";
import { isTauri } from "@/services/tauri";
import { useFullscreen } from "@/stores/fullscreen";
import { Logo } from "./Logo";

const icon = "size-[11px] fill-none stroke-current stroke-[1.2]";

function WindowButton({
  label,
  onClick,
  danger = false,
  children,
}: {
  label: string;
  onClick: () => void;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        "flex h-full w-11 items-center justify-center text-muted-foreground transition-colors",
        danger ? "hover:bg-[#e81123] hover:text-white" : "hover:bg-foreground/[0.06] hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

/**
 * Barre de titre personnalisée (fenêtre sans cadre) : zone de déplacement, double-clic pour
 * agrandir, et boutons Windows. « Fermer » passe par la logique de réduction dans la barre système.
 */
export function TitleBar() {
  const tauri = isTauri();
  const [maximized, setMaximized] = useState(false);
  const enterFullscreen = useFullscreen((s) => s.set);

  useEffect(() => {
    if (!tauri) return;
    const win = getCurrentWindow();
    const sync = () => win.isMaximized().then(setMaximized).catch(() => {});
    sync();
    const unlisten = win.onResized(sync);
    return () => {
      unlisten.then((f) => f());
    };
  }, [tauri]);

  const win = tauri ? getCurrentWindow() : null;

  return (
    <header data-tauri-drag-region className="flex h-9 shrink-0 items-stretch border-b bg-background select-none">
      {/* Les enfants ne capturent pas la souris : le glisser-déposer reste actif sur toute la barre. */}
      <div className="pointer-events-none flex w-60 shrink-0 items-center px-5">
        <Logo />
      </div>
      <div data-tauri-drag-region className="flex-1" />
      {win && (
        <div className="flex">
          <WindowButton label="Plein écran (F11)" onClick={() => enterFullscreen(true)}>
            <Maximize2 className="size-3 stroke-[1.5]" aria-hidden />
          </WindowButton>
          <WindowButton label="Réduire" onClick={() => win.minimize()}>
            <svg viewBox="0 0 10 10" className={icon} aria-hidden>
              <path d="M0 5h10" />
            </svg>
          </WindowButton>
          <WindowButton label={maximized ? "Restaurer" : "Agrandir"} onClick={() => win.toggleMaximize()}>
            {maximized ? (
              <svg viewBox="0 0 10 10" className={icon} aria-hidden>
                <path d="M2.5 2.5V.5h7v7h-2" />
                <path d="M.5 2.5h7v7h-7z" />
              </svg>
            ) : (
              <svg viewBox="0 0 10 10" className={icon} aria-hidden>
                <path d="M.5 .5h9v9h-9z" />
              </svg>
            )}
          </WindowButton>
          <WindowButton label="Fermer" danger onClick={() => win.close()}>
            <svg viewBox="0 0 10 10" className={icon} aria-hidden>
              <path d="M.5 .5l9 9M9.5 .5l-9 9" />
            </svg>
          </WindowButton>
        </div>
      )}
    </header>
  );
}
