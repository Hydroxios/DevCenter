import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  BookOpen,
  ChevronDown,
  CircleAlert,
  CircleCheck,
  CircleMinus,
  Clock,
  CopyPlus,
  History,
  LayoutList,
  Loader2,
  Pencil,
  Play,
  Plus,
  Power,
  PowerOff,
  Trash2,
  Workflow,
  Zap,
} from "lucide-react";

import { EmptyState, ListItem, ListPane, Page, PageBar, PageBody, PageMain, PageNotice, PageTabs, TauriOnly } from "@/components/layout/Page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { confirmAction } from "@/components/ui/confirm";
import { contextMenu } from "@/components/ui/context-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useLinkedId } from "@/hooks/useLinkedId";
import { cn, formatRelative } from "@/lib/utils";
import { api, isTauri } from "@/services/tauri";
import type { Automation, AutomationInput, AutomationRun, AutomationRunStatus, AutomationStep } from "@/types";
import { AutomationEditor } from "./AutomationEditor";
import { CONDITION_KINDS, STEP_KINDS, stepIcon, templates, triggerLabel, type Refs } from "./model";

const STATUS: Record<AutomationRunStatus, { label: string; variant: "success" | "destructive" | "outline" | "warning" | "default" }> = {
  running: { label: "En cours", variant: "default" },
  success: { label: "Réussie", variant: "success" },
  failed: { label: "Échec", variant: "destructive" },
  stopped: { label: "Condition non remplie", variant: "outline" },
  timeout: { label: "Délai dépassé", variant: "warning" },
};

const ORIGIN: Record<AutomationRun["origin"], string> = { manual: "manuel", schedule: "planifié", startup: "démarrage", event: "événement", webhook: "webhook" };

function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={checked ? "Activée" : "Désactivée"}
      onClick={() => onChange(!checked)}
      className={cn("relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors", checked ? "bg-primary" : "bg-input")}
    >
      <span className={cn("inline-block size-4 rounded-full bg-white shadow transition-transform", checked ? "translate-x-4.5" : "translate-x-0.5")} />
    </button>
  );
}

function RunLog({ run }: { run: AutomationRun }) {
  return (
    <ol className="grid gap-1 text-sm">
      {run.context && (
        <li className="mb-1 flex items-start gap-2 text-xs text-muted-foreground">
          <Zap className="mt-0.5 size-3.5 shrink-0 text-primary" />
          <span className="min-w-0 flex-1 break-words">{run.context}</span>
        </li>
      )}
      {run.log.map((s, i) => (
        <li key={i} className="flex items-start gap-2">
          {s.outcome === "ok" ? (
            <CircleCheck className="mt-0.5 size-4 shrink-0 text-success" />
          ) : s.outcome === "failed" ? (
            <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
          ) : (
            <CircleMinus className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          )}
          <span className={cn("min-w-0 flex-1", s.outcome === "skipped" && "text-muted-foreground")}>
            {s.label}
            {s.message && <span className={cn("block max-h-48 overflow-auto text-xs break-words whitespace-pre-wrap", s.message.includes("\n") && "font-mono", s.outcome === "failed" ? "text-destructive" : "text-muted-foreground")}>{s.message}</span>}
          </span>
          {s.durationMs > 0 && <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{(s.durationMs / 1000).toFixed(1)} s</span>}
        </li>
      ))}
    </ol>
  );
}

