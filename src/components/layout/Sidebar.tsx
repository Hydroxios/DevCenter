import { useEffect, useState } from "react";
import { Link, NavLink } from "react-router";
import { ArrowUpCircle, PanelLeftClose, PanelLeftOpen, Search } from "lucide-react";

import { footerNav, mainNav, type NavItem } from "@/app/navigation";
import { cn } from "@/lib/utils";
import { PALETTE_SHORTCUT, usePalette } from "@/stores/palette";
import { useUpdates } from "@/stores/updates";

const COLLAPSED_KEY = "devcenter.sidebar.collapsed";

function readCollapsed() {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

/** Lien de navigation PowerBack : fond léger + filet cyan à gauche quand il est actif. Réduit : icône seule. */
function SidebarLink({ item, collapsed }: { item: NavItem; collapsed: boolean }) {
  const Icon = item.icon;
  return (
    <NavLink
      to={item.path}
      end={item.path === "/"}
      title={collapsed ? item.label : undefined}
      aria-label={collapsed ? item.label : undefined}
      className={({ isActive }) =>
        cn(
          "relative flex items-center gap-3 py-2 text-sm transition-colors",
          collapsed ? "justify-center px-0" : "px-3",
          isActive ? "bg-foreground/[0.06] text-foreground" : "text-muted-foreground hover:bg-foreground/[0.03] hover:text-foreground",
        )
      }
    >
      {({ isActive }) => (
        <>
          {isActive && <span className="absolute inset-y-1.5 left-0 w-px bg-primary" />}
          <Icon className={cn("size-4 shrink-0 stroke-[1.5]", isActive && "text-primary")} />
          {!collapsed && <span className="flex-1 truncate">{item.label}</span>}
        </>
      )}
    </NavLink>
  );
}

/** Signale une mise à jour disponible ; mène à Paramètres › À propos. */
function UpdateNotice({ collapsed }: { collapsed: boolean }) {
  const { status, update } = useUpdates();
  if (status !== "available" && status !== "installing") return null;
  const label = status === "installing" ? "Installation…" : `Version ${update?.version} disponible`;
  return (
    <Link
      to="/settings?tab=about"
      title={collapsed ? label : undefined}
      className={cn(
        "mb-2 flex items-center gap-2 rounded-lg border border-primary/30 bg-primary/8 py-2 text-xs text-primary transition-colors hover:bg-primary/12",
        collapsed ? "mx-2 justify-center px-0" : "mx-3 px-3",
      )}
    >
      <ArrowUpCircle className="size-4 shrink-0" />
      {!collapsed && <span className="min-w-0 flex-1 truncate">{label}</span>}
    </Link>
  );
}

/** Ouvre la palette de commandes et rappelle son raccourci. */
function PaletteButton({ collapsed }: { collapsed: boolean }) {
  const setOpen = usePalette((s) => s.setOpen);
  const label = `Rechercher une commande (${PALETTE_SHORTCUT})`;
  return (
    <button
      type="button"
      onClick={() => setOpen(true)}
      title={label}
      aria-label={label}
      className={cn(
        "mb-2 flex items-center gap-2 rounded-lg border bg-card/60 py-1.5 text-xs text-muted-foreground transition-colors hover:border-foreground/20 hover:text-foreground",
        collapsed ? "justify-center px-0" : "px-3",
      )}
    >
      <Search className="size-3.5 shrink-0 stroke-[1.5]" />
      {!collapsed && (
        <>
          <span className="flex-1 truncate text-left">Rechercher…</span>
          <kbd className="rounded border bg-background px-1.5 py-px font-mono text-[10px]">{PALETTE_SHORTCUT}</kbd>
        </>
      )}
    </button>
  );
}

export function Sidebar() {
  const [collapsed, setCollapsed] = useState(readCollapsed);

  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSED_KEY, collapsed ? "1" : "0");
    } catch {
      /* stockage indisponible */
    }
  }, [collapsed]);

  // Ctrl+B (⌘B sur Mac) replie ou déplie la barre, comme dans les éditeurs de code.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "b") {
        const t = e.target as HTMLElement | null;
        if (t?.closest("input, textarea, [contenteditable], .xterm")) return;
        e.preventDefault();
        setCollapsed((c) => !c);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const toggleLabel = collapsed ? "Déplier la barre latérale (Ctrl+B)" : "Replier la barre latérale (Ctrl+B)";
  const ToggleIcon = collapsed ? PanelLeftOpen : PanelLeftClose;

  return (
    <aside
      className={cn(
        "flex shrink-0 flex-col overflow-hidden border-r bg-sidebar transition-[width] duration-200 ease-out motion-reduce:transition-none",
        collapsed ? "w-14" : "w-60",
      )}
    >
      <nav className={cn("flex flex-1 flex-col gap-0.5 pt-5", collapsed ? "px-2" : "px-3")} aria-label="Navigation principale">
        <div className={cn("flex items-center pb-2", collapsed ? "justify-center" : "justify-between pl-3")}>
          {!collapsed && <span className="eyebrow">navigation</span>}
          <button
            type="button"
            onClick={() => setCollapsed((c) => !c)}
            title={toggleLabel}
            aria-label={toggleLabel}
            aria-expanded={!collapsed}
            className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
          >
            <ToggleIcon className="size-4 stroke-[1.5]" />
          </button>
        </div>
        <PaletteButton collapsed={collapsed} />
        {mainNav.map((item) => (
          <SidebarLink key={item.path} item={item} collapsed={collapsed} />
        ))}
      </nav>

      <UpdateNotice collapsed={collapsed} />
      <nav className={cn("flex flex-col gap-0.5 border-t", collapsed ? "p-2" : "p-3")} aria-label="Navigation secondaire">
        {footerNav.map((item) => (
          <SidebarLink key={item.path} item={item} collapsed={collapsed} />
        ))}
      </nav>
    </aside>
  );
}
