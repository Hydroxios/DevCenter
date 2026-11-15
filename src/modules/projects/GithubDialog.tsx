import { useCallback, useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Check, GitFork, Loader2, Lock, RefreshCw, Search } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { GithubIcon } from "@/components/GithubIcon";
import { cn, formatRelative } from "@/lib/utils";
import { api } from "@/services/tauri";
import type { CloneJob, GithubRepo, GithubStatus } from "@/types";

/** Import depuis GitHub : liste des dépôts du compte `gh`, clonage en un clic. */
export function GithubDialog({ compact = false }: { compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<GithubStatus | null>(null);
  const [repos, setRepos] = useState<GithubRepo[] | null>(null);
  const [jobs, setJobs] = useState<CloneJob[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (refresh = false) => {
    setLoading(true);
    setError(null);
    try {
      const st = await api.github.status();
      setStatus(st);
      if (st.login) setRepos(await api.github.repos(refresh));
      setJobs(await api.github.cloneJobs());
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    load();
    const unlisten = listen("projects://changed", () => load());
    return () => {
      unlisten.then((f) => f());
    };
  }, [open, load]);

  // Suivi des clonages en cours.
  const running = jobs.some((j) => j.status === "running");
  useEffect(() => {
    if (!open || !running) return;
    const t = window.setInterval(() => api.github.cloneJobs().then(setJobs).catch(() => {}), 1500);
    return () => window.clearInterval(t);
  }, [open, running]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (repos ?? []).filter(
      (r) => !q || r.fullName.toLowerCase().includes(q) || (r.description ?? "").toLowerCase().includes(q) || (r.language ?? "").toLowerCase().includes(q),
    );
  }, [repos, query]);

  const clone = async (r: GithubRepo) => {
    setError(null);
    try {
      const job = await api.github.clone(r.cloneUrl);
      setJobs((j) => [...j, job]);
    } catch (e) {
      setError(String(e));
    }
  };

  const jobFor = (r: GithubRepo) => [...jobs].reverse().find((j) => j.url.toLowerCase() === r.cloneUrl.toLowerCase());

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {compact ? (
        <Button variant="ghost" size="icon" className="size-8" onClick={() => setOpen(true)} aria-label="Importer depuis GitHub" title="Importer depuis GitHub">
          <GithubIcon />
        </Button>
      ) : (
        <Button variant="outline" onClick={() => setOpen(true)}>
          <GithubIcon /> GitHub
        </Button>
      )}
      <DialogContent className="max-h-[88vh] max-w-2xl grid-rows-[auto_auto_minmax(0,1fr)] overflow-hidden">
        <DialogHeader>
          <DialogTitle>Importer depuis GitHub</DialogTitle>
          <DialogDescription>
            {status?.login ? (
              <>
                Compte <b className="text-foreground">{status.login}</b> · {repos ? `${repos.length} dépôts` : "chargement…"}. Le clonage se fait dans votre dossier de projets.
              </>
            ) : status && !status.installed ? (
              "GitHub CLI (gh) n'est pas installé sur ce PC."
            ) : status ? (
              "Aucun compte connecté : connectez-vous dans Paramètres › GitHub."
            ) : (
              "Chargement…"
            )}
          </DialogDescription>
        </DialogHeader>

        {status?.login && (
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Nom, description, langage…" className="pl-8" aria-label="Rechercher un dépôt" />
            </div>
            <Button variant="ghost" size="icon" onClick={() => load(true)} disabled={loading} aria-label="Actualiser" title="Actualiser">
              <RefreshCw className={cn(loading && "animate-spin")} />
            </Button>
          </div>
        )}

        <div className="min-h-0 overflow-y-auto">
          {error && <p className="mb-2 text-sm text-destructive">{error}</p>}
          {status?.login && !repos && <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Lecture des dépôts…</p>}
          {repos && (
            <ul className="divide-y rounded-lg border">
              {filtered.map((r) => {
                const job = jobFor(r);
                const imported = r.projectId !== null || job?.status === "done";
                return (
                  <li key={r.fullName} className="flex items-center gap-3 px-3 py-2.5">
                    <div className="min-w-0 flex-1">
                      <p className="flex items-center gap-2 text-sm">
                        <span className="truncate font-medium">
                          <span className="text-muted-foreground">{r.owner}/</span>
                          {r.name}
                        </span>
                        {r.private && <Lock className="size-3 shrink-0 text-muted-foreground" aria-label="Privé" />}
                        {r.fork && <GitFork className="size-3 shrink-0 text-muted-foreground" aria-label="Fork" />}
                        {r.archived && <Badge variant="outline">archivé</Badge>}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">
                        {[r.language, r.pushedAt ? `modifié ${formatRelative(Date.parse(r.pushedAt) / 1000)}` : null, r.description].filter(Boolean).join(" · ")}
                      </p>
                      {job?.status === "failed" && <p className="text-xs text-destructive">{job.error}</p>}
                    </div>
                    {imported ? (
                      <Badge variant="success">
                        <Check /> Importé
                      </Badge>
                    ) : job?.status === "running" ? (
                      <Badge variant="primary">
                        <Loader2 className="animate-spin" /> Clonage…
                      </Badge>
                    ) : (
                      <Button size="sm" variant="secondary" onClick={() => clone(r)}>
                        Cloner
                      </Button>
                    )}
                  </li>
                );
              })}
              {filtered.length === 0 && <li className="px-3 py-6 text-center text-sm text-muted-foreground">Aucun dépôt.</li>}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