/** Exécutions chargées par page ; la suite arrive au défilement. */
const HISTORY_PAGE = 20;
/** Au-delà, on arrête de charger (l'historique est de toute façon purgé à 1000 au démarrage). */
const HISTORY_MAX = 500;
/** Préférence locale : historique replié ou non (conservé entre les lancements). */
const HISTORY_COLLAPSED_KEY = "automations.historyCollapsed";

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(HISTORY_COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

/** Historique paginé ; `automationId` restreint aux exécutions d'une automatisation. */
function RunHistory({ version, automationId }: { version: number; automationId: number | null }) {
  const [runs, setRuns] = useState<AutomationRun[] | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [open, setOpen] = useState<AutomationRun | null>(null);
  const [collapsed, setCollapsedState] = useState(readCollapsed);
  const setCollapsed = (v: boolean) => {
    setCollapsedState(v);
    try {
      localStorage.setItem(HISTORY_COLLAPSED_KEY, v ? "1" : "0");
    } catch {
      /* stockage indisponible : la préférence n'est simplement pas retenue */
    }
  };
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLLIElement>(null);
  const busy = useRef(false);

  // Rafraîchissement : la première page est fusionnée avec ce qui est déjà chargé
  // (nouvelles exécutions en tête, statuts mis à jour) sans perdre la position de défilement.
  useEffect(() => {
    api.automations
      .history(automationId, HISTORY_PAGE)
      .then((page) =>
        setRuns((prev) => {
          if (!prev) {
            setHasMore(page.length === HISTORY_PAGE);
            return page;
          }
          const fresh = new Map(page.map((r) => [r.id, r]));
          const kept = prev.map((r) => fresh.get(r.id) ?? r);
          const known = new Set(prev.map((r) => r.id));
          return [...page.filter((r) => !known.has(r.id)), ...kept];
        }),
      )
      .catch(() => setRuns((prev) => prev ?? []));
  }, [version, automationId]);

  const loadMore = useCallback(async () => {
    const last = runs?.[runs.length - 1];
    if (!last || busy.current || !hasMore || runs.length >= HISTORY_MAX) return;
    busy.current = true;
    setLoadingMore(true);
    try {
      const page = await api.automations.history(automationId, HISTORY_PAGE, last.id);
      setRuns((prev) => {
        const known = new Set((prev ?? []).map((r) => r.id));
        return [...(prev ?? []), ...page.filter((r) => !known.has(r.id))];
      });
      setHasMore(page.length === HISTORY_PAGE);
    } catch {
      setHasMore(false);
    } finally {
      busy.current = false;
      setLoadingMore(false);
    }
  }, [runs, hasMore, automationId]);

  // Charge la page suivante quand le bas de la liste approche (dans la zone défilante).
  useEffect(() => {
    const root = scrollRef.current;
    const sentinel = sentinelRef.current;
    if (collapsed || !root || !sentinel || !hasMore) return;
    const observer = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && loadMore(), {
      root,
      rootMargin: "0px 0px 120px 0px",
    });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [loadMore, hasMore, collapsed]);

  if (!runs) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Chargement…
      </p>
    );
  }
  if (runs.length === 0) return <p className="text-sm text-muted-foreground">Aucune exécution pour l'instant.</p>;
  const capped = runs.length >= HISTORY_MAX;
  return (
    <Card>
      <CardHeader>
        <button
          type="button"
          onClick={() => setCollapsed(!collapsed)}
          aria-expanded={!collapsed}
          className="group flex w-full items-center justify-between gap-3 text-left"
          title={collapsed ? "Afficher l'historique" : "Replier l'historique"}
        >
          <CardTitle className="flex items-center gap-2">
            <ChevronDown className={cn("size-4 text-muted-foreground transition-transform group-hover:text-primary", collapsed && "-rotate-90")} />
            Historique des exécutions
          </CardTitle>
          <span className="flex items-center gap-2">
            {collapsed && <Badge title="Dernière exécution" variant={STATUS[runs[0].status].variant}>{STATUS[runs[0].status].label}</Badge>}
            <span className="meta">
              {runs.length}
              {hasMore && !capped ? "+" : ""}
            </span>
            <History className="size-4 text-muted-foreground" />
          </span>
        </button>
      </CardHeader>
      {!collapsed && (
        <div ref={scrollRef} className="-mx-2 max-h-96 overflow-y-auto px-2">
          <ul className="divide-y text-sm">
            {runs.map((r) => (
              <li key={r.id}>
                <button type="button" onClick={() => setOpen(r)} className="flex w-full items-center gap-3 py-2 text-left hover:bg-accent/40">
                  <span className="min-w-0 flex-1 truncate">{automationId === null ? r.automationName : new Date(r.startedAt * 1000).toLocaleString("fr-FR")}</span>
                  <span className="max-w-56 truncate text-xs text-muted-foreground" title={r.context ?? undefined}>{r.context ? `${ORIGIN[r.origin]} · ${r.context}` : ORIGIN[r.origin]}</span>
                  <Badge variant={STATUS[r.status].variant}>{STATUS[r.status].label}</Badge>
                  <span className="w-28 shrink-0 text-right text-xs text-muted-foreground">{formatRelative(r.startedAt)}</span>
                </button>
              </li>
            ))}
            <li ref={sentinelRef} className="py-2 text-center text-xs text-muted-foreground">
              {loadingMore ? (
                <span className="inline-flex items-center gap-1.5">
                  <Loader2 className="size-3.5 animate-spin" /> Chargement…
                </span>
              ) : capped ? (
                `Seules les ${HISTORY_MAX} exécutions les plus récentes sont affichées.`
              ) : !hasMore ? (
                "Début de l'historique"
              ) : null}
            </li>
          </ul>
        </div>
      )}
      <Dialog open={open !== null} onOpenChange={(o) => !o && setOpen(null)}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>{open?.automationName}</DialogTitle>
            <DialogDescription>{open && `${STATUS[open.status].label}, ${formatRelative(open.startedAt)} (${ORIGIN[open.origin]})`}</DialogDescription>
          </DialogHeader>
          {open && <RunLog run={open} />}
        </DialogContent>
      </Dialog>
    </Card>
  );
}

