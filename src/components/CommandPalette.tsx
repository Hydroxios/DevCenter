import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import type { LucideIcon } from "lucide-react";
import {
  CircleStop,
  CodeXml,
  Eye,
  EyeOff,
  FolderOpen,
  History,
  Layers,
  LoaderCircle,
  Monitor,
  Moon,
  Play,
  Search,
  Square,
  SquareTerminal,
  Sun,
  SunMoon,
  TerminalSquare,
  Workflow,
} from "lucide-react";

import { footerNav, mainNav } from "@/app/navigation";
import { matchItem } from "@/lib/fuzzy";
import { reportError } from "@/lib/logger";
import { cn } from "@/lib/utils";
import { api, isTauri } from "@/services/tauri";
import { PALETTE_SHORTCUT, usePalette } from "@/stores/palette";
import { FLOATING, FLOATING_TYPES } from "@/modules/overlay/registry";
import { OVERLAY_SHORTCUT } from "@/modules/overlay/FloatingLayer";
import { useOverlay } from "@/stores/overlay";
import { useRuns } from "@/stores/runs";
import { useSettings } from "@/stores/settings";
import { useWorkspaces } from "@/stores/workspaces";
import type { Automation, Project, ProjectDetails, Server, Theme } from "@/types";

type Group = "Navigation" | "Projets" | "Scripts" | "Workspaces" | "Automatisations" | "Serveurs" | "Préférences";
const GROUPS: Group[] = ["Navigation", "Projets", "Scripts", "Workspaces", "Automatisations", "Serveurs", "Préférences"];

interface Command {
  /** Identifiant stable (commandes récentes). */
  id: string;
  group: Group;
  label: string;
  /** Précision affichée en gris (projet, commande, hôte…). */
  detail?: string;
  /** Texte supplémentaire pris en compte par la recherche. */
  keywords?: string;
  icon: LucideIcon;
  /** Marque l'élément (thème courant, exécution en cours…). */
  badge?: string;
  disabled?: boolean;
  run: () => unknown;
}

interface Row {
  cmd: Command;
  indices: number[];
  score: number;
}

interface Section {
  title: string;
  rows: Row[];
}

/** Sans requête : nombre d'éléments affichés par section (taper pour voir le reste). */
const IDLE_LIMIT = 6;
const QUERY_LIMIT = 40;

/** Données gardées entre deux ouvertures : la palette s'affiche aussitôt, puis se met à jour. */
const cache: {
  projects: Project[];
  details: Record<number, ProjectDetails>;
  automations: Automation[];
  servers: Server[];
} = { projects: [], details: {}, automations: [], servers: [] };

function usePaletteData(open: boolean) {
  const [, force] = useState(0);
  const refreshWorkspaces = useWorkspaces((s) => s.refresh);
  const initWorkspaces = useWorkspaces((s) => s.init);

  useEffect(() => {
    if (!open || !isTauri()) return;
    let alive = true;
    const bump = () => alive && force((n) => n + 1);
    initWorkspaces();
    refreshWorkspaces();
    api.projects
      .list()
      .then((list) => {
        cache.projects = list;
        bump();
        // Les scripts viennent des détails (en cache côté Rust) ; un projet illisible est ignoré.
        list
          .filter((p) => p.exists)
          .forEach((p) =>
            api.projects
              .details(p.id)
              .then((d) => {
                cache.details = { ...cache.details, [p.id]: d };
                bump();
              })
              .catch(() => {}),
          );
      })
      .catch((e) => reportError("Palette : projets", e));
    api.automations
      .list()
      .then((list) => {
        cache.automations = list;
        bump();
      })
      .catch((e) => reportError("Palette : automatisations", e));
    api.servers
      .list()
      .then((list) => {
        cache.servers = list;
        bump();
      })
      .catch((e) => reportError("Palette : serveurs", e));
    return () => {
      alive = false;
    };
  }, [open, initWorkspaces, refreshWorkspaces]);

  return cache;
}

