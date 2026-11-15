import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, Check, Cloud, GitBranch, GitBranchPlus, Loader2, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { cn, formatRelative } from "@/lib/utils";
import { api } from "@/services/tauri";
import type { GitBranch as Branch, GitStatus, ProjectDetails } from "@/types";

/** Nom local qu'aurait une branche distante (`origin/feature/x` → `feature/x`). */
const localName = (remote: string) => remote.slice(remote.indexOf("/") + 1);

function BranchRow({ branch, busy, disabled, onPick }: { branch: Branch; busy: boolean; disabled: boolean; onPick: () => void }) {
  return (
    <li>
      <button
        type="button"
        disabled={disabled || branch.current}
        onClick={onPick}
        className={cn(
          "flex w-full min-w-0 items-center gap-2.5 px-3 py-2 text-left transition-colors",
          branch.current ? "bg-primary/8" : "hover:bg-primary/8 disabled:opacity-50",
        )}
        title={branch.current ? "Branche courante" : branch.remote ? `Créer la branche locale ${localName(branch.name)} qui suit ${branch.name}` : `Basculer sur ${branch.name}`}
      >
        <span className="flex size-4 shrink-0 items-center justify-center text-primary">
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : branch.current ? <Check className="size-4" /> : branch.remote ? <Cloud className="size-3.5 text-muted-foreground" /> : <GitBranch className="size-3.5 text-muted-foreground" />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-baseline gap-2">
            <span className={cn("truncate font-mono text-sm", branch.current && "text-primary")}>{branch.name}</span>
            {branch.upstream && <span className="shrink-0 truncate text-xs text-muted-foreground">→ {branch.upstream}</span>}
          </span>
          <span className="block truncate text-xs text-muted-foreground">{branch.subject}</span>
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">{formatRelative(branch.timestamp)}</span>
      </button>
    </li>
  );
}

