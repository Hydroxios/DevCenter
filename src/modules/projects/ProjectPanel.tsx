import { Fragment, useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  Archive,
  ArrowDown,
  ArrowDownToLine,
  ArrowUp,
  ChevronDown,
  CloudDownload,
  Code2,
  ExternalLink,
  FolderOpen,
  GitBranch,
  GitCommitHorizontal,
  Loader2,
  Play,
  RefreshCw,
  Square,
  SquareTerminal,
  Trash2,
  X,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn, formatRelative } from "@/lib/utils";
import { api } from "@/services/tauri";
import { runsForProject, useRuns } from "@/stores/runs";
import { LinkifiedLine } from "@/components/LinkifiedText";
import type { GitStatus, Project, ProjectDetails, PullMode, RunInfo } from "@/types";
import { BranchDialog } from "./BranchDialog";
import { CommitDialog } from "./CommitDialog";
import { EnvPanel } from "./EnvPanel";
import { GitHistory } from "./GitHistory";
import { StashDialog } from "./StashDialog";
import { DependenciesPanel, useSevereVulns } from "./Dependencies";

/** Scripts mis en avant en tête de liste. */
const PRIMARY_SCRIPTS = ["dev", "start", "serve", "tauri", "bootRun", "run", "runClient", "quarkusDev", "build", "test", "lint"];

const STATUS_LABEL: Record<RunInfo["status"], string> = {
  running: "En cours",
  exited: "Terminé",
  failed: "Échec",
  stopped: "Arrêté",
};

const STATUS_VARIANT = {
  running: "success",
  exited: "default",
  failed: "destructive",
  stopped: "outline",
} as const;

