import { useEffect, useState } from "react";
import { Archive, ArchiveRestore, Loader2, PackageOpen, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { confirmAction } from "@/components/ui/confirm";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { formatRelative } from "@/lib/utils";
import { api } from "@/services/tauri";
import type { GitStatus, ProjectDetails, StashEntry } from "@/types";

/**
 * Remises Git (`git stash`) : mettre de côté les modifications en cours, puis les réappliquer
 * (en gardant la remise) ou les reprendre (appliquer puis supprimer).
 */
export function StashDialog({
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
  const [stashes, setStashes] = useState<StashEntry[] | null>(null);
  const [message, setMessage] = useState("");
  const [untracked, setUntracked] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = () => api.git.stashList(projectId).then(setStashes, (e) => setError(String(e)));

  useEffect(() => {
    if (!open) return;
    setMessage("");
    setError(null);
    setStashes(null);
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, projectId]);

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(String(e));
      // Une application en conflit a quand même modifié l'arbre de travail : statut à relire.
      api.projects.details(projectId, true).then(onChanged, () => {});
    } finally {
      setBusy(null);
      reload();
    }
  };

  const changes = git ? git.staged + git.modified + (untracked ? git.untracked : 0) : 0;
  const save = () =>
    run("push", async () => {
      onChanged(await api.git.stashPush(projectId, message.trim() || null, untracked));
      setMessage("");
    });

  const apply = (s: StashEntry, pop: boolean) =>
    run(`${pop ? "pop" : "apply"}:${s.hash}`, async () => {
      onChanged(await (pop ? api.git.stashPop(projectId, s.hash) : api.git.stashApply(projectId, s.hash)));
    });

  const drop = async (s: StashEntry) => {
    const ok = await confirmAction({
      title: "Supprimer cette remise ?",
      description: `« ${s.message} » sera définitivement perdue (stash@{${s.index}}).`,
      confirmLabel: "Supprimer",
    });
    if (ok) run(`drop:${s.hash}`, async () => setStashes(await api.git.stashDrop(projectId, s.hash)));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Remises (stash)</DialogTitle>
          <DialogDescription>
            Mettez de côté les modifications en cours pour retrouver un arbre de travail propre, puis réappliquez-les plus tard.
          </DialogDescription>
        </DialogHeader>

        <form
          className="grid gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <div className="flex gap-2">
            <Input
              autoFocus
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Message (facultatif)"
              aria-label="Message de la remise"
            />
            <Button type="submit" disabled={busy !== null || changes === 0} title={changes === 0 ? "Aucune modification à mettre de côté" : undefined}>
              {busy === "push" ? <Loader2 className="animate-spin" /> : <Archive />} Mettre de côté
            </Button>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="size-4 accent-primary" checked={untracked} onChange={(e) => setUntracked(e.target.checked)} />
            Inclure les fichiers non suivis
            {git && git.untracked > 0 && <span className="text-muted-foreground">({git.untracked})</span>}
          </label>
        </form>

        {error && <p className="text-sm whitespace-pre-line text-destructive">{error}</p>}

        <div className="max-h-80 min-w-0 overflow-y-auto rounded-lg border">
          {!stashes ? (
            <p className="flex items-center gap-2 px-3 py-3 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Lecture des remises…
            </p>
          ) : stashes.length === 0 ? (
            <p className="px-3 py-3 text-sm text-muted-foreground">Aucune remise.</p>
          ) : (
            <ul className="divide-y">
              {stashes.map((s) => (
                <li key={s.hash} className="flex min-w-0 items-center gap-2 px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm" title={s.message}>{s.message}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      <code>stash@{`{${s.index}}`}</code>
                      {s.branch && <> · {s.branch}</>} · {formatRelative(s.timestamp)}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy !== null}
                    onClick={() => apply(s, true)}
                    title="Appliquer puis supprimer la remise (git stash pop)"
                  >
                    {busy === `pop:${s.hash}` ? <Loader2 className="animate-spin" /> : <PackageOpen />} Reprendre
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="size-8"
                    disabled={busy !== null}
                    onClick={() => apply(s, false)}
                    aria-label="Appliquer"
                    title="Appliquer en gardant la remise (git stash apply)"
                  >
                    {busy === `apply:${s.hash}` ? <Loader2 className="animate-spin" /> : <ArchiveRestore />}
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="size-8 hover:text-destructive"
                    disabled={busy !== null}
                    onClick={() => drop(s)}
                    aria-label="Supprimer"
                    title="Supprimer la remise"
                  >
                    {busy === `drop:${s.hash}` ? <Loader2 className="animate-spin" /> : <Trash2 />}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
