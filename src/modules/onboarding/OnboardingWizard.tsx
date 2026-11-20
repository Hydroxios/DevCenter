import { Suspense, lazy, useEffect, useRef, useState } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useNavigate } from "react-router";
import {
  ArrowLeft,
  ArrowRight,
  Boxes,
  Check,
  CircleCheck,
  Code2,
  FolderOpen,
  FolderSearch,
  Gauge,
  Layers,
  Loader2,
  Play,
  Server,
  Smartphone,
  Sparkles,
  Workflow,
  type LucideIcon,
} from "lucide-react";

import { GithubIcon } from "@/components/GithubIcon";
import { LogoMark } from "@/components/layout/Logo";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Select } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { ScanCandidateList } from "@/modules/projects/ScanDialog";
import { api } from "@/services/tauri";
import { useOnboarding } from "@/stores/onboarding";
import { useSettings } from "@/stores/settings";
import { useWorkspaces } from "@/stores/workspaces";
import type { GithubStatus, Project, ProjectScript, ScanCandidate, WorkspaceStep } from "@/types";

const GithubLogin = lazy(() => import("@/modules/settings/GithubLogin"));

const STEPS = [
  { id: "welcome", label: "Bienvenue" },
  { id: "projects", label: "Projets" },
  { id: "editor", label: "Éditeur" },
  { id: "workspace", label: "Workspace" },
  { id: "extras", label: "Pour aller plus loin" },
] as const;

/** Scripts proposés en priorité pour le premier workspace. */
const PREFERRED_SCRIPTS = ["dev", "start", "serve", "watch"];

const FEATURES: { icon: LucideIcon; title: string; text: string }[] = [
  { icon: Boxes, title: "Projets", text: "Tous vos dépôts au même endroit : statut Git, scripts, ouverture dans l'éditeur." },
  { icon: Layers, title: "Workspaces", text: "Un clic pour ouvrir l'éditeur, lancer le serveur de dev et le navigateur." },
  { icon: Server, title: "Serveurs", text: "Vos machines distantes en SSH : métriques, services, conteneurs, terminal." },
  { icon: Workflow, title: "Automatisations", text: "Tâches planifiées ou déclenchées, avec historique." },
  { icon: Gauge, title: "Système", text: "Processus, matériel et applications favorites de ce PC." },
  { icon: Smartphone, title: "Accès mobile", text: "Un tableau de bord sur votre téléphone, sur le réseau local." },
];

function StepHeader({ eyebrow, title, children }: { eyebrow: string; title: string; children?: React.ReactNode }) {
  return (
    <div className="grid gap-2">
      <p className="eyebrow text-primary">{eyebrow}</p>
      <DialogPrimitive.Title className="text-2xl font-semibold tracking-tight">{title}</DialogPrimitive.Title>
      {children && <DialogPrimitive.Description className="text-sm leading-relaxed text-muted-foreground">{children}</DialogPrimitive.Description>}
    </div>
  );
}