function GitCard({
  git,
  hasGit,
  onOpenCommit,
  onOpenBranches,
  onCommit,
  onPush,
  pushing,
  onFetch,
  onPull,
  onStash,
  syncing,
  diverged,
}: {
  git: GitStatus | null | undefined;
  hasGit: boolean;
  onOpenCommit: (hash: string) => void;
  onOpenBranches: () => void;
  onCommit: () => void;
  onPush: () => void;
  pushing: boolean;
  onFetch: () => void;
  onPull: (mode: PullMode) => void;
  onStash: () => void;
  /** Opération réseau en cours sur ce projet. */
  syncing: "fetch" | PullMode | null;
  /** Le dernier pull en avance rapide a échoué : branches divergentes. */
  diverged: boolean;
}) {
  if (!hasGit) {
    return <p className="text-sm text-muted-foreground">Ce dossier n'est pas un dépôt Git.</p>;
  }
  if (!git) return <p className="text-sm text-muted-foreground">Lecture du dépôt…</p>;

  const changes = git.staged + git.modified + git.untracked + git.conflicts;
  // Pousser : commits en avance, ou branche jamais publiée.
  const canPush = !!git.branch && !!git.lastCommit && (git.ahead > 0 || !git.upstream);
  return (
    <div className="grid gap-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={onOpenBranches} title="Changer de branche ou en créer une" className="rounded-md transition hover:brightness-125">
          <Badge variant="primary" className="cursor-pointer">
            <GitBranch /> {git.branch ?? "HEAD détachée"} <ChevronDown className="opacity-70" />
          </Badge>
        </button>
        {git.ahead > 0 && (
          <Badge variant="outline" title="Commits à pousser">
            <ArrowUp /> {git.ahead}
          </Badge>
        )}
        {git.behind > 0 && (
          <Badge variant="warning" title="Commits à récupérer">
            <ArrowDown /> {git.behind}
          </Badge>
        )}
        {git.upstream && <span className="text-xs text-muted-foreground">→ {git.upstream}</span>}
        <div className="ml-auto flex items-center gap-1.5">
        <Button
          size="sm"
          variant="ghost"
          disabled={syncing !== null}
          onClick={onFetch}
          title="Récupérer les nouveautés du dépôt distant sans toucher aux fichiers (git fetch --prune)"
        >
          {syncing === "fetch" ? <Loader2 className="animate-spin" /> : <CloudDownload />} Récupérer
        </Button>
        {git.upstream && git.behind > 0 && (
          <Button
            size="sm"
            variant="outline"
            disabled={syncing !== null}
            onClick={() => onPull("ffOnly")}
            title={`Mettre la branche à jour depuis ${git.upstream} (git pull --ff-only)`}
          >
            {syncing === "ffOnly" ? <Loader2 className="animate-spin" /> : <ArrowDownToLine />} Tirer ({git.behind})
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={onStash} title="Mettre de côté ou réappliquer des modifications (git stash)">
          <Archive /> Remises
        </Button>
        {canPush && (
          <Button
            size="sm"
            variant="outline"
            disabled={pushing}
            onClick={onPush}
            title={git.upstream ? `Pousser vers ${git.upstream}` : "Publier la branche sur le dépôt distant"}
          >
            {pushing ? <Loader2 className="animate-spin" /> : <ArrowUp />}
            {git.upstream ? `Pousser${git.ahead > 0 ? ` (${git.ahead})` : ""}` : "Publier la branche"}
          </Button>
        )}
        </div>
      </div>

      {diverged && git.upstream && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-warning/40 bg-warning/5 px-3 py-2">
          <p className="min-w-0 flex-1 text-xs">
            La branche locale et <code>{git.upstream}</code> ont divergé : l'avance rapide est impossible.
          </p>
          <Button
            size="sm"
            variant="outline"
            disabled={syncing !== null}
            onClick={() => onPull("merge")}
            title={`Fusionner ${git.upstream} dans la branche (git pull --no-rebase)`}
          >
            {syncing === "merge" && <Loader2 className="animate-spin" />} Fusionner
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={syncing !== null}
            onClick={() => onPull("rebase")}
            title={`Rejouer vos commits par-dessus ${git.upstream} (git pull --rebase)`}
          >
            {syncing === "rebase" && <Loader2 className="animate-spin" />} Rebaser
          </Button>
        </div>
      )}

      {changes === 0 ? (
        <p className="text-muted-foreground">Aucune modification locale.</p>
      ) : (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          {git.staged > 0 && <span><b className="tabular-nums">{git.staged}</b> indexé{git.staged > 1 && "s"}</span>}
          {git.modified > 0 && <span><b className="tabular-nums">{git.modified}</b> modifié{git.modified > 1 && "s"}</span>}
          {git.untracked > 0 && <span><b className="tabular-nums">{git.untracked}</b> non suivi{git.untracked > 1 && "s"}</span>}
          {git.conflicts > 0 && <span className="text-destructive"><b className="tabular-nums">{git.conflicts}</b> en conflit</span>}
          <Button size="sm" variant="secondary" className="ml-auto" onClick={onCommit} title="Préparer et créer un commit">
            <GitCommitHorizontal /> Committer
          </Button>
        </div>
      )}

      {git.lastCommit ? (
        <button
          type="button"
          onClick={() => onOpenCommit(git.lastCommit!.hash)}
          className="group -mx-2 flex min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left text-muted-foreground transition-colors hover:bg-primary/8"
          title="Voir ce commit dans l'historique"
        >
          <GitCommitHorizontal className="size-4 shrink-0 group-hover:text-primary" />
          <code className="text-xs group-hover:text-primary">{git.lastCommit.hash}</code>
          <span className="truncate text-foreground">{git.lastCommit.subject}</span>
          <span className="shrink-0 text-xs">{formatRelative(git.lastCommit.timestamp)}</span>
        </button>
      ) : (
        <p className="text-muted-foreground">Aucun commit.</p>
      )}
    </div>
  );
}

function LogViewer({ run }: { run: RunInfo }) {
  const lines = useRuns((s) => s.logs[run.id]);
  const base = useRuns((s) => s.logBase[run.id] ?? 0);
  const loadLogs = useRuns((s) => s.loadLogs);
  const ref = useRef<HTMLPreElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    loadLogs(run.id);
  }, [run.id, loadLogs]);

  // Défilement automatique, sauf si l'utilisateur est remonté dans les logs.
  useEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [lines]);

  return (
    <pre
      ref={ref}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      }}
      className="h-72 overflow-auto rounded-lg border bg-black p-3 font-mono text-xs leading-relaxed text-[#d4d4d8] select-text"
    >
      {lines && lines.length > 0 ? (
        // Une ligne par élément, avec une clé stable (`base + i`) même quand les plus anciennes sont
        // retirées : seules les nouvelles lignes sont calculées (adresses cliquables).
        lines.map((line, i) => (
          <Fragment key={base + i}>
            {i > 0 && "\n"}
            <LinkifiedLine text={line} />
          </Fragment>
        ))
      ) : (
        <span className="opacity-60">En attente de sortie…</span>
      )}
    </pre>
  );
}