const THEMES: { value: Theme; label: string; icon: LucideIcon }[] = [
  { value: "dark", label: "Thème sombre", icon: Moon },
  { value: "light", label: "Thème clair", icon: Sun },
  { value: "system", label: "Thème du système", icon: Monitor },
];

function useCommands(open: boolean): Command[] {
  const navigate = useNavigate();
  const data = usePaletteData(open);
  const runs = useRuns((s) => s.runs);
  const startRun = useRuns((s) => s.start);
  const stopRun = useRuns((s) => s.stop);
  const workspaces = useWorkspaces((s) => s.workspaces);
  const busyWorkspace = useWorkspaces((s) => s.busy);
  const startWorkspace = useWorkspaces((s) => s.start);
  const stopWorkspace = useWorkspaces((s) => s.stop);
  const theme = useSettings((s) => s.settings.theme);
  const updateSetting = useSettings((s) => s.update);

  return useMemo(() => {
    const out: Command[] = [];
    const projectName = (id: number) => data.projects.find((p) => p.id === id)?.name ?? `Projet #${id}`;

    for (const item of [...mainNav, ...footerNav]) {
      out.push({
        id: `nav:${item.path}`,
        group: "Navigation",
        label: item.label,
        detail: "Aller à la page",
        keywords: "page aller ouvrir",
        icon: item.icon,
        run: () => navigate(item.path),
      });
    }

    for (const p of data.projects) {
      out.push({
        id: `project:show:${p.id}`,
        group: "Projets",
        label: p.name,
        detail: "Afficher le projet",
        keywords: `${p.path} afficher voir`,
        icon: Eye,
        run: () => navigate(`/projects?project=${p.id}`),
      });
      if (!p.exists) continue;
      out.push(
        {
          id: `project:editor:${p.id}`,
          group: "Projets",
          label: p.name,
          detail: "Ouvrir dans l'éditeur",
          keywords: `${p.path} editeur code cursor vscode ouvrir`,
          icon: CodeXml,
          run: () => api.projects.openInEditor(p.id),
        },
        {
          id: `project:folder:${p.id}`,
          group: "Projets",
          label: p.name,
          detail: "Ouvrir le dossier",
          keywords: `${p.path} dossier explorateur ouvrir`,
          icon: FolderOpen,
          run: () => api.projects.openFolder(p.id),
        },
        {
          id: `project:terminal:${p.id}`,
          group: "Projets",
          label: p.name,
          detail: "Ouvrir un terminal",
          keywords: `${p.path} terminal console shell`,
          icon: SquareTerminal,
          run: () => api.projects.openTerminal(p.id),
        },
      );
    }

    // Exécutions en cours d'abord : les arrêter est l'action la plus urgente.
    const running = Object.values(runs).filter((r) => r.status === "running");
    for (const r of running) {
      out.push({
        id: `run:stop:${r.projectId}:${r.script}`,
        group: "Scripts",
        label: `Arrêter ${r.script}`,
        detail: projectName(r.projectId),
        keywords: `${r.command} stop arreter tuer`,
        icon: CircleStop,
        badge: "en cours",
        run: () => stopRun(r.id),
      });
    }
    for (const p of data.projects) {
      for (const s of data.details[p.id]?.meta.scripts ?? []) {
        if (running.some((r) => r.projectId === p.id && r.script === s.name)) continue;
        out.push({
          id: `run:start:${p.id}:${s.name}`,
          group: "Scripts",
          label: s.name,
          detail: p.name,
          keywords: `${p.name} ${s.command} lancer executer script run`,
          icon: Play,
          run: async () => {
            if (!(await startRun(p.id, s.name))) throw new Error(useRuns.getState().error ?? "Lancement impossible");
          },
        });
      }
    }

    for (const w of workspaces ?? []) {
      const active = !!w.active;
      out.push({
        id: `workspace:${w.id}`,
        group: "Workspaces",
        label: `${active ? "Arrêter" : "Démarrer"} ${w.name}`,
        detail: w.description || undefined,
        keywords: `workspace ${active ? "stop arreter" : "start demarrer lancer"}`,
        icon: active ? Square : Layers,
        badge: active ? "actif" : undefined,
        disabled: busyWorkspace === w.id,
        run: async () => {
          await (active ? stopWorkspace(w.id) : startWorkspace(w.id));
          const error = useWorkspaces.getState().error;
          if (error) throw new Error(error);
        },
      });
    }

    for (const a of data.automations) {
      out.push({
        id: `automation:${a.id}`,
        group: "Automatisations",
        label: `Exécuter ${a.name}`,
        detail: a.description || undefined,
        keywords: "automatisation lancer executer run",
        icon: Workflow,
        badge: a.running ? "en cours" : undefined,
        disabled: a.running,
        run: () => api.automations.run(a.id),
      });
    }

    for (const s of data.servers) {
      const target = `${s.user ? `${s.user}@` : ""}${s.host}${s.port !== 22 ? `:${s.port}` : ""}`;
      out.push({
        id: `ssh:${s.id}`,
        group: "Serveurs",
        label: `Terminal SSH : ${s.name}`,
        detail: target,
        keywords: `ssh serveur terminal connexion ${s.host}`,
        icon: TerminalSquare,
        run: () => navigate(`/servers?server=${s.id}&terminal=1`),
      });
    }

    const overlay = useOverlay.getState();
    for (const t of FLOATING_TYPES) {
      out.push({
        id: `overlay:add:${t}`,
        group: "Préférences",
        label: `Widget flottant : ${FLOATING[t].title}`,
        detail: "Ajouter au-dessus des pages",
        keywords: "widget flottant overlay musique lecteur",
        icon: FLOATING[t].icon,
        run: () => overlay.add(t, FLOATING[t].size),
      });
    }
    if (overlay.widgets.length > 0) {
      out.push({
        id: "overlay:toggle",
        group: "Préférences",
        label: overlay.hidden ? "Afficher les widgets flottants" : "Masquer les widgets flottants",
        detail: OVERLAY_SHORTCUT,
        keywords: "widget flottant overlay",
        icon: overlay.hidden ? Eye : EyeOff,
        run: overlay.toggleHidden,
      });
    }

    const dark = theme === "dark" || (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    out.push({
      id: "theme:toggle",
      group: "Préférences",
      label: "Basculer clair / sombre",
      detail: dark ? "Passer au thème clair" : "Passer au thème sombre",
      keywords: "theme apparence mode",
      icon: SunMoon,
      run: () => updateSetting("theme", dark ? "light" : "dark"),
    });
    for (const t of THEMES) {
      out.push({
        id: `theme:${t.value}`,
        group: "Préférences",
        label: t.label,
        keywords: "theme apparence mode",
        icon: t.icon,
        badge: theme === t.value ? "actuel" : undefined,
        run: () => updateSetting("theme", t.value),
      });
    }
    return out;
    // `data` est un cache muable : `usePaletteData` force le rendu quand il change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, data.projects, data.details, data.automations, data.servers, runs, workspaces, busyWorkspace, theme, navigate]);
}

/** Classe les commandes : récents en tête sans requête, sinon score flou (avec un bonus pour les récents). */
function buildSections(commands: Command[], query: string, recent: string[]): Section[] {
  const recentRank = new Map(recent.map((id, i) => [id, i]));
  if (!query.trim()) {
    const byId = new Map(commands.map((c) => [c.id, c]));
    const recents = recent.map((id) => byId.get(id)).filter((c): c is Command => !!c);
    const sections: Section[] = [];
    if (recents.length) sections.push({ title: "Récents", rows: recents.map((cmd) => ({ cmd, indices: [], score: 0 })) });
    for (const g of GROUPS) {
      const rows = commands.filter((c) => c.group === g && !recentRank.has(c.id));
      const limit = g === "Navigation" || g === "Préférences" ? rows.length : IDLE_LIMIT;
      if (rows.length) sections.push({ title: g, rows: rows.slice(0, limit).map((cmd) => ({ cmd, indices: [], score: 0 })) });
    }
    return sections;
  }

  const rows: Row[] = [];
  for (const cmd of commands) {
    const m = matchItem(query, cmd.label, `${cmd.detail ?? ""} ${cmd.keywords ?? ""} ${cmd.group}`);
    if (!m) continue;
    const rank = recentRank.get(cmd.id);
    const bonus = rank === undefined ? 0 : 25 - rank * 2;
    rows.push({ cmd, indices: m.indices, score: m.score + bonus });
  }
  const sections: Section[] = [];
  for (const g of GROUPS) {
    const inGroup = rows.filter((r) => r.cmd.group === g).sort((a, b) => b.score - a.score);
    if (inGroup.length) sections.push({ title: g, rows: inGroup.slice(0, QUERY_LIMIT) });
  }
  // Les sections les plus pertinentes d'abord.
  return sections.sort((a, b) => b.rows[0].score - a.rows[0].score);
}

function Highlight({ text, indices }: { text: string; indices: number[] }) {
  if (!indices.length) return <>{text}</>;
  const set = new Set(indices);
  const parts: React.ReactNode[] = [];
  let buf = "";
  let on = false;
  const flush = (k: number) => {
    if (!buf) return;
    parts.push(on ? <mark key={k} className="bg-transparent text-primary">{buf}</mark> : <span key={k}>{buf}</span>);
    buf = "";
  };
  for (let i = 0; i < text.length; i++) {
    const hit = set.has(i);
    if (hit !== on) {
      flush(i);
      on = hit;
    }
    buf += text[i];
  }
  flush(text.length);
  return <>{parts}</>;
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="rounded border bg-background px-1.5 py-px font-mono text-[10px] text-muted-foreground">{children}</kbd>
  );
}

/** Ouvre la palette avec Ctrl+K (⌘K), partout sauf dans un terminal (où Ctrl+K a déjà un sens). */
function usePaletteShortcut() {
  const toggle = usePalette((s) => s.toggle);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== "k") return;
      const t = e.target as HTMLElement | null;
      if (t?.closest(".xterm")) return;
      e.preventDefault();
      toggle();
    };
    // Phase de capture : passe avant les gestionnaires des champs et des pages.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [toggle]);
}

