import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { openUrl } from "@tauri-apps/plugin-opener";
import { CircleAlert, CircleCheck, CopyPlus, ExternalLink, History, Layers, LayoutList, Loader2, Pencil, Play, Plus, Square, Star, StarOff, Trash2 } from "lucide-react";

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
import { cn, formatDuration, formatRelative } from "@/lib/utils";
import { api, isTauri } from "@/services/tauri";
import { useRuns } from "@/stores/runs";
import { useWorkspaces } from "@/stores/workspaces";
import type { SessionRecord, SessionStatus, Workspace } from "@/types";
import { stepIcon, stepLabel } from "./steps";
import { WorkspaceEditor } from "./WorkspaceEditor";

const SESSION_LABEL: Record<SessionStatus, string> = {
  running: "En cours",
  completed: "Terminée",
  partial: "Avec erreurs",
  stopped: "Arrêtée",
  interrupted: "Interrompue",
};

const SESSION_VARIANT = {
  running: "success",
  completed: "default",
  partial: "warning",
  stopped: "outline",
  interrupted: "outline",
} as const;

/** Bouton démarrer/arrêter, réutilisé par le Dashboard. */
export function WorkspaceToggle({ workspace, size = "default" }: { workspace: Workspace; size?: "default" | "sm" }) {
  const { start, stop, busy } = useWorkspaces();
  const isBusy = busy === workspace.id;
  return workspace.active ? (
    <Button variant="outline" size={size} onClick={() => stop(workspace.id)} disabled={isBusy}>
      {isBusy ? <Loader2 className="animate-spin" /> : <Square />} Arrêter
    </Button>
  ) : (
    <Button size={size} onClick={() => start(workspace.id)} disabled={isBusy || workspace.steps.length === 0}>
      {isBusy ? <Loader2 className="animate-spin" /> : <Play />} Démarrer
    </Button>
  );
}

