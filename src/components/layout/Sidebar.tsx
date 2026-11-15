import { Link, NavLink } from "react-router";
import { ArrowUpCircle } from "lucide-react";

import { footerNav, mainNav, type NavItem } from "@/app/navigation";
import { cn } from "@/lib/utils";
import { useUpdates } from "@/stores/updates";

/** Lien de navigation PowerBack : fond léger + filet cyan à gauche quand il est actif. */
function SidebarLink({ item }: { item: NavItem }) {
  const Icon = item.icon;
  return (
    <NavLink
      to={item.path}
      end={item.path === "/"}
      className={({ isActive }) =>
        cn(
          "relative flex items-center gap-3 px-3 py-2 text-sm transition-colors",
          isActive ? "bg-foreground/[0.06] text-foreground" : "text-muted-foreground hover:bg-foreground/[0.03] hover:text-foreground",
        )
      }
    >
      {({ isActive }) => (
        <>
          {isActive && <span className="absolute inset-y-1.5 left-0 w-px bg-primary" />}
          <Icon className={cn("size-4 shrink-0 stroke-[1.5]", isActive && "text-primary")} />
          <span className="flex-1 truncate">{item.label}</span>
        </>
      )}
    </NavLink>
  );
}

/** Signale une mise à jour disponible ; mène à Paramètres › À propos. */
function UpdateNotice() {
  const { status, update } = useUpdates();
  if (status !== "available" && status !== "installing") return null;
  return (
    <Link
      to="/settings?tab=about"
      className="mx-3 mb-2 flex items-center gap-2 rounded-lg border border-primary/30 bg-primary/8 px-3 py-2 text-xs text-primary transition-colors hover:bg-primary/12"
    >
      <ArrowUpCircle className="size-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{status === "installing" ? "Installation…" : `Version ${update?.version} disponible`}</span>
    </Link>
  );
}

export function Sidebar() {
  return (
    <aside className="flex w-60 shrink-0 flex-col border-r bg-sidebar">
      <nav className="flex flex-1 flex-col gap-0.5 px-3 pt-5" aria-label="Navigation principale">
        <span className="eyebrow px-3 pb-2">navigation</span>
        {mainNav.map((item) => (
          <SidebarLink key={item.path} item={item} />
        ))}
      </nav>

      <UpdateNotice />
      <nav className="flex flex-col gap-0.5 border-t p-3" aria-label="Navigation secondaire">
        {footerNav.map((item) => (
          <SidebarLink key={item.path} item={item} />
        ))}
      </nav>
    </aside>
  );
}
