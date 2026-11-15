import { Search } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * Gabarit commun des pages (modèle : la page Projets) : colonne de liste à gauche,
 * en-tête bordé, onglets soulignés, zone de contenu qui défile seule.
 */
export function Page({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("flex min-h-0 min-w-0 flex-1", className)}>{children}</div>;
}

/** Colonne principale (à droite de la liste, ou seule) : en-tête, onglets, contenu. */
export function PageMain({ children }: { children: React.ReactNode }) {
  return <section className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</section>;
}

/** En-tête de page ou de l'élément sélectionné. */
export function PageBar({
  title,
  leading,
  meta,
  children,
  actions,
}: {
  title: React.ReactNode;
  /** Pastille ou icône avant le titre. */
  leading?: React.ReactNode;
  /** Ligne secondaire (chemin, hôte, description courte). */
  meta?: React.ReactNode;
  /** Contenu sous la ligne secondaire (badges…). */
  children?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <header className="flex shrink-0 items-start gap-4 border-b px-6 pt-5 pb-4">
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-3">
          {leading}
          <h2 className="truncate text-lg font-semibold tracking-tight">{title}</h2>
        </div>
        {meta && <div className="meta mt-0.5 truncate select-text">{meta}</div>}
        {children && <div className="mt-2">{children}</div>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
    </header>
  );
}

export interface TabDef<T extends string> {
  id: T;
  label: string;
  icon?: LucideIcon;
  /** Compteur affiché à côté du libellé. */
  count?: number | null;
  /** Petit point vert (session ouverte…). */
  dot?: boolean;
}

/** Onglets soulignés, comme dans le détail d'un projet. */
export function PageTabs<T extends string>({ tabs, active, onChange }: { tabs: TabDef<T>[]; active: T; onChange: (t: T) => void }) {
  return (
    <nav className="flex shrink-0 gap-1 border-b px-4" role="tablist">
      {tabs.map(({ id, label, icon: Icon, count, dot }) => (
        <button
          key={id}
          type="button"
          role="tab"
          aria-selected={active === id}
          onClick={() => onChange(id)}
          className={cn(
            "relative flex items-center gap-1.5 px-3 py-2.5 text-sm transition-colors",
            active === id ? "text-foreground" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {Icon && <Icon className="size-4" />}
          {label}
          {count != null && count > 0 && <span className="rounded-full bg-success/15 px-1.5 font-mono text-[10px] text-success">{count}</span>}
          {dot && <span className="size-1.5 rounded-full bg-success" />}
          {active === id && <span className="absolute inset-x-2 -bottom-px h-px bg-primary" />}
        </button>
      ))}
    </nav>
  );
}

/** Zone de contenu défilante, sur toute la largeur (les pages de formulaire la limitent). */
export function PageBody({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className={cn("grid gap-4 p-6", className)}>{children}</div>
    </div>
  );
}

/** Message affiché sous l'en-tête (erreur, avertissement), sur toute la largeur. */
export function PageNotice({ children, tone = "destructive", onDismiss }: { children: React.ReactNode; tone?: "destructive" | "warning"; onDismiss?: () => void }) {
  return (
    <p className={cn("flex items-center gap-3 border-b px-6 py-2 text-sm", tone === "destructive" ? "text-destructive" : "text-warning")}>
      <span className="min-w-0 flex-1">{children}</span>
      {onDismiss && (
        <button type="button" onClick={onDismiss} className="shrink-0 text-xs text-muted-foreground hover:text-foreground">
          OK
        </button>
      )}
    </p>
  );
}

/** Colonne de gauche : titre + compteur, actions en icônes, filtre, liste. */
export function ListPane({
  title,
  count,
  actions,
  filter,
  onFilter,
  error,
  footer,
  children,
}: {
  title: string;
  count?: string;
  actions?: React.ReactNode;
  filter?: string;
  onFilter?: (v: string) => void;
  error?: string | null;
  footer?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <aside className="flex w-72 shrink-0 flex-col border-r">
      <div className="flex items-center justify-between gap-2 px-4 pt-4 pb-3">
        <div className="min-w-0">
          <h1 className="text-base font-semibold tracking-tight">{title}</h1>
          {count !== undefined && <p className="meta">{count}</p>}
        </div>
        {actions && <div className="flex items-center gap-0.5">{actions}</div>}
      </div>
      {onFilter && (
        <div className="px-3 pb-2">
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={filter ?? ""} onChange={(e) => onFilter(e.target.value)} placeholder="Filtrer…" className="h-8 pl-8" aria-label={`Filtrer : ${title}`} />
          </div>
        </div>
      )}
      {error && <p className="px-4 pb-2 text-xs text-destructive">{error}</p>}
      <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-3" aria-label={title}>
        {children}
      </nav>
      {footer && <div className="border-t px-2 py-2">{footer}</div>}
    </aside>
  );
}

/** Élément de la liste de gauche (barre cyan quand il est sélectionné). */
export function ListItem({ active, onClick, className, children }: { active: boolean; onClick: () => void; className?: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active || undefined}
      className={cn(
        "relative grid w-full gap-0.5 px-3 py-2 text-left transition-colors",
        active ? "bg-foreground/[0.06]" : "hover:bg-foreground/[0.03]",
        className,
      )}
    >
      {active && <span className="absolute inset-y-1.5 left-0 w-px bg-primary" />}
      {children}
    </button>
  );
}

/** État vide centré dans la colonne principale. */
export function EmptyState({ icon: Icon, title, text, actions }: { icon: LucideIcon; title: string; text?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
      <div className="flex size-12 items-center justify-center rounded-full bg-accent text-accent-foreground">
        <Icon className="size-6" />
      </div>
      <div>
        <p className="font-medium">{title}</p>
        {text && <p className="mt-1 max-w-sm text-sm text-muted-foreground">{text}</p>}
      </div>
      {actions && <div className="flex gap-2">{actions}</div>}
    </div>
  );
}

/** Module qui a besoin des commandes Rust (absent dans `pnpm dev` seul). */
export function TauriOnly({ title }: { title: string }) {
  return (
    <Page>
      <PageMain>
        <PageBar title={title} />
        <div className="flex flex-1 items-center justify-center p-8 text-sm text-muted-foreground">
          Ce module n'est disponible que dans l'application (pnpm tauri dev).
        </div>
      </PageMain>
    </Page>
  );
}