export function CommandPalette() {
  usePaletteShortcut();
  const open = usePalette((s) => s.open);
  const setOpen = usePalette((s) => s.setOpen);
  const recent = usePalette((s) => s.recent);
  const remember = usePalette((s) => s.remember);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const commands = useCommands(open);
  const sections = useMemo(() => buildSections(commands, query, recent), [commands, query, recent]);
  const flat = useMemo(() => sections.flatMap((s) => s.rows), [sections]);

  // Nouvelle recherche : on revient au premier résultat.
  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    if (open) return;
    setQuery("");
    setError(null);
  }, [open]);

  const activeId = flat[Math.min(active, flat.length - 1)]?.cmd.id;
  useEffect(() => {
    if (!activeId) return;
    listRef.current?.querySelector(`[data-cmd="${CSS.escape(activeId)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [activeId]);

  const execute = useCallback(
    async (cmd: Command) => {
      if (cmd.disabled) return;
      remember(cmd.id);
      setError(null);
      // Les actions rapides ferment la palette tout de suite ; une erreur la rouvre avec le message.
      setOpen(false);
      setPending(cmd.id);
      try {
        await cmd.run();
      } catch (e) {
        reportError(`Palette : ${cmd.label}`, e);
        setError(`${cmd.label}${cmd.detail ? ` (${cmd.detail})` : ""} : ${e instanceof Error ? e.message : String(e)}`);
        setOpen(true);
      } finally {
        setPending(null);
      }
    },
    [remember, setOpen],
  );

  const onKeyDown = (e: React.KeyboardEvent) => {
    const n = flat.length;
    if (!n) return;
    const move = (to: number) => {
      e.preventDefault();
      setActive(((to % n) + n) % n);
    };
    const current = Math.min(active, n - 1);
    if (e.key === "ArrowDown") move(current + 1);
    else if (e.key === "ArrowUp") move(current - 1);
    else if (e.key === "PageDown") move(Math.min(current + 8, n - 1));
    else if (e.key === "PageUp") move(Math.max(current - 8, 0));
    else if (e.key === "Home" && e.ctrlKey) move(0);
    else if (e.key === "End" && e.ctrlKey) move(n - 1);
    else if (e.key === "Enter") {
      e.preventDefault();
      execute(flat[current].cmd);
    }
  };

  let index = -1;
  return (
    <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="dialog-overlay fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          onKeyDown={onKeyDown}
          className="dialog-content fixed top-[12vh] left-1/2 z-50 flex max-h-[min(560px,76vh)] w-[calc(100%-2rem)] max-w-xl -translate-x-1/2 flex-col overflow-hidden rounded-xl border bg-card text-card-foreground shadow-2xl shadow-black/60"
        >
          <DialogPrimitive.Title className="sr-only">Palette de commandes</DialogPrimitive.Title>
          <div className="flex items-center gap-3 border-b px-4">
            <Search className="size-4 shrink-0 text-muted-foreground" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Rechercher une page, un projet, un script, un serveur…"
              aria-label="Rechercher une commande"
              role="combobox"
              aria-expanded
              aria-controls="command-palette-list"
              aria-activedescendant={activeId ? `cmd-${activeId}` : undefined}
              className="h-12 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/70"
            />
            <Kbd>Échap</Kbd>
          </div>

          {error && <div className="border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-xs text-destructive">{error}</div>}

          <div ref={listRef} id="command-palette-list" role="listbox" className="min-h-0 flex-1 overflow-y-auto p-2">
            {flat.length === 0 && (
              <p className="px-3 py-8 text-center text-sm text-muted-foreground">Aucune commande ne correspond à « {query} ».</p>
            )}
            {sections.map((section) => (
              <div key={section.title} role="group" aria-label={section.title} className="pb-1">
                <div className="eyebrow flex items-center gap-1.5 px-3 pt-2 pb-1">
                  {section.title === "Récents" && <History className="size-3" />}
                  {section.title.toLowerCase()}
                </div>
                {section.rows.map(({ cmd, indices }) => {
                  index++;
                  const i = index;
                  const isActive = cmd.id === activeId;
                  const Icon = pending === cmd.id ? LoaderCircle : cmd.icon;
                  return (
                    <div
                      key={cmd.id}
                      id={`cmd-${cmd.id}`}
                      data-cmd={cmd.id}
                      role="option"
                      aria-selected={isActive}
                      aria-disabled={cmd.disabled}
                      onMouseMove={() => i !== active && setActive(i)}
                      onClick={() => execute(cmd)}
                      className={cn(
                        "relative flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-sm",
                        isActive ? "bg-foreground/[0.06] text-foreground" : "text-foreground/85",
                        cmd.disabled && "cursor-default opacity-50",
                      )}
                    >
                      {isActive && <span className="absolute inset-y-1.5 left-0 w-px bg-primary" />}
                      <Icon className={cn("size-4 shrink-0 stroke-[1.5]", isActive ? "text-primary" : "text-muted-foreground", pending === cmd.id && "animate-spin")} />
                      <span className="shrink-0 truncate">
                        <Highlight text={cmd.label} indices={indices} />
                      </span>
                      {cmd.detail && <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{cmd.detail}</span>}
                      {!cmd.detail && <span className="flex-1" />}
                      {cmd.badge && (
                        <span className="shrink-0 rounded border border-primary/30 bg-primary/8 px-1.5 py-px font-mono text-[10px] text-primary">
                          {cmd.badge}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>

          <div className="flex items-center gap-4 border-t px-4 py-2 text-[11px] text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <Kbd>↑</Kbd>
              <Kbd>↓</Kbd> naviguer
            </span>
            <span className="flex items-center gap-1.5">
              <Kbd>Entrée</Kbd> exécuter
            </span>
            <span className="ml-auto flex items-center gap-1.5">
              <Kbd>{PALETTE_SHORTCUT}</Kbd> ouvrir / fermer
            </span>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
