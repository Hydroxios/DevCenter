import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import type { LucideIcon } from "lucide-react";
import {
  ArrowDown,
  ArrowUpRight,
  CircleAlert,
  Download,
  Info,
  Layers,
  MonitorCog,
  Pause,
  Play,
  ScrollText,
  Search,
  Server,
  SquareTerminal,
  Trash2,
  TriangleAlert,
  Workflow,
  X,
} from "lucide-react";

import { EmptyState, Page, PageBar, PageMain, PageNotice, TauriOnly } from "@/components/layout/Page";
import { Highlight } from "@/components/Highlight";
import { Button } from "@/components/ui/button";
import { confirmAction } from "@/components/ui/confirm";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { isTauri } from "@/services/tauri";
import { useEvents } from "@/stores/events";
import type { AppEvent, EventLevel, EventSource } from "@/types";

const SOURCES: { id: EventSource; label: string; icon: LucideIcon }[] = [
  { id: "runner", label: "Scripts", icon: SquareTerminal },
  { id: "workspace", label: "Workspaces", icon: Layers },
  { id: "automation", label: "Automatisations", icon: Workflow },
  { id: "server", label: "Serveurs", icon: Server },
  { id: "update", label: "Mises à jour", icon: Download },
  { id: "app", label: "DevCenter", icon: MonitorCog },
];
const SOURCE = Object.fromEntries(SOURCES.map((s) => [s.id, s])) as Record<EventSource, (typeof SOURCES)[number]>;

const LEVELS: { id: EventLevel; label: string; icon: LucideIcon; tone: string }[] = [
  { id: "info", label: "Info", icon: Info, tone: "text-primary" },
  { id: "warn", label: "Avertissement", icon: TriangleAlert, tone: "text-warning" },
  { id: "error", label: "Erreur", icon: CircleAlert, tone: "text-destructive" },
];
const LEVEL = Object.fromEntries(LEVELS.map((l) => [l.id, l])) as Record<EventLevel, (typeof LEVELS)[number]>;

/** Filtres gardés le temps de la session de l'app (retour sur la page). */
const view = {
  sources: new Set<EventSource>(SOURCES.map((s) => s.id)),
  levels: new Set<EventLevel>(LEVELS.map((l) => l.id)),
  query: "",
  paused: false,
};

const timeFmt = new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const dayFmt = new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "numeric", month: "long" });
const dayKey = (ms: number) => new Date(ms).toDateString();

function dayLabel(ms: number): string {
  const key = dayKey(ms);
  if (key === new Date().toDateString()) return "Aujourd'hui";
  if (key === new Date(Date.now() - 86400_000).toDateString()) return "Hier";
  return dayFmt.format(ms);
}

function Chip({
  active,
  onClick,
  icon: Icon,
  label,
  count,
  tone,
}: {
  active: boolean;
  onClick: () => void;
  icon: LucideIcon;
  label: string;
  count: number;
  tone?: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "inline-flex h-7 items-center gap-1.5 rounded-md border px-2 text-xs transition-colors",
        active ? "border-primary/40 bg-primary/10 text-foreground" : "text-muted-foreground opacity-60 hover:opacity-100",
      )}
    >
      <Icon className={cn("size-3.5", active && tone)} />
      {label}
      <span className="font-mono text-[10px] text-muted-foreground tabular-nums">{count}</span>
    </button>
  );
}

