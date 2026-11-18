import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { open } from "@tauri-apps/plugin-dialog";
import { FolderGit2, FolderPlus, Search, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { api, isTauri } from "@/services/tauri";
import { useRuns } from "@/stores/runs";
import { GitSummary, ProjectPanel } from "./ProjectPanel";
import { GithubDialog } from "./GithubDialog";
import { ScanDialog } from "./ScanDialog";
import { useProjects } from "./useProjects";

const SELECTED_KEY = "devcenter.projects.selected";

function readSelected(): number | null {
  try {
    const v = localStorage.getItem(SELECTED_KEY);
    return v ? Number(v) : null;
  } catch {
    return null;
  }
}

export function ProjectsPage() {
  if (!isTauri()) {
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-sm text-muted-foreground">
        Ce module n'est disponible que dans l'application (pnpm tauri dev).
      </div>
    );
  }
  return <ProjectsView />;
}

function ProjectsView() {
  const { projects, details, error, setError, apply, refreshOne, setOne } = useProjects();
  const runs = useRuns((s) => s.runs);
  const initRuns = useRuns((s) => s.init);
  // `?project=<id>` (lien depuis le tableau de bord) l'emporte sur la dernière sélection.
  const [params, setParams] = useSearchParams();
  const linked = Number(params.get("project")) || null;
  const [selectedId, setSelectedId] = useState<number | null>(() => linked ?? readSelected());
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (linked === null) return;
    setSelectedId(linked);
    // On retire le paramètre : la sélection vit ensuite normalement (et reste en mémoire).
    setParams((p) => {
      p.delete("project");
      return p;
    }, { replace: true });
  }, [linked, setParams]);

  useEffect(() => {
    initRuns();
  }, [initRuns]);

  useEffect(() => {
    try {
      if (selectedId !== null) localStorage.setItem(SELECTED_KEY, String(selectedId));
    } catch {
      /* stockage indisponible */
    }
  }, [selectedId]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (projects ?? []).filter((p) => {
      if (!q) return true;
      const d = details[p.id]?.meta;
      return p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q) || d?.frameworks.some((f) => f.toLowerCase().includes(q));
    });
  }, [projects, details, query]);

  const selected = projects?.find((p) => p.id === selectedId) ?? projects?.[0] ?? null;

  const addManually = async () => {
    const dir = await open({ directory: true, multiple: true, title: "Ajouter des projets" });
    const paths = Array.isArray(dir) ? dir : typeof dir === "string" ? [dir] : [];
    if (paths.length === 0) return;
    try {
      const list = await api.projects.add(paths);
      apply(list);
      const added = list.find((p) => p.path.toLowerCase() === paths[0].toLowerCase().replace(/[\\/]+$/, ""));
      if (added) setSelectedId(added.id);
    } catch (e) {
      setError(String(e));
    }
  };

  const runningByProject = (id: number) => Object.values(runs).filter((r) => r.projectId === id && r.status === "running").length;

  return (
    <div className="flex min-h-0 flex-1">
      {/* Colonne de gauche : liste des projets */}
      <aside className="flex w-72 shrink-0 flex-col border-r">
        <div className="flex items-center justify-between gap-2 px-4 pt-4 pb-3">
          <div className="min-w-0">
            <h1 className="text-base font-semibold tracking-tight">Projets</h1>
            <p className="meta">{projects ? `${projects.length} projet${projects.length > 1 ? "s" : ""}` : "…"}</p>
          </div>
          <div className="flex items-center gap-0.5">
            <GithubDialog compact />
            <ScanDialog compact onImported={apply} />
            <Button variant="ghost" size="icon" className="size-8" onClick={addManually} aria-label="Ajouter un dossier" title="Ajouter un dossier">
              <FolderPlus />
            </Button>
          </div>
        </div>
        <div className="px-3 pb-2">
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filtrer…" className="h-8 pl-8" aria-label="Filtrer les projets" />
          </div>
        </div>
        {error && <p className="px-4 pb-2 text-xs text-destructive">{error}</p>}
        <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-3" aria-label="Projets">
          {filtered.map((p) => {
            const d = details[p.id];
            const running = runningByProject(p.id);
            const active = selected?.id === p.id;
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => setSelectedId(p.id)}
                className={cn(
                  "relative grid w-full gap-0.5 px-3 py-2 text-left transition-colors",
                  active ? "bg-foreground/[0.06]" : "hover:bg-foreground/[0.03]",
                )}
              >
                {active && <span className="absolute inset-y-1.5 left-0 w-px bg-primary" />}
                <span className="flex items-center gap-2">
                  {!p.exists && <TriangleAlert className="size-3.5 shrink-0 text-warning" aria-label="Dossier introuvable" />}
                  <span className={cn("truncate text-sm", active ? "text-foreground" : "text-foreground/85")}>{p.name}</span>
                  {running > 0 && (
                    <span className="ml-auto flex shrink-0 items-center gap-1 text-xs text-success" title={`${running} script(s) en cours`}>
                      <span className="size-1.5 animate-pulse rounded-full bg-current" />
                      {running}
                    </span>
                  )}
                </span>
                <span className="flex min-w-0 items-center gap-2">
                  {d?.meta.frameworks[0] && <span className="shrink-0 text-xs text-primary">{d.meta.frameworks[0]}</span>}
                  <GitSummary git={d?.git} />
                </span>
              </button>
            );
          })}
          {filtered.length === 0 && projects && projects.length > 0 && <p className="px-3 py-2 text-sm text-muted-foreground">Aucun résultat.</p>}
        </nav>
      </aside>

      {/* Détail du projet */}
      <section className="flex min-w-0 flex-1 flex-col">
        {projects && projects.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
            <div className="flex size-12 items-center justify-center rounded-full bg-accent text-accent-foreground">
              <FolderGit2 className="size-6" />
            </div>
            <div>
              <p className="font-medium">Aucun projet</p>
              <p className="mt-1 max-w-sm text-sm text-muted-foreground">Clonez un dépôt GitHub, détectez les projets d'un dossier, ou ajoutez-en un à la main.</p>
            </div>
            <div className="flex gap-2">
              <GithubDialog />
              <ScanDialog onImported={apply} />
              <Button onClick={addManually}>
                <FolderPlus /> Ajouter
              </Button>
            </div>
          </div>
        ) : selected ? (
          <ProjectPanel
            key={selected.id}
            project={selected}
            details={details[selected.id]}
            onRefresh={() => refreshOne(selected.id)}
            onDetails={setOne}
            onRemoved={(list) => {
              apply(list);
              setSelectedId(list[0]?.id ?? null);
            }}
          />
        ) : null}
      </section>
    </div>
  );
}