export function BranchDialog({
  projectId,
  git,
  open,
  onOpenChange,
  onChanged,
}: {
  projectId: number;
  git: GitStatus | null | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChanged: (d: ProjectDetails) => void;
}) {
  const [branches, setBranches] = useState<Branch[] | null>(null);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Formulaire de création
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [from, setFrom] = useState("");
  const [switchTo, setSwitchTo] = useState(true);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setError(null);
    setCreating(false);
    setBranches(null);
    api.git.branches(projectId).then(setBranches, (e) => setError(String(e)));
  }, [open, projectId]);

  const current = branches?.find((b) => b.current);
  const q = query.trim().toLowerCase();
  const { locals, remotes } = useMemo(() => {
    const all = branches ?? [];
    const localNames = new Set(all.filter((b) => !b.remote).map((b) => b.name));
    const match = (b: Branch) => !q || b.name.toLowerCase().includes(q);
    return {
      // Branche courante en tête, puis par date du dernier commit (ordre du backend).
      locals: all.filter((b) => !b.remote && match(b)).sort((a, b) => Number(b.current) - Number(a.current)),
      // Distantes déjà présentes en local : inutile de les proposer une seconde fois.
      remotes: all.filter((b) => b.remote && !localNames.has(localName(b.name)) && match(b)),
    };
  }, [branches, q]);
  const exact = branches?.some((b) => b.name.toLowerCase() === q || (b.remote && localName(b.name).toLowerCase() === q));

  const run = async (key: string, fn: () => Promise<ProjectDetails>) => {
    setBusy(key);
    setError(null);
    try {
      onChanged(await fn());
      onOpenChange(false);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const pick = (b: Branch) => run(b.name, () => api.git.checkout(projectId, b.name, b.remote));

  const startCreate = (name: string) => {
    setNewName(name);
    setFrom(current?.name ?? "");
    setSwitchTo(true);
    setError(null);
    setCreating(true);
  };

  const create = () => {
    const name = newName.trim();
    if (!name) return;
    run("create", () => api.git.createBranch(projectId, name, from || null, switchTo));
  };

  const changes = git ? git.staged + git.modified + git.conflicts : 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {creating && (
              <button type="button" onClick={() => setCreating(false)} className="-ml-1 rounded-md p-1 text-muted-foreground hover:bg-primary/10 hover:text-primary" aria-label="Retour">
                <ArrowLeft className="size-4" />
              </button>
            )}
            {creating ? "Nouvelle branche" : "Branches"}
          </DialogTitle>
          <DialogDescription>
            {creating
              ? "La branche part du commit choisi."
              : changes > 0
                ? `${changes} modification${changes > 1 ? "s" : ""} locale${changes > 1 ? "s" : ""} : elles suivent le changement de branche, sauf en cas de conflit (Git refuse alors de basculer).`
                : "Cliquez sur une branche pour basculer dessus."}
          </DialogDescription>
        </DialogHeader>

        {creating ? (
          <form
            className="grid gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              create();
            }}
          >
            <label className="grid gap-1.5 text-sm">
              <span className="text-muted-foreground">Nom</span>
              <Input autoFocus className="font-mono" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="feature/ma-branche" spellCheck={false} />
            </label>
            <label className="grid gap-1.5 text-sm">
              <span className="text-muted-foreground">Depuis</span>
              <Select value={from} onChange={(e) => setFrom(e.target.value)}>
                {!current && <option value="">HEAD (commit courant)</option>}
                {(branches ?? []).map((b) => (
                  <option key={b.name} value={b.name}>
                    {b.name}
                    {b.current ? " (courante)" : ""}
                  </option>
                ))}
              </Select>
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" className="size-4 accent-primary" checked={switchTo} onChange={(e) => setSwitchTo(e.target.checked)} />
              Basculer sur la nouvelle branche
            </label>
            {error && <p className="text-sm whitespace-pre-line text-destructive">{error}</p>}
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setCreating(false)}>Annuler</Button>
              <Button type="submit" disabled={!newName.trim() || busy !== null}>
                {busy === "create" ? <Loader2 className="animate-spin" /> : <GitBranchPlus />} Créer
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <div className="grid min-w-0 gap-3">
            <div className="flex gap-2">
              <Input
                autoFocus
                className="font-mono"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== "Enter" || busy) return;
                  const first = locals.find((b) => !b.current) ?? remotes[0];
                  if (first) pick(first);
                  else if (q && !exact) startCreate(query.trim());
                }}
                placeholder="Rechercher une branche…"
                spellCheck={false}
              />
              <Button variant="outline" onClick={() => startCreate(exact ? "" : query.trim())} title="Créer une branche">
                <Plus /> Nouvelle
              </Button>
            </div>

            {error && <p className="text-sm whitespace-pre-line text-destructive">{error}</p>}

            <div className="max-h-80 min-w-0 overflow-y-auto rounded-lg border">
              {!branches ? (
                <p className="flex items-center gap-2 px-3 py-3 text-sm text-muted-foreground">
                  {!error && <><Loader2 className="size-4 animate-spin" /> Lecture des branches…</>}
                </p>
              ) : (
                <>
                  {q && !exact && (
                    <button
                      type="button"
                      onClick={() => startCreate(query.trim())}
                      className="flex w-full items-center gap-2.5 border-b px-3 py-2 text-left text-sm text-primary hover:bg-primary/8"
                    >
                      <GitBranchPlus className="size-4" /> Créer la branche <span className="truncate font-mono">{query.trim()}</span>
                    </button>
                  )}
                  {locals.length > 0 && (
                    <>
                      <div className="eyebrow border-b bg-foreground/[0.02] px-3 py-1.5">Locales</div>
                      <ul className="divide-y">
                        {locals.map((b) => (
                          <BranchRow key={b.name} branch={b} busy={busy === b.name} disabled={busy !== null} onPick={() => pick(b)} />
                        ))}
                      </ul>
                    </>
                  )}
                  {remotes.length > 0 && (
                    <>
                      <div className={cn("eyebrow border-b bg-foreground/[0.02] px-3 py-1.5", locals.length > 0 && "border-t")}>Distantes</div>
                      <ul className="divide-y">
                        {remotes.map((b) => (
                          <BranchRow key={b.name} branch={b} busy={busy === b.name} disabled={busy !== null} onPick={() => pick(b)} />
                        ))}
                      </ul>
                    </>
                  )}
                  {locals.length === 0 && remotes.length === 0 && !q && (
                    <p className="px-3 py-3 text-sm text-muted-foreground">Aucune branche : le dépôt n'a pas encore de commit.</p>
                  )}
                </>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