function EventRow({ event, query, onOpen }: { event: AppEvent; query: string; onOpen: (link: string) => void }) {
  const level = LEVEL[event.level];
  const source = SOURCE[event.source];
  const SourceIcon = source.icon;
  const LevelIcon = level.icon;
  return (
    <li
      className={cn(
        "group grid grid-cols-[4.5rem_1rem_minmax(0,1fr)_auto] items-start gap-3 border-b border-border/50 px-6 py-2 text-sm",
        event.level === "error" && "bg-destructive/[0.04]",
        event.level === "warn" && "bg-warning/[0.03]",
      )}
    >
      <time className="pt-0.5 font-mono text-xs text-muted-foreground tabular-nums" dateTime={new Date(event.timestamp).toISOString()}>
        {timeFmt.format(event.timestamp)}
      </time>
      <LevelIcon className={cn("mt-0.5 size-4", level.tone)} aria-label={level.label} />
      <div className="min-w-0 select-text">
        <div className="flex min-w-0 items-center gap-2">
          <span className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground" title={source.label}>
            <SourceIcon className="size-3.5" />
            {source.label}
          </span>
          <span className={cn("min-w-0 truncate", event.level === "error" && "text-destructive")} title={event.title}>
            <Highlight text={event.title} query={query} />
          </span>
        </div>
        {event.detail && (
          <p className="mt-0.5 font-mono text-xs break-words whitespace-pre-wrap text-muted-foreground">
            <Highlight text={event.detail} query={query} />
          </p>
        )}
      </div>
      {event.link ? (
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 opacity-60 group-hover:opacity-100"
          onClick={() => onOpen(event.link!)}
          title="Voir le détail"
        >
          Voir <ArrowUpRight />
        </Button>
      ) : (
        <span />
      )}
    </li>
  );
}

export function JournalPage() {
  if (!isTauri()) return <TauriOnly title="Journal" />;
  return <JournalView />;
}