function DeleteDialog({ workspace }: { workspace: Workspace }) {
  const remove = useWorkspaces((s) => s.remove);
  const [isOpen, setIsOpen] = useState(false);
  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <Button variant="ghost" size="icon" className="size-8 hover:text-destructive" onClick={() => setIsOpen(true)} disabled={!!workspace.active} aria-label="Supprimer" title="Supprimer">
        <Trash2 />
      </Button>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Supprimer {workspace.name} ?</DialogTitle>
          <DialogDescription>Le workspace et ses étapes seront supprimés. L'historique des sessions est conservé.</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setIsOpen(false)}>Annuler</Button>
          <Button variant="destructive" onClick={async () => { await remove(workspace.id); setIsOpen(false); }}>Supprimer</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ActiveRuns({ workspace }: { workspace: Workspace }) {
  const runs = useRuns((s) => s.runs);
  const active = workspace.active!;
  const sessionRuns = active.runIds.map((id) => runs[id]).filter(Boolean);
  const failures = active.results.filter((r) => !r.ok);

  return (
    <div className="grid gap-2 rounded-lg bg-success/8 p-3 text-sm">
      <p className="flex items-center gap-2 text-success">
        <span className="size-2 animate-pulse rounded-full bg-current" />
        Session démarrée {formatRelative(active.startedAt)}
      </p>
      {sessionRuns.map((r) => (
        <div key={r.id} className="flex items-center gap-2">
          <Badge variant={r.status === "running" ? "success" : r.status === "failed" ? "destructive" : "outline"}>{r.script}</Badge>
          <span className="text-xs text-muted-foreground">{r.status === "running" ? `PID ${r.pid}` : r.status === "failed" ? `échec (${r.exitCode ?? "?"})` : "terminé"}</span>
          {r.url && r.status === "running" && (
            <button type="button" onClick={() => openUrl(r.url!)} className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
              {r.url.replace(/^https?:\/\//, "")} <ExternalLink className="size-3" />
            </button>
          )}
        </div>
      ))}
      {failures.map((f, i) => (
        <p key={i} className="flex items-start gap-2 text-destructive">
          <CircleAlert className="mt-0.5 size-4 shrink-0" />
          <span><b>{f.label}</b> : {f.message}</span>
        </p>
      ))}
    </div>
  );
}

type Tab = "overview" | "history";
/** Dernier onglet ouvert par workspace (le temps de la session de l'app). */
const lastTab = new Map<number, Tab>();
let lastSelected: number | null = null;

function SessionHistory({ workspaceId, version }: { workspaceId: number; version: string }) {
  const [sessions, setSessions] = useState<SessionRecord[] | null>(null);
  useEffect(() => {
    api.workspaces
      .history(200)
      .then((all) => setSessions(all.filter((s) => s.workspaceId === workspaceId)))
      .catch(() => setSessions([]));
  }, [workspaceId, version]);

  if (!sessions) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Chargement…
      </p>
    );
  }
  if (sessions.length === 0) return <p className="text-sm text-muted-foreground">Aucune session pour ce workspace.</p>;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Sessions</CardTitle>
        <span className="meta">{sessions.length}</span>
      </CardHeader>
      <ul className="divide-y text-sm">
        {sessions.map((s) => {
          const failures = s.results.filter((r) => !r.ok);
          return (
            <li key={s.id} className="grid gap-1 py-2">
              <div className="flex items-center gap-3">
                {failures.length > 0 ? <CircleAlert className="size-4 shrink-0 text-warning" /> : <CircleCheck className="size-4 shrink-0 text-success" />}
                <span className="min-w-0 flex-1 truncate">{new Date(s.startedAt * 1000).toLocaleString("fr-FR")}</span>
                <Badge variant={SESSION_VARIANT[s.status]}>{SESSION_LABEL[s.status]}</Badge>
                <span className="w-24 shrink-0 text-right text-xs text-muted-foreground tabular-nums">
                  {s.endedAt && s.endedAt > s.startedAt ? formatDuration(s.endedAt - s.startedAt) : formatRelative(s.startedAt)}
                </span>
              </div>
              {failures.map((f, i) => (
                <p key={i} className="pl-7 text-xs text-destructive">
                  <b>{f.label}</b> : {f.message}
                </p>
              ))}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

function WorkspaceView({ workspace, onEdit, historyVersion }: { workspace: Workspace; onEdit: () => void; historyVersion: string }) {
  const { projects, apps, toggleFavorite } = useWorkspaces();
  const [tab, setTabState] = useState<Tab>(() => lastTab.get(workspace.id) ?? "overview");
  const setTab = (t: Tab) => {
    lastTab.set(workspace.id, t);
    setTabState(t);
  };

  return (
    <PageMain>
      <PageBar
        title={workspace.name}
        leading={workspace.active ? <span className="size-2 shrink-0 animate-pulse rounded-full bg-success" title="Session en cours" /> : undefined}
        meta={workspace.lastStartedAt ? `Dernière session ${formatRelative(workspace.lastStartedAt)}` : "Jamais démarré"}
        actions={
          <>
            <WorkspaceToggle workspace={workspace} size="sm" />
            <Button
              variant="ghost"
              size="icon"
              className="size-8"
              onClick={() => toggleFavorite(workspace)}
              aria-pressed={workspace.favorite}
              aria-label={workspace.favorite ? "Retirer des favoris" : "Ajouter aux favoris"}
              title={workspace.favorite ? "Retirer des favoris" : "Ajouter aux favoris"}
            >
              <Star className={cn(workspace.favorite && "fill-warning text-warning")} />
            </Button>
            <Button variant="ghost" size="icon" className="size-8" onClick={onEdit} disabled={!!workspace.active} aria-label="Modifier" title="Modifier">
              <Pencil />
            </Button>
            <DeleteDialog workspace={workspace} />
          </>
        }
      >
        {workspace.description && <p className="text-sm text-muted-foreground">{workspace.description}</p>}
      </PageBar>
      <PageTabs
        tabs={[
          { id: "overview", label: "Aperçu", icon: LayoutList, dot: !!workspace.active },
          { id: "history", label: "Historique", icon: History },
        ]}
        active={tab}
        onChange={setTab}
      />
      <PageBody>
        {tab === "overview" ? (
          <>
            {workspace.active && <ActiveRuns workspace={workspace} />}
            <Card>
              <CardHeader>
                <CardTitle>Étapes</CardTitle>
                <span className="meta">{workspace.steps.length}</span>
              </CardHeader>
              {workspace.steps.length === 0 ? (
                <p className="text-sm text-muted-foreground">Aucune étape : modifiez le workspace pour en ajouter.</p>
              ) : (
                <ol className="divide-y rounded-lg border text-sm">
                  {workspace.steps.map((step, i) => {
                    const Icon = stepIcon(step.kind);
                    return (
                      <li key={i} className="flex min-w-0 items-center gap-3 px-3 py-2">
                        <span className="meta w-4 shrink-0 text-right">{i + 1}</span>
                        <Icon className="size-4 shrink-0 text-muted-foreground" />
                        <span className="truncate">{stepLabel(step, projects, apps)}</span>
                      </li>
                    );
                  })}
                </ol>
              )}
            </Card>
          </>
        ) : (
          <SessionHistory workspaceId={workspace.id} version={historyVersion} />
        )}
      </PageBody>
    </PageMain>
  );
}

export function WorkspacesPage() {
  const { workspaces, error, init, clearError, start, stop, remove, toggleFavorite, save, busy } = useWorkspaces();
  const [editing, setEditing] = useState<Workspace | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [selectedId, setSelectedIdState] = useState<number | null>(lastSelected);
  const [filter, setFilter] = useState("");
  const setSelectedId = (id: number) => {
    lastSelected = id;
    setSelectedIdState(id);
  };

  useEffect(() => {
    init();
  }, [init]);

  // `?workspace=<id>` (clic sur une notification) : sélectionne ce workspace, onglet Aperçu.
  const [params, setParams] = useSearchParams();
  const linked = Number(params.get("workspace")) || null;
  useEffect(() => {
    if (linked === null) return;
    lastTab.set(linked, "overview");
    setSelectedId(linked);
    setParams((p) => {
      p.delete("workspace");
      return p;
    }, { replace: true });
  }, [linked, setParams]);

  if (!isTauri()) return <TauriOnly title="Workspaces" />;

  const openEditor = (w: Workspace | null) => {
    setEditing(w);
    setEditorOpen(true);
  };

  // Recharge l'historique quand une session démarre ou s'arrête.
  const historyVersion = (workspaces ?? []).map((w) => `${w.id}:${w.active?.sessionId ?? 0}`).join(",");
  // Favoris d'abord, puis ordre alphabétique.
  const sorted = [...(workspaces ?? [])].sort((a, b) => Number(b.favorite) - Number(a.favorite) || a.name.localeCompare(b.name));
  const q = filter.trim().toLowerCase();
  const shown = sorted.filter((w) => !q || w.name.toLowerCase().includes(q));
  const selected = sorted.find((w) => w.id === selectedId) ?? sorted[0] ?? null;
  const activeCount = sorted.filter((w) => w.active).length;
  const plural = (n: number, word: string) => `${n} ${word}${n > 1 ? "s" : ""}`;

  const workspaceMenu = (w: Workspace) =>
    contextMenu(() => [
      { heading: w.name },
      w.active
        ? { label: "Arrêter", icon: Square, disabled: busy === w.id, onSelect: () => stop(w.id) }
        : { label: "Démarrer", icon: Play, disabled: busy === w.id || w.steps.length === 0, onSelect: () => start(w.id) },
      { separator: true },
      { label: "Modifier…", icon: Pencil, onSelect: () => openEditor(w) },
      { label: w.favorite ? "Retirer des favoris" : "Ajouter aux favoris", icon: w.favorite ? StarOff : Star, onSelect: () => toggleFavorite(w) },
      {
        label: "Dupliquer",
        icon: CopyPlus,
        onSelect: () => save({ id: null, name: `${w.name} (copie)`, description: w.description, favorite: false, steps: w.steps }),
      },
      { separator: true },
      {
        label: "Supprimer",
        icon: Trash2,
        danger: true,
        disabled: !!w.active,
        onSelect: async () => {
          const ok = await confirmAction({
            title: `Supprimer ${w.name} ?`,
            description: "Le workspace et ses étapes seront supprimés. L'historique des sessions est conservé.",
            confirmLabel: "Supprimer",
          });
          if (ok) await remove(w.id);
        },
      },
    ]);

  return (
    <Page>
      <ListPane
        title="Workspaces"
        count={workspaces ? `${plural(workspaces.length, "workspace")}${activeCount ? ` · ${plural(activeCount, "actif")}` : ""}` : "…"}
        actions={
          <Button variant="ghost" size="icon" className="size-8" onClick={() => openEditor(null)} aria-label="Nouveau workspace" title="Nouveau workspace">
            <Plus />
          </Button>
        }
        filter={filter}
        onFilter={sorted.length > 6 ? setFilter : undefined}
      >
        {shown.map((w) => {
          const active = selected?.id === w.id;
          return (
            <ListItem key={w.id} active={active} onClick={() => setSelectedId(w.id)} onContextMenu={workspaceMenu(w)}>
              <span className="flex items-center gap-2">
                {w.favorite && <Star className="size-3.5 shrink-0 fill-warning text-warning" aria-label="Favori" />}
                <span className={cn("truncate text-sm", active ? "text-foreground" : "text-foreground/85")}>{w.name}</span>
                {w.active && (
                  <span className="ml-auto flex shrink-0 items-center gap-1 text-xs text-success" title="Session en cours">
                    <span className="size-1.5 animate-pulse rounded-full bg-current" /> actif
                  </span>
                )}
              </span>
              <span className="meta truncate">
                {plural(w.steps.length, "étape")}
                {w.lastStartedAt ? ` · ${formatRelative(w.lastStartedAt)}` : ""}
              </span>
            </ListItem>
          );
        })}
        {shown.length === 0 && sorted.length > 0 && <p className="px-3 py-2 text-sm text-muted-foreground">Aucun résultat.</p>}
      </ListPane>

      {workspaces && workspaces.length === 0 ? (
        <PageMain>
          {error && !editorOpen && <PageNotice onDismiss={clearError}>{error}</PageNotice>}
          <EmptyState
            icon={Layers}
            title="Aucun workspace"
            text={
              <>
                Par exemple : ouvrir le projet dans Cursor, lancer <code>pnpm dev</code>, démarrer Docker Desktop et ouvrir le navigateur sur localhost.
              </>
            }
            actions={
              <Button onClick={() => openEditor(null)}>
                <Plus /> Créer un workspace
              </Button>
            }
          />
        </PageMain>
      ) : (
        selected && (
          <div className="flex min-w-0 flex-1 flex-col">
            {error && !editorOpen && <PageNotice onDismiss={clearError}>{error}</PageNotice>}
            <WorkspaceView key={selected.id} workspace={selected} onEdit={() => openEditor(selected)} historyVersion={historyVersion} />
          </div>
        )
      )}

      <WorkspaceEditor workspace={editing} open={editorOpen} onOpenChange={setEditorOpen} />
    </Page>
  );
}