type Tab = "overview" | "history";
/** Sélection : une automatisation, ou l'historique complet. */
type Selection = number | "all";
const lastTab = new Map<number, Tab>();
let lastSelected: Selection | null = null;

function AutomationView({
  a,
  refs,
  version,
  onEdit,
  onChanged,
  onError,
}: {
  a: Automation;
  refs: Refs;
  version: number;
  onEdit: () => void;
  onChanged: (list: Automation[]) => void;
  onError: (e: string) => void;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [tab, setTabState] = useState<Tab>(() => lastTab.get(a.id) ?? "overview");
  const setTab = (t: Tab) => {
    lastTab.set(a.id, t);
    setTabState(t);
  };
  const last = a.lastRun;

  return (
    <PageMain>
      <PageBar
        title={a.name}
        leading={<AutomationDot a={a} />}
        meta={
          <span className="inline-flex items-center gap-1.5">
            <Clock className="size-3" /> {triggerLabel(a.trigger, refs)}
            {!a.enabled && " · désactivée"}
          </span>
        }
        actions={
          <>
            <Switch label="Activer" checked={a.enabled} onChange={(v) => api.automations.setEnabled(a.id, v).then(onChanged).catch((e) => onError(String(e)))} />
            <Button size="sm" disabled={a.running} onClick={() => api.automations.run(a.id).catch((e) => onError(String(e)))}>
              {a.running ? <Loader2 className="animate-spin" /> : <Play />} Exécuter
            </Button>
            <Button variant="ghost" size="icon" className="size-8" onClick={onEdit} aria-label="Modifier" title="Modifier">
              <Pencil />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-8 hover:text-destructive"
              onClick={() => setConfirmDelete(true)}
              disabled={a.running}
              aria-label="Supprimer"
              title="Supprimer"
            >
              <Trash2 />
            </Button>
          </>
        }
      >
        {a.description && <p className="text-sm text-muted-foreground">{a.description}</p>}
      </PageBar>
      <PageTabs
        tabs={[
          { id: "overview", label: "Aperçu", icon: LayoutList, dot: a.running },
          { id: "history", label: "Historique", icon: History },
        ]}
        active={tab}
        onChange={setTab}
      />
      <PageBody>
        {tab === "overview" ? (
          <>
            <Card>
              <CardHeader>
                <CardTitle>Dernière exécution</CardTitle>
                {last && (
                  <span className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Badge variant={STATUS[last.status].variant}>{STATUS[last.status].label}</Badge>
                    {formatRelative(last.startedAt)} · {ORIGIN[last.origin]}
                  </span>
                )}
              </CardHeader>
              {a.running ? (
                <p className="flex items-center gap-2 text-sm text-primary">
                  <Loader2 className="size-4 animate-spin" /> En cours…
                </p>
              ) : last ? (
                <RunLog run={last} />
              ) : (
                <p className="text-sm text-muted-foreground">Jamais exécutée.</p>
              )}
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Étapes</CardTitle>
                <span className="meta">
                  {a.onError === "stop" ? "arrêt à la première erreur" : "continue en cas d'erreur"} · {a.timeoutMinutes} min max.
                </span>
              </CardHeader>
              <ol className="divide-y rounded-lg border text-sm">
                {a.steps.map((s, i) => {
                  const Icon = stepIcon(s.kind);
                  return (
                    <li key={i} className="flex min-w-0 items-center gap-3 px-3 py-2">
                      <span className="meta w-4 shrink-0 text-right">{i + 1}</span>
                      <Icon className="size-4 shrink-0 text-muted-foreground" />
                      <span className="truncate">{stepSummary(s, refs)}</span>
                    </li>
                  );
                })}
              </ol>
            </Card>
          </>
        ) : (
          <RunHistory key={a.id} version={version} automationId={a.id} />
        )}
      </PageBody>

      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Supprimer {a.name} ?</DialogTitle>
            <DialogDescription>L'automatisation est supprimée ; son historique d'exécution est conservé.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
              Annuler
            </Button>
            <Button variant="destructive" onClick={() => api.automations.remove(a.id).then(onChanged).catch((e) => onError(String(e)))}>
              Supprimer
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageMain>
  );
}

/** Pastille d'état : en cours, désactivée, ou résultat de la dernière exécution. */
function AutomationDot({ a }: { a: Automation }) {
  const status = a.lastRun?.status;
  const color = a.running
    ? "animate-pulse bg-primary"
    : !a.enabled
      ? "bg-muted-foreground/30"
      : status === "failed" || status === "timeout"
        ? "bg-destructive"
        : status === "success"
          ? "bg-success"
          : "bg-muted-foreground/50";
  const title = a.running ? "En cours" : !a.enabled ? "Désactivée" : status ? STATUS[status].label : "Jamais exécutée";
  return <span className={cn("size-2 shrink-0 rounded-full", color)} title={title} />;
}

/** Résumé lisible d'une étape (noms des projets, workspaces… résolus). */
function stepSummary(s: AutomationStep, refs: Refs): string {
  const name = (list: { id: number; name: string }[], id: number) => list.find((x) => x.id === id)?.name ?? `#${id}`;
  const label = STEP_KINDS.find((k) => k.kind === s.kind)?.label ?? s.kind;
  switch (s.kind) {
    case "startWorkspace":
    case "stopWorkspace":
      return `${label} · ${name(refs.workspaces, s.workspaceId)}`;
    case "runScript":
    case "stopScript":
      return `${label} · ${name(refs.projects, s.projectId)} › ${s.script}`;
    case "openEditor":
    case "openFolder":
      return `${label} · ${name(refs.projects, s.projectId)}`;
    case "launchApp":
      return `${label} · ${name(refs.apps, s.appId)}`;
    case "openUrl":
      return `${label} · ${s.url}`;
    case "openTunnel":
    case "closeTunnel":
      return `${label} · ${name(refs.tunnels, s.tunnelId)}`;
    case "httpRequest":
      return `${s.method} ${s.url}`;
    case "sshCommand":
      return `SSH ${name(refs.servers, s.serverId)} › ${s.snippetId !== null ? name(refs.snippets, s.snippetId) : s.command}`;
    case "notify":
      return `${label} · « ${s.title} »`;
    case "wait":
      return `${label} ${s.seconds} s`;
    case "waitForPort":
      return `${label} ${s.host}:${s.port}`;
    case "condition": {
      const c = CONDITION_KINDS.find((k) => k.kind === s.condition.kind);
      return `Si ${c ? (s.condition.negate ? c.negLabel : c.label) : s.condition.kind}`;
    }
  }
}

export function AutomationsPage() {
  if (!isTauri()) return <TauriOnly title="Automatisations" />;
  return <AutomationsView />;
}

function AutomationsView() {
  const [list, setList] = useState<Automation[] | null>(null);
  const [refs, setRefs] = useState<Refs>({ projects: [], apps: [], workspaces: [], servers: [], snippets: [], tunnels: [] });
  const [editor, setEditor] = useState<{ open: boolean; initial: AutomationInput | null }>({ open: false, initial: null });
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [selectedId, setSelectedIdState] = useState<Selection | null>(lastSelected);
  const [filter, setFilter] = useState("");
  const setSelectedId = (id: Selection) => {
    lastSelected = id;
    setSelectedIdState(id);
  };
  useLinkedId("automation", setSelectedId);

  const refresh = useCallback(() => {
    api.automations.list().then(setList).catch((e) => setError(String(e)));
    setVersion((v) => v + 1);
  }, []);

  useEffect(() => {
    refresh();
    Promise.all([api.projects.list(), api.apps.list(), api.workspaces.list(), api.servers.list(), api.snippets.list(), api.tunnels.list()])
      .then(([projects, apps, workspaces, servers, snippets, tunnels]) =>
        setRefs({ projects, apps, workspaces, servers, snippets, tunnels: tunnels.map((t) => ({ id: t.id, name: `${t.name} (${t.serverName})` })) }),
      )
      .catch(() => {});
    const unlisten = listen("automation://changed", refresh);
    return () => {
      unlisten.then((f) => f());
    };
  }, [refresh]);

  const save = async (input: AutomationInput) => {
    try {
      const saved = await api.automations.save(input);
      setList(saved);
      setVersion((v) => v + 1);
      // Nouvelle automatisation : on la sélectionne.
      if (input.id === null) {
        const created = saved.reduce<Automation | null>((m, a) => (!m || a.id > m.id ? a : m), null);
        if (created) setSelectedId(created.id);
      }
      return null;
    } catch (e) {
      return String(e);
    }
  };

  const edit = (a: Automation) =>
    setEditor({
      open: true,
      initial: { id: a.id, name: a.name, description: a.description, enabled: a.enabled, trigger: a.trigger, steps: a.steps, onError: a.onError, timeoutMinutes: a.timeoutMinutes },
    });

  const automationMenu = (a: Automation) =>
    contextMenu(() => [
      { heading: a.name },
      { label: a.running ? "En cours…" : "Exécuter maintenant", icon: Play, disabled: a.running, onSelect: () => api.automations.run(a.id).catch((e) => setError(String(e))) },
      {
        label: a.enabled ? "Désactiver" : "Activer",
        icon: a.enabled ? PowerOff : Power,
        onSelect: () => api.automations.setEnabled(a.id, !a.enabled).then(setList).catch((e) => setError(String(e))),
      },
      { separator: true },
      { label: "Modifier…", icon: Pencil, onSelect: () => edit(a) },
      {
        label: "Dupliquer…",
        icon: CopyPlus,
        onSelect: () =>
          setEditor({
            open: true,
            initial: { id: null, name: `${a.name} (copie)`, description: a.description, enabled: false, trigger: a.trigger, steps: a.steps, onError: a.onError, timeoutMinutes: a.timeoutMinutes },
          }),
      },
      { separator: true },
      {
        label: "Supprimer",
        icon: Trash2,
        danger: true,
        onSelect: async () => {
          const ok = await confirmAction({
            title: `Supprimer ${a.name} ?`,
            description: "L'automatisation est supprimée ; son historique d'exécution est conservé.",
            confirmLabel: "Supprimer",
          });
          if (ok) await api.automations.remove(a.id).then(setList).catch((e) => setError(String(e)));
        },
      },
    ]);

  const all = list ?? [];
  const q = filter.trim().toLowerCase();
  const shown = all.filter((a) => !q || a.name.toLowerCase().includes(q) || a.description.toLowerCase().includes(q));
  const selected = selectedId === "all" ? null : (all.find((a) => a.id === selectedId) ?? all[0] ?? null);
  const showAll = selectedId === "all" && all.length > 0;
  const enabledCount = all.filter((a) => a.enabled).length;

  return (
    <Page>
      <ListPane
        title="Automatisations"
        count={list ? `${all.length} workflow${all.length > 1 ? "s" : ""} · ${enabledCount} active${enabledCount > 1 ? "s" : ""}` : "…"}
        actions={
          <>
            <Button variant="ghost" size="icon" className="size-8" onClick={() => setLibraryOpen(true)} aria-label="Modèles" title="Modèles">
              <BookOpen />
            </Button>
            <Button variant="ghost" size="icon" className="size-8" onClick={() => setEditor({ open: true, initial: null })} aria-label="Nouvelle automatisation" title="Nouvelle automatisation">
              <Plus />
            </Button>
          </>
        }
        filter={filter}
        onFilter={all.length > 6 ? setFilter : undefined}
        footer={
          all.length > 0 && (
            <ListItem active={showAll} onClick={() => setSelectedId("all")}>
              <span className="flex items-center gap-2 text-sm text-foreground/85">
                <History className="size-3.5 text-muted-foreground" /> Historique complet
              </span>
            </ListItem>
          )
        }
      >
        {shown.map((a) => {
          const active = !showAll && selected?.id === a.id;
          return (
            <ListItem key={a.id} active={active} onClick={() => setSelectedId(a.id)} onContextMenu={automationMenu(a)}>
              <span className="flex items-center gap-2">
                <AutomationDot a={a} />
                <span className={cn("truncate text-sm", !a.enabled ? "text-muted-foreground" : active ? "text-foreground" : "text-foreground/85")}>{a.name}</span>
              </span>
              <span className="meta truncate pl-4">{triggerLabel(a.trigger, refs)}</span>
            </ListItem>
          );
        })}
        {shown.length === 0 && all.length > 0 && <p className="px-3 py-2 text-sm text-muted-foreground">Aucun résultat.</p>}
      </ListPane>

      <div className="flex min-w-0 flex-1 flex-col">
        {error && <PageNotice onDismiss={() => setError(null)}>{error}</PageNotice>}
        {list && list.length === 0 ? (
          <PageMain>
            <EmptyState
              icon={Workflow}
              title="Aucune automatisation"
              text="Partez d'un modèle (démarrer la journée, surveiller un serveur…) ou créez votre propre workflow."
              actions={
                <>
                  <Button variant="outline" onClick={() => setLibraryOpen(true)}>
                    <BookOpen /> Modèles
                  </Button>
                  <Button onClick={() => setEditor({ open: true, initial: null })}>
                    <Plus /> Nouvelle
                  </Button>
                </>
              }
            />
          </PageMain>
        ) : showAll ? (
          <PageMain>
            <PageBar title="Historique complet" meta="Toutes les exécutions, y compris celles d'automatisations supprimées" />
            <PageBody>
              <RunHistory version={version} automationId={null} />
            </PageBody>
          </PageMain>
        ) : (
          selected && <AutomationView key={selected.id} a={selected} refs={refs} version={version} onEdit={() => edit(selected)} onChanged={setList} onError={setError} />
        )}
      </div>

      <Dialog open={libraryOpen} onOpenChange={setLibraryOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Bibliothèque de workflows</DialogTitle>
            <DialogDescription>Choisissez un modèle : il s'ouvre dans l'éditeur pour être adapté avant enregistrement.</DialogDescription>
          </DialogHeader>
          <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {templates(refs).map((t) => (
              <li key={t.id}>
                <button
                  type="button"
                  onClick={() => {
                    setLibraryOpen(false);
                    setEditor({ open: true, initial: t.input });
                  }}
                  className="grid h-full w-full gap-1 rounded-lg border p-3 text-left transition-colors hover:border-primary/50 hover:bg-accent/40"
                >
                  <span className="text-sm font-medium">{t.title}</span>
                  <span className="text-xs text-muted-foreground">{t.description}</span>
                </button>
              </li>
            ))}
          </ul>
        </DialogContent>
      </Dialog>

      <AutomationEditor initial={editor.initial} open={editor.open} onOpenChange={(open) => setEditor((e) => ({ ...e, open }))} onSave={save} refs={refs} />
    </Page>
  );
}