function JournalView() {
  const { events, loaded, error, init, clear } = useEvents();
  const navigate = useNavigate();
  const [sources, setSources] = useState(view.sources);
  const [levels, setLevels] = useState(view.levels);
  const [query, setQuery] = useState(view.query);
  const [paused, setPaused] = useState(view.paused);
  const listRef = useRef<HTMLDivElement>(null);
  /** Défilement automatique : en bas de la liste et pas en pause. */
  const stick = useRef(true);
  const [unseen, setUnseen] = useState(0);
  const lastSeenId = useRef(0);

  useEffect(() => {
    init();
  }, [init]);

  useEffect(() => {
    Object.assign(view, { sources, levels, query, paused });
  }, [sources, levels, query, paused]);

  const needle = query.trim().toLowerCase();
  const shown = useMemo(
    () =>
      events.filter(
        (e) =>
          sources.has(e.source) &&
          levels.has(e.level) &&
          (!needle ||
            e.title.toLowerCase().includes(needle) ||
            (e.detail?.toLowerCase().includes(needle) ?? false) ||
            SOURCE[e.source].label.toLowerCase().includes(needle)),
      ),
    [events, sources, levels, needle],
  );

  // Compteurs par source / niveau (sur tout le journal, pour savoir ce qu'un filtre masque).
  const counts = useMemo(() => {
    const bySource: Record<string, number> = {};
    const byLevel: Record<string, number> = {};
    for (const e of events) {
      bySource[e.source] = (bySource[e.source] ?? 0) + 1;
      byLevel[e.level] = (byLevel[e.level] ?? 0) + 1;
    }
    return { bySource, byLevel };
  }, [events]);

  const scrollToEnd = () => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    stick.current = true;
    setUnseen(0);
  };

  // Nouveaux événements : on suit le bas de la liste, sauf en pause ou si l'utilisateur est remonté.
  // Repère : id du dernier événement affiché (le nombre reste fixe une fois le plafond atteint).
  const lastShownId = shown.length ? shown[shown.length - 1].id : 0;
  useLayoutEffect(() => {
    const prev = lastSeenId.current;
    lastSeenId.current = lastShownId;
    if (!paused && stick.current) scrollToEnd();
    else if (lastShownId > prev) {
      let added = 0;
      for (let i = shown.length - 1; i >= 0 && shown[i].id > prev; i--) added++;
      setUnseen((n) => n + added);
    }
  }, [lastShownId, paused]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = <T,>(set: Set<T>, value: T, apply: (s: Set<T>) => void) => {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    apply(next);
  };

  const onClear = async () => {
    const ok = await confirmAction({
      title: "Vider le journal ?",
      description: "Tous les événements affichés seront effacés. Les historiques des workspaces et des automatisations sont conservés.",
      confirmLabel: "Vider",
    });
    if (ok) {
      await clear();
      setUnseen(0);
    }
  };

  const filtered = shown.length !== events.length;

  return (
    <Page>
      <PageMain>
        <PageBar
          title="Journal"
          leading={<ScrollText className="size-5 text-primary" />}
          meta={
            filtered
              ? `${shown.length} sur ${events.length} événement${events.length > 1 ? "s" : ""}`
              : `${events.length} événement${events.length > 1 ? "s" : ""} depuis le lancement · 2000 max. en mémoire`
          }
          actions={
            <>
              <Button
                variant="secondary"
                size="sm"
                aria-pressed={paused}
                onClick={() => {
                  setPaused(!paused);
                  if (paused) scrollToEnd();
                }}
                title={paused ? "Reprendre le défilement automatique" : "Mettre en pause le défilement automatique"}
              >
                {paused ? <Play /> : <Pause />}
                {paused ? "Reprendre" : "Pause"}
              </Button>
              <Button variant="ghost" size="icon" className="size-8" onClick={onClear} disabled={events.length === 0} aria-label="Vider le journal" title="Vider le journal">
                <Trash2 />
              </Button>
            </>
          }
        />
        {error && <PageNotice>{error}</PageNotice>}

        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-6 py-3">
          <div className="relative w-64">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Rechercher…" className="h-8 pr-8 pl-8" aria-label="Rechercher dans le journal" />
            {query && (
              <button
                type="button"
                onClick={() => setQuery("")}
                className="absolute top-1/2 right-2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                aria-label="Effacer la recherche"
              >
                <X className="size-4" />
              </button>
            )}
          </div>
          <span className="mx-1 h-5 w-px bg-border" />
          {LEVELS.map((l) => (
            <Chip
              key={l.id}
              active={levels.has(l.id)}
              onClick={() => toggle(levels, l.id, setLevels)}
              icon={l.icon}
              label={l.label}
              tone={l.tone}
              count={counts.byLevel[l.id] ?? 0}
            />
          ))}
          <span className="mx-1 h-5 w-px bg-border" />
          {SOURCES.map((s) => (
            <Chip
              key={s.id}
              active={sources.has(s.id)}
              onClick={() => toggle(sources, s.id, setSources)}
              icon={s.icon}
              label={s.label}
              tone="text-primary"
              count={counts.bySource[s.id] ?? 0}
            />
          ))}
        </div>

        <div className="relative flex min-h-0 flex-1 flex-col">
          {loaded && events.length === 0 ? (
            <EmptyState
              icon={ScrollText}
              title="Aucun événement pour l'instant"
              text="Les lancements de scripts, sessions de workspace, exécutions d'automatisations, changements d'état des serveurs et mises à jour apparaîtront ici."
            />
          ) : loaded && shown.length === 0 ? (
            <EmptyState icon={Search} title="Aucun événement ne correspond" text="Modifiez la recherche ou les filtres." />
          ) : (
            <div
              ref={listRef}
              className="min-h-0 flex-1 overflow-y-auto"
              onScroll={(e) => {
                const el = e.currentTarget;
                stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
                if (stick.current && !paused) setUnseen(0);
              }}
            >
              <ol aria-label="Événements">
                {shown.map((e, i) => (
                  <Fragment key={e.id}>
                    {(i === 0 || dayKey(shown[i - 1].timestamp) !== dayKey(e.timestamp)) && (
                      <li className="sticky top-0 z-10 border-b bg-background/95 px-6 py-1.5 text-xs font-medium text-muted-foreground backdrop-blur first-letter:uppercase">
                        {dayLabel(e.timestamp)}
                      </li>
                    )}
                    <EventRow event={e} query={needle} onOpen={(link) => navigate(link)} />
                  </Fragment>
                ))}
              </ol>
            </div>
          )}
          {unseen > 0 && (
            <Button size="sm" className="absolute bottom-4 left-1/2 -translate-x-1/2 shadow-lg" onClick={scrollToEnd}>
              <ArrowDown /> {unseen > 1 ? `${unseen} nouveaux événements` : "1 nouvel événement"}
            </Button>
          )}
        </div>
      </PageMain>
    </Page>
  );
}