function RemoveDialog({ project, onRemoved }: { project: Project; onRemoved: (list: Project[]) => void }) {
  const [isOpen, setIsOpen] = useState(false);
  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <Button variant="ghost" size="icon" onClick={() => setIsOpen(true)} aria-label="Retirer le projet" title="Retirer de DevCenter">
        <Trash2 />
      </Button>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Retirer {project.name} ?</DialogTitle>
          <DialogDescription>
            Le projet disparaît de DevCenter. Le dossier et ses fichiers ne sont pas touchés.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setIsOpen(false)}>Annuler</Button>
          <Button variant="destructive" onClick={async () => onRemoved(await api.projects.remove(project.id))}>
            Retirer
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Groupes Gradle repliés par défaut (tâches internes rarement lancées à la main). */
const SECONDARY_GROUPS = ["Help", "Build Setup", "Other"];
/** Projets dont la lecture des tâches Gradle a échoué : pas de nouvel essai automatique. */
const gradleFailed = new Set<number>();

type PanelTab = "overview" | "history" | "env" | "dependencies";
/** Dernier onglet ouvert par projet (le temps de la session de l'app). */
const lastTab = new Map<number, PanelTab>();

export function ProjectPanel({
  project,
  details,
  onRefresh,
  onRemoved,
  onDetails,
}: {
  project: Project;
  details: ProjectDetails | undefined;
  onRefresh: () => void;
  onRemoved: (list: Project[]) => void;
  onDetails: (d: ProjectDetails) => void;
}) {
  const allRuns = useRuns((s) => s.runs);
  const { start, stop, dismiss, error: runError } = useRuns();
  const runs = runsForProject(allRuns, project.id);
  const [selectedRun, setSelectedRun] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // Sélectionne automatiquement l'exécution la plus récente du projet.
  const latest = runs.reduce<RunInfo | null>((a, r) => (!a || r.id > a.id ? r : a), null);
  const shownRun = runs.find((r) => r.id === selectedRun) ?? latest;

  useEffect(() => {
    setSelectedRun(null);
    setActionError(null);
    setFocusCommit(null);
  }, [project.id]);

  const act = async (fn: () => Promise<unknown>) => {
    try {
      setActionError(null);
      await fn();
    } catch (e) {
      setActionError(String(e));
    }
  };

  const meta = details?.meta;
  const gradle = meta?.packageManager === "gradle";
  // Gradle : ordre du backend (groupes du projet d'abord) ; sinon scripts principaux en tête.
  const allScripts = gradle
    ? (meta?.scripts ?? [])
    : [...(meta?.scripts ?? [])].sort((a, b) => {
        const ia = PRIMARY_SCRIPTS.indexOf(a.name);
        const ib = PRIMARY_SCRIPTS.indexOf(b.name);
        return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.name.localeCompare(b.name);
      });
  const [scriptFilter, setScriptFilter] = useState("");
  const [showAllTasks, setShowAllTasks] = useState(false);
  const filterText = scriptFilter.trim().toLowerCase();
  const hiddenCount = filterText ? 0 : allScripts.filter((s) => s.group && SECONDARY_GROUPS.includes(s.group)).length;
  const scripts = allScripts.filter((s) =>
    filterText
      ? s.name.toLowerCase().includes(filterText) || s.command.toLowerCase().includes(filterText)
      : showAllTasks || !s.group || !SECONDARY_GROUPS.includes(s.group),
  );

  // Tâches Gradle réelles (`gradlew tasks --all`), lues en arrière-plan.
  const [gradleLoading, setGradleLoading] = useState<number | null>(null);
  const [gradleError, setGradleError] = useState<string | null>(null);
  const loadGradleTasks = async (id: number) => {
    setGradleLoading(id);
    setGradleError(null);
    try {
      onDetails(await api.projects.gradleTasks(id));
      gradleFailed.delete(id);
    } catch (e) {
      gradleFailed.add(id);
      setGradleError(String(e));
    } finally {
      setGradleLoading((cur) => (cur === id ? null : cur));
    }
  };
  useEffect(() => {
    setScriptFilter("");
    setShowAllTasks(false);
    setGradleError(null);
  }, [project.id]);
  useEffect(() => {
    if (gradle && meta && !meta.tasksLoaded && project.exists && !gradleFailed.has(project.id) && gradleLoading !== project.id) {
      loadGradleTasks(project.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id, gradle, meta?.tasksLoaded]);
  const runnable = meta?.packageManager && ["npm", "pnpm", "yarn", "bun", "gradle"].includes(meta.packageManager);

  const hasGit = project.exists && (meta?.hasGit ?? false);
  const [tab, setTabState] = useState<PanelTab>(() => lastTab.get(project.id) ?? "overview");
  const setTab = (t: PanelTab) => {
    lastTab.set(project.id, t);
    setTabState(t);
  };
  const activeTab: PanelTab =
    (tab === "history" && !hasGit) || ((tab === "env" || tab === "dependencies") && !project.exists) ? "overview" : tab;
  const severeVulns = useSevereVulns(project.id);
  /** Commit à mettre en avant à l'ouverture de l'historique (clic sur le dernier commit). */
  const [focusCommit, setFocusCommit] = useState<string | null>(null);
  const runningCount = runs.filter((r) => r.status === "running").length;
  const [branchOpen, setBranchOpen] = useState(false);
  const [commitOpen, setCommitOpen] = useState(false);
  const [stashOpen, setStashOpen] = useState(false);
  const [syncing, setSyncing] = useState<{ id: number; op: "fetch" | PullMode } | null>(null);
  const [diverged, setDiverged] = useState<number | null>(null);
  useEffect(() => setDiverged(null), [project.id]);
  const sync = async (op: "fetch" | PullMode) => {
    const id = project.id;
    setSyncing({ id, op });
    setActionError(null);
    try {
      onDetails(op === "fetch" ? await api.git.fetch(id) : await api.git.pull(id, op));
      if (op !== "fetch") setDiverged(null);
    } catch (e) {
      const msg = String(e);
      if (op === "ffOnly" && msg.includes("divergé")) setDiverged(id);
      setActionError(`${op === "fetch" ? "Récupération" : "Pull"} impossible : ${msg}`);
      // Un pull en conflit modifie quand même le dépôt : statut à relire.
      if (op !== "fetch") api.projects.details(id, true).then(onDetails, () => {});
    } finally {
      setSyncing((cur) => (cur?.id === id ? null : cur));
    }
  };
  const [pushing, setPushing] = useState<number | null>(null);
  const push = async () => {
    const id = project.id;
    setPushing(id);
    setActionError(null);
    try {
      onDetails(await api.git.push(id));
    } catch (e) {
      setActionError(`Push impossible : ${e}`);
    } finally {
      setPushing((cur) => (cur === id ? null : cur));
    }
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {/* Barre d'en-tête du projet */}
      <header className="flex items-start gap-4 border-b px-6 pt-5 pb-4">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-3">
            <h2 className="truncate text-lg font-semibold tracking-tight">{project.name}</h2>
            {details?.git && (
              <button
                type="button"
                onClick={() => setBranchOpen(true)}
                className="-mx-1.5 min-w-0 rounded-md px-1.5 py-0.5 transition-colors hover:bg-primary/8"
                title="Changer de branche ou en créer une"
              >
                <GitSummary git={details.git} />
              </button>
            )}
          </div>
          <p className="meta mt-0.5 truncate select-text" title={project.path}>{project.path}</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {meta?.frameworks.map((f) => <Badge key={f} variant="primary">{f}</Badge>)}
            {meta?.languages.map((l) => <Badge key={l}>{l}</Badge>)}
            {meta?.packageManager && <Badge variant="outline">{meta.packageManager}</Badge>}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {project.exists && (
            <>
              <Button size="sm" onClick={() => act(() => api.projects.openInEditor(project.id))}>
                <Code2 /> Ouvrir dans l'éditeur
              </Button>
              <Button variant="outline" size="sm" onClick={() => act(() => api.projects.openFolder(project.id))}>
                <FolderOpen /> Dossier
              </Button>
              <Button variant="outline" size="sm" onClick={() => act(() => api.projects.openTerminal(project.id))} title="Ouvrir un terminal dans ce dossier">
                <SquareTerminal /> Terminal
              </Button>
            </>
          )}
          <Button variant="ghost" size="icon" className="size-8" onClick={onRefresh} aria-label="Actualiser" title="Actualiser">
            <RefreshCw />
          </Button>
          <RemoveDialog project={project} onRemoved={onRemoved} />
        </div>
      </header>
      {hasGit && (
        <>
          <BranchDialog projectId={project.id} git={details?.git} open={branchOpen} onOpenChange={setBranchOpen} onChanged={onDetails} />
          <CommitDialog
            projectId={project.id}
            canPush={!!details?.git?.branch}
            open={commitOpen}
            onOpenChange={setCommitOpen}
            onCommitted={onDetails}
            onPushError={(e) => setActionError(`Commit créé, mais le push a échoué : ${e}`)}
          />
          <StashDialog projectId={project.id} git={details?.git} open={stashOpen} onOpenChange={setStashOpen} onChanged={onDetails} />
        </>
      )}
      {!project.exists && <p className="border-b px-6 py-2 text-sm text-destructive">Dossier introuvable : il a été déplacé ou supprimé.</p>}
      {actionError && <p className="border-b px-6 py-2 text-sm text-destructive">{actionError}</p>}

      {/* Onglets */}
      <nav className="flex shrink-0 gap-1 border-b px-4" role="tablist">
        {([
          ["overview", "Aperçu", runningCount > 0 ? runningCount : null, "success"],
          ...(hasGit ? ([["history", "Historique", null, "success"]] as const) : []),
          ...(project.exists ? ([["env", "Environnement", null, "success"]] as const) : []),
          ...(project.exists ? ([["dependencies", "Dépendances", severeVulns > 0 ? severeVulns : null, "destructive"]] as const) : []),
        ] as const).map(([id, label, count, tone]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={activeTab === id}
            onClick={() => setTab(id)}
            className={cn(
              "relative flex items-center gap-1.5 px-3 py-2.5 text-sm transition-colors",
              activeTab === id ? "text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {label}
            {count !== null && (
              <span
                className={cn(
                  "rounded-full px-1.5 font-mono text-[10px]",
                  tone === "destructive" ? "bg-destructive/15 text-destructive" : "bg-success/15 text-success",
                )}
              >
                {count}
              </span>
            )}
            {activeTab === id && <span className="absolute inset-x-2 -bottom-px h-px bg-primary" />}
          </button>
        ))}
      </nav>

      {activeTab === "env" ? (
        <EnvPanel key={project.id} projectId={project.id} />
      ) : activeTab === "dependencies" ? (
        <DependenciesPanel projectId={project.id} packageManager={meta?.packageManager} />
      ) : activeTab === "history" ? (
        // Rechargé quand HEAD change (changement ou création de branche).
        <GitHistory
          key={`${details?.git?.branch}:${details?.git?.lastCommit?.hash}`}
          projectId={project.id}
          focusHash={focusCommit}
          onFocused={() => setFocusCommit(null)}
        />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="grid gap-4 p-6">
            {project.exists && (
              <Card>
                <CardHeader>
                  <CardTitle>Git</CardTitle>
                  {hasGit && (
                    <button type="button" onClick={() => setTab("history")} className="text-xs text-primary hover:underline">
                      Voir l'historique
                    </button>
                  )}
                </CardHeader>
                <GitCard
                  git={details?.git}
                  hasGit={meta?.hasGit ?? false}
                  onOpenCommit={(hash) => {
                    setFocusCommit(hash);
                    setTab("history");
                  }}
                  onOpenBranches={() => setBranchOpen(true)}
                  onCommit={() => setCommitOpen(true)}
                  onPush={push}
                  pushing={pushing === project.id}
                  onFetch={() => sync("fetch")}
                  onPull={sync}
                  onStash={() => setStashOpen(true)}
                  syncing={syncing?.id === project.id ? syncing.op : null}
                  diverged={diverged === project.id && (details?.git?.behind ?? 0) > 0}
                />
              </Card>
            )}

            {project.exists && allScripts.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle>{gradle ? "Tâches Gradle" : "Scripts"}</CardTitle>
                  {!runnable && meta?.packageManager && (
                    <span className="text-xs text-muted-foreground">Exécution non prise en charge pour {meta.packageManager}</span>
                  )}
                  {gradle && (
                    <span className="flex items-center gap-2 text-xs text-muted-foreground">
                      {gradleLoading === project.id ? (
                        <>
                          <Loader2 className="size-3.5 animate-spin" /> Lecture des tâches…
                        </>
                      ) : (
                        <button
                          type="button"
                          className="inline-flex items-center gap-1 hover:text-primary"
                          onClick={() => loadGradleTasks(project.id)}
                          title="Relire les tâches (gradlew tasks --all)"
                        >
                          <RefreshCw className="size-3" /> {meta?.tasksLoaded ? "Relire" : "Lire les tâches"}
                        </button>
                      )}
                    </span>
                  )}
                </CardHeader>
                {runError && <p className="text-sm text-destructive">{runError}</p>}
                {gradle && gradleError && <p className="text-sm text-destructive">{gradleError}</p>}
                {gradle && !meta?.tasksLoaded && gradleLoading !== project.id && !gradleError && (
                  <p className="text-xs text-muted-foreground">Liste estimée : les tâches du projet n'ont pas encore été lues.</p>
                )}
                {allScripts.length > 10 && (
                  <Input
                    aria-label="Filtrer"
                    className="h-8"
                    value={scriptFilter}
                    onChange={(e) => setScriptFilter(e.target.value)}
                    placeholder={gradle ? "Filtrer les tâches…" : "Filtrer les scripts…"}
                  />
                )}
                <ul className="divide-y rounded-lg border">
                  {scripts.length === 0 && <li className="px-3 py-3 text-sm text-muted-foreground">Aucun résultat.</li>}
                  {scripts.map((s, i) => {
                    const header = s.group && s.group !== scripts[i - 1]?.group ? s.group : null;
                    const run = runs.find((r) => r.script === s.name);
                    const running = run?.status === "running";
                    return (
                      <li key={s.name} className="grid">
                        {header && <div className="eyebrow border-b bg-foreground/[0.02] px-3 py-1.5">{header}</div>}
                        <div className="flex items-center gap-3 px-3 py-2">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="font-mono text-sm font-medium">{s.name}</span>
                            {run && (
                              <button type="button" onClick={() => setSelectedRun(run.id)} title="Voir les logs">
                                <Badge variant={STATUS_VARIANT[run.status]}>
                                  {running && <span className="size-1.5 animate-pulse rounded-full bg-current" />}
                                  {STATUS_LABEL[run.status]}
                                  {run.status === "failed" && run.exitCode !== null && ` (${run.exitCode})`}
                                </Badge>
                              </button>
                            )}
                            {run?.url && running && (
                              <button
                                type="button"
                                onClick={() => act(() => openUrl(run.url!))}
                                className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                              >
                                {run.url.replace(/^https?:\/\//, "")} <ExternalLink className="size-3" />
                              </button>
                            )}
                          </div>
                          <p className="truncate font-mono text-xs text-muted-foreground" title={s.command}>{s.command}</p>
                        </div>
                        {running ? (
                          <Button variant="outline" size="sm" onClick={() => stop(run.id)}>
                            <Square /> Arrêter
                          </Button>
                        ) : (
                          <Button
                            variant="secondary"
                            size="sm"
                            disabled={!runnable}
                            onClick={async () => {
                              const r = await start(project.id, s.name);
                              if (r) setSelectedRun(r.id);
                            }}
                          >
                            <Play /> Lancer
                          </Button>
                        )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
                {hiddenCount > 0 && (
                  <button type="button" className="justify-self-start text-xs text-primary hover:underline" onClick={() => setShowAllTasks((v) => !v)}>
                    {showAllTasks ? "Masquer les tâches internes" : `Afficher les tâches internes (${hiddenCount})`}
                  </button>
                )}
              </Card>
            )}

            {shownRun && (
              <Card className="gap-3">
                <CardHeader className="items-center">
                  <CardTitle className="flex min-w-0 items-center gap-2">
                    <span>Logs</span>
                    <span className="truncate font-mono text-xs" title={shownRun.command}>{shownRun.script}</span>
                    <Badge variant={STATUS_VARIANT[shownRun.status]}>{STATUS_LABEL[shownRun.status]}</Badge>
                    <span className="text-xs">PID {shownRun.pid}</span>
                  </CardTitle>
                  {shownRun.status !== "running" && (
                    <Button variant="ghost" size="icon" className="size-8" onClick={() => dismiss(shownRun.id)} aria-label="Effacer ces logs">
                      <X />
                    </Button>
                  )}
                </CardHeader>
                <LogViewer run={shownRun} />
              </Card>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function GitSummary({ git }: { git: GitStatus | null | undefined }) {
  if (!git) return null;
  const changes = git.staged + git.modified + git.untracked + git.conflicts;
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
      <GitBranch className="size-3 shrink-0" />
      <span className="truncate">{git.branch ?? "détachée"}</span>
      {changes > 0 && <span className={cn("shrink-0 tabular-nums text-warning")}>●{changes}</span>}
      {git.ahead > 0 && <span className="shrink-0 tabular-nums">↑{git.ahead}</span>}
      {git.behind > 0 && <span className="shrink-0 tabular-nums">↓{git.behind}</span>}
    </span>
  );
}