/** Assistant plein écran du premier lancement (relançable depuis Paramètres > À propos). */
export default function OnboardingWizard() {
  const finish = useOnboarding((s) => s.finish);
  const navigate = useNavigate();
  const { settings, update } = useSettings();

  const [step, setStep] = useState(0);
  const [visited, setVisited] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);

  // Étape 2 : dossier + projets détectés.
  const [root, setRoot] = useState<string | null>(settings.projectsRoot);
  const [scanning, setScanning] = useState(false);
  const [candidates, setCandidates] = useState<ScanCandidate[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [imported, setImported] = useState<number | null>(null);

  // Étape 3 : éditeur.
  const [detected, setDetected] = useState<string | null | undefined>(undefined);

  // Étape 4 : premier workspace.
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState<number | null>(null);
  const [scripts, setScripts] = useState<ProjectScript[] | null>(null);
  const [script, setScript] = useState<string>("");
  const [startNow, setStartNow] = useState(false);
  const [created, setCreated] = useState<string | null>(null);

  // Étape 5 : GitHub.
  const [github, setGithub] = useState<GithubStatus | null>(null);
  const [githubLogin, setGithubLogin] = useState(false);

  const current = STEPS[step].id;
  const last = step === STEPS.length - 1;

  const goTo = (i: number) => {
    setError(null);
    setStep(i);
    setVisited((v) => Math.max(v, i));
  };
  const next = () => (last ? finish() : goTo(step + 1));
  const back = () => step > 0 && goTo(step - 1);

  // Le bouton principal prend le focus à chaque étape : Entrée avance.
  useEffect(() => {
    primaryRef.current?.focus();
  }, [step]);

  useEffect(() => {
    if (current === "editor" && detected === undefined) api.projects.detectEditor().then(setDetected).catch(() => setDetected(null));
    if (current === "workspace") {
      api.projects
        .list()
        .then((list) => {
          setProjects(list);
          setProjectId((id) => (id !== null && list.some((p) => p.id === id) ? id : (list[0]?.id ?? null)));
        })
        .catch((e) => setError(String(e)));
    }
    if (current === "extras" && !github) api.github.status().then(setGithub).catch(() => {});
  }, [current, detected, github]);

  // Scripts du projet choisi pour le workspace.
  useEffect(() => {
    if (projectId === null) return;
    let cancelled = false;
    setScripts(null);
    api.projects
      .details(projectId)
      .then((d) => {
        if (cancelled) return;
        setScripts(d.meta.scripts);
        const names = d.meta.scripts.map((s) => s.name);
        setScript(PREFERRED_SCRIPTS.find((n) => names.includes(n)) ?? "");
      })
      .catch(() => !cancelled && setScripts([]));
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const scan = async (dir: string) => {
    setScanning(true);
    setError(null);
    setImported(null);
    try {
      const found = await api.projects.scan(dir);
      setCandidates(found);
      setSelected(new Set(found.map((c) => c.path)));
    } catch (e) {
      setError(String(e));
    } finally {
      setScanning(false);
    }
  };

  const pickRoot = async () => {
    const dir = await openDialog({ directory: true, multiple: false, title: "Dossier de vos projets" });
    if (typeof dir !== "string") return;
    setRoot(dir);
    update("projectsRoot", dir);
    await scan(dir);
  };

  const toggle = (path: string) =>
    setSelected((prev) => {
      const nextSet = new Set(prev);
      if (nextSet.has(path)) nextSet.delete(path);
      else nextSet.add(path);
      return nextSet;
    });

  const importSelected = async () => {
    setBusy(true);
    setError(null);
    try {
      const count = selected.size;
      await api.projects.add([...selected]);
      await useWorkspaces.getState().refreshRefs();
      setImported(count);
      setCandidates((c) => c?.filter((x) => !selected.has(x.path)) ?? null);
      setSelected(new Set());
      return true;
    } catch (e) {
      setError(String(e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const browseEditor = async () => {
    const file = await openDialog({
      multiple: false,
      directory: false,
      title: "Choisir l'éditeur",
      filters: [{ name: "Éditeur", extensions: ["exe", "cmd", "bat"] }],
    });
    if (typeof file === "string") update("editorPath", file);
  };

  const project = projects.find((p) => p.id === projectId) ?? null;

  const createWorkspace = async () => {
    if (!project) return false;
    setBusy(true);
    setError(null);
    const steps: WorkspaceStep[] = [{ kind: "editor", projectId: project.id }];
    if (script) steps.push({ kind: "script", projectId: project.id, script, openBrowser: true });
    const store = useWorkspaces.getState();
    await store.refreshRefs();
    const ok = await store.save({ id: null, name: project.name, description: "Créé par l'assistant de démarrage", favorite: true, steps });
    if (!ok) {
      setError(useWorkspaces.getState().error);
      setBusy(false);
      return false;
    }
    const ws = useWorkspaces
      .getState()
      .workspaces?.filter((w) => w.name === project.name)
      .sort((a, b) => b.id - a.id)[0];
    if (ws && startNow) await useWorkspaces.getState().start(ws.id);
    setCreated(project.name);
    setBusy(false);
    return true;
  };

  /** Bouton principal : l'action utile de l'étape, puis on avance. */
  const primary = (() => {
    if (current === "welcome") return { label: "Commencer", run: next };
    if (current === "projects" && selected.size > 0)
      return { label: `Ajouter ${selected.size} projet${selected.size > 1 ? "s" : ""} et continuer`, run: async () => (await importSelected()) && next() };
    if (current === "workspace" && project && !created)
      return { label: "Créer le workspace et continuer", run: async () => (await createWorkspace()) && next() };
    if (last) return { label: "Terminer", run: next };
    return { label: "Suivant", run: next };
  })();
  const canSkipStep = !last && current !== "welcome";

  const openRemote = async () => {
    await finish();
    navigate("/settings?tab=remote");
  };

  return (
    <DialogPrimitive.Root open onOpenChange={(o) => !o && finish()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Content
          className="fixed inset-0 z-50 flex flex-col bg-background text-foreground outline-none"
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            primaryRef.current?.focus();
          }}
          onKeyDown={(e) => {
            // Alt+← / Alt+→ : étape précédente / suivante (Échap ferme l'assistant).
            if (e.altKey && e.key === "ArrowLeft") {
              e.preventDefault();
              back();
            } else if (e.altKey && e.key === "ArrowRight" && !busy) {
              e.preventDefault();
              primary.run();
            }
          }}
        >
          {/* Fond discret : halo cyan. */}
          <div className="pointer-events-none absolute inset-x-0 top-0 h-80 bg-[radial-gradient(ellipse_at_top,rgba(34,211,238,0.12),transparent_70%)]" />

          <header className="relative flex items-center gap-4 border-b px-6 py-4">
            <div className="flex items-center gap-2.5">
              <LogoMark className="size-6" />
              <span className="font-mono text-sm">
                Dev<span className="text-primary">Center</span>
              </span>
            </div>
            <ol className="mx-auto hidden items-center gap-2 md:flex" aria-label="Progression">
              {STEPS.map((s, i) => (
                <li key={s.id} className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={i > visited}
                    onClick={() => goTo(i)}
                    aria-current={i === step ? "step" : undefined}
                    className={cn(
                      "flex items-center gap-2 rounded-full px-2 py-1 text-xs transition outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
                      i === step ? "text-foreground" : i <= visited ? "text-muted-foreground hover:text-primary" : "text-muted-foreground/50",
                    )}
                  >
                    <span
                      className={cn(
                        "flex size-6 items-center justify-center rounded-full border font-mono text-[11px]",
                        i === step && "border-primary bg-primary text-primary-foreground",
                        i < step && "border-primary/60 text-primary",
                      )}
                    >
                      {i < step ? <Check className="size-3.5" /> : i + 1}
                    </span>
                    {s.label}
                  </button>
                  {i < STEPS.length - 1 && <span className={cn("h-px w-6", i < step ? "bg-primary/60" : "bg-border")} />}
                </li>
              ))}
            </ol>
            <span className="meta ml-auto md:hidden">
              Étape {step + 1} / {STEPS.length}
            </span>
            <Button variant="ghost" size="sm" className="md:ml-0" onClick={() => finish()}>
              Ignorer l'assistant
            </Button>
          </header>
          <div className="relative h-0.5 bg-border/50">
            <div className="h-full bg-primary transition-all duration-300" style={{ width: `${((step + 1) / STEPS.length) * 100}%` }} />
          </div>

          <main className="relative min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto grid w-full max-w-2xl gap-6 px-6 py-10">
              {current === "welcome" && (
                <>
                  <StepHeader eyebrow="Bienvenue" title="Votre poste de développement, au même endroit">
                    DevCenter rassemble vos projets, lance vos environnements de travail en un clic et surveille vos serveurs. Quelques
                    réglages et c'est parti : chaque étape peut être passée et reprise plus tard depuis les Paramètres.
                  </StepHeader>
                  <div className="grid gap-3 sm:grid-cols-2">
                    {FEATURES.map(({ icon: Icon, title, text }) => (
                      <Card key={title} className="flex-row items-start gap-3 p-4">
                        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border bg-primary/10 text-primary">
                          <Icon className="size-4" />
                        </span>
                        <span className="grid gap-0.5">
                          <span className="text-sm font-medium">{title}</span>
                          <span className="text-xs leading-relaxed text-muted-foreground">{text}</span>
                        </span>
                      </Card>
                    ))}
                  </div>
                </>
              )}

              {current === "projects" && (
                <>
                  <StepHeader eyebrow="Étape 2" title="Où sont vos projets ?">
                    Choisissez le dossier qui contient vos dépôts. DevCenter l'analyse (4 niveaux maximum) et repère les projets Git, Node,
                    Rust, Python, Go et PHP. C'est aussi là que seront clonés les dépôts importés.
                  </StepHeader>
                  <div className="flex flex-wrap items-center gap-3">
                    <Button variant="secondary" onClick={pickRoot} disabled={scanning || busy}>
                      {scanning ? <Loader2 className="animate-spin" /> : <FolderOpen />}
                      {root ? "Changer de dossier" : "Choisir le dossier"}
                    </Button>
                    {root && !candidates && !scanning && (
                      <Button variant="outline" onClick={() => scan(root)}>
                        <FolderSearch /> Analyser
                      </Button>
                    )}
                    {root && (
                      <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground" title={root}>
                        {root}
                      </span>
                    )}
                  </div>
                  {imported !== null && (
                    <p className="flex items-center gap-2 text-sm">
                      <CircleCheck className="size-4 text-success" />
                      {imported} projet{imported > 1 ? "s" : ""} ajouté{imported > 1 ? "s" : ""}.
                    </p>
                  )}
                  {candidates &&
                    (candidates.length === 0 ? (
                      imported === null && <p className="text-sm text-muted-foreground">Aucun nouveau projet trouvé dans ce dossier.</p>
                    ) : (
                      <div className="grid gap-2">
                        <div className="flex items-center justify-between">
                          <span className="meta">
                            {candidates.length} projet{candidates.length > 1 ? "s" : ""} détecté{candidates.length > 1 ? "s" : ""}
                          </span>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() =>
                              setSelected(selected.size === candidates.length ? new Set() : new Set(candidates.map((c) => c.path)))
                            }
                          >
                            {selected.size === candidates.length ? "Tout décocher" : "Tout cocher"}
                          </Button>
                        </div>
                        <ScanCandidateList candidates={candidates} selected={selected} onToggle={toggle} className="max-h-[45vh]" />
                      </div>
                    ))}
                </>
              )}

              {current === "editor" && (
                <>
                  <StepHeader eyebrow="Étape 3" title="Votre éditeur de code">
                    Les projets et workspaces s'ouvrent dans cet éditeur. Par défaut, DevCenter cherche Cursor puis VS Code.
                  </StepHeader>
                  <Card className="flex-row items-center gap-4">
                    <span className="flex size-10 shrink-0 items-center justify-center rounded-lg border bg-primary/10 text-primary">
                      <Code2 className="size-5" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">
                        {settings.editorPath
                          ? "Éditeur choisi"
                          : detected === undefined
                            ? "Recherche…"
                            : detected
                              ? "Éditeur détecté"
                              : "Aucun éditeur détecté"}
                      </p>
                      <p className="truncate font-mono text-xs text-muted-foreground" title={settings.editorPath ?? detected ?? undefined}>
                        {settings.editorPath ?? detected ?? "Choisissez l'exécutable de votre éditeur (.exe, .cmd)."}
                      </p>
                    </div>
                    <div className="flex shrink-0 gap-2">
                      {settings.editorPath && (
                        <Button variant="ghost" size="sm" onClick={() => update("editorPath", null)}>
                          Automatique
                        </Button>
                      )}
                      <Button variant="outline" size="sm" onClick={browseEditor}>
                        <Code2 /> Choisir…
                      </Button>
                    </div>
                  </Card>
                </>
              )}

              {current === "workspace" && (
                <>
                  <StepHeader eyebrow="Étape 4 · facultatif" title="Votre premier workspace">
                    Un workspace démarre tout votre environnement d'un clic : il ouvre le projet dans l'éditeur et lance son script de
                    développement. Vous le retrouverez sur le tableau de bord et dans l'onglet Workspaces.
                  </StepHeader>
                  {projects.length === 0 ? (
                    <Card>
                      <p className="text-sm text-muted-foreground">
                        Aucun projet pour l'instant. Revenez à l'étape précédente pour en ajouter, ou passez cette étape.
                      </p>
                    </Card>
                  ) : created ? (
                    <p className="flex items-center gap-2 text-sm">
                      <CircleCheck className="size-4 text-success" /> Workspace « {created} » créé.
                    </p>
                  ) : (
                    <Card className="gap-4">
                      <label className="grid gap-1.5">
                        <span className="text-sm font-medium">Projet</span>
                        <Select value={projectId ?? ""} onChange={(e) => setProjectId(Number(e.target.value))}>
                          {projects.map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.name}
                            </option>
                          ))}
                        </Select>
                      </label>
                      <label className="grid gap-1.5">
                        <span className="text-sm font-medium">Script de développement</span>
                        <Select value={script} onChange={(e) => setScript(e.target.value)} disabled={scripts === null}>
                          <option value="">{scripts === null ? "Lecture des scripts…" : "Aucun (éditeur seulement)"}</option>
                          {scripts?.map((s) => (
                            <option key={s.name} value={s.name}>
                              {s.name} — {s.command}
                            </option>
                          ))}
                        </Select>
                      </label>
                      <div className="grid gap-1.5 rounded-lg border bg-secondary/50 p-3 text-sm">
                        <span className="flex items-center gap-2">
                          <Code2 className="size-4 text-primary" /> Ouvrir {project?.name} dans l'éditeur
                        </span>
                        {script && (
                          <span className="flex items-center gap-2">
                            <Play className="size-4 text-primary" /> Lancer « {script} » puis ouvrir le navigateur
                          </span>
                        )}
                      </div>
                      <label className="flex cursor-pointer items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          className="accent-[var(--primary)]"
                          checked={startNow}
                          onChange={(e) => setStartNow(e.target.checked)}
                        />
                        Démarrer le workspace tout de suite
                      </label>
                    </Card>
                  )}
                </>
              )}

              {current === "extras" && (
                <>
                  <StepHeader eyebrow="Étape 5 · facultatif" title="Pour aller plus loin">
                    Deux options à activer quand vous voulez, depuis les Paramètres.
                  </StepHeader>
                  <Card className="gap-3">
                    <div className="flex items-start gap-3">
                      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border bg-primary/10 text-primary [&_svg]:size-4">
                        <GithubIcon />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium">Compte GitHub</p>
                        <p className="text-xs leading-relaxed text-muted-foreground">
                          {!github
                            ? "Vérification…"
                            : !github.installed
                              ? "GitHub CLI (gh) n'est pas installé : winget install GitHub.cli"
                              : github.login
                                ? `Connecté : ${github.login}. Vos dépôts, privés compris, peuvent être listés et clonés.`
                                : "Connectez-vous pour lister et cloner vos dépôts, privés compris. Authentification officielle de GitHub CLI."}
                        </p>
                      </div>
                      {github?.installed && !github.login && !githubLogin && (
                        <Button size="sm" variant="outline" onClick={() => setGithubLogin(true)}>
                          <GithubIcon /> Se connecter
                        </Button>
                      )}
                    </div>
                    {githubLogin && (
                      <Suspense fallback={null}>
                        <GithubLogin
                          onExit={() => {
                            window.setTimeout(() => {
                              setGithubLogin(false);
                              api.github.status().then(setGithub).catch(() => {});
                            }, 1200);
                          }}
                        />
                      </Suspense>
                    )}
                  </Card>
                  <Card className="flex-row items-start gap-3">
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border bg-primary/10 text-primary">
                      <Smartphone className="size-4" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">Accès mobile</p>
                      <p className="text-xs leading-relaxed text-muted-foreground">
                        Suivez vos projets, lancez vos workspaces et recevez des notifications depuis votre téléphone, sur le réseau local
                        ou via Tailscale. Désactivé par défaut.
                      </p>
                    </div>
                    <Button size="sm" variant="outline" onClick={openRemote}>
                      Configurer
                    </Button>
                  </Card>
                  <p className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Sparkles className="size-4 text-primary" /> L'assistant peut être relancé depuis Paramètres › À propos.
                  </p>
                </>
              )}

              {error && <p className="text-sm text-destructive">{error}</p>}
            </div>
          </main>

          <footer className="relative flex items-center gap-2 border-t px-6 py-4">
            <Button variant="ghost" onClick={back} disabled={step === 0 || busy}>
              <ArrowLeft /> Précédent
            </Button>
            <span className="meta ml-2 hidden sm:inline">Entrée : continuer · Échap : ignorer</span>
            <div className="ml-auto flex gap-2">
              {canSkipStep && (
                <Button variant="ghost" onClick={next} disabled={busy}>
                  Passer cette étape
                </Button>
              )}
              <Button ref={primaryRef} onClick={() => primary.run()} disabled={busy || scanning}>
                {busy ? <Loader2 className="animate-spin" /> : last ? <Check /> : null}
                {primary.label}
                {!last && !busy && <ArrowRight />}
              </Button>
            </div>
          </footer>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
