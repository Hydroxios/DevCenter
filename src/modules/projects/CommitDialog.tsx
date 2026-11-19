import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, GitCommitHorizontal, Loader2, Minus, Plus, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { api } from "@/services/tauri";
import type { ChangedFile, ProjectDetails } from "@/types";
import { DiffView } from "./GitHistory";

/** Message en cours de rédaction par projet (conservé si la fenêtre est refermée). */
const drafts = new Map<number, string>();

const STATE_LABEL: Record<string, string> = {
  M: "Modifié",
  A: "Ajouté",
  D: "Supprimé",
  R: "Renommé",
  C: "Copié",
  T: "Type modifié",
  "?": "Nouveau fichier",
  U: "En conflit",
};
const STATE_COLOR: Record<string, string> = {
  M: "text-warning",
  A: "text-success",
  "?": "text-success",
  D: "text-destructive",
  U: "text-destructive",
  R: "text-primary",
  C: "text-primary",
};

type Selection = { path: string; staged: boolean };

function FileItem({
  file,
  state,
  staged,
  selected,
  busy,
  onSelect,
  onToggle,
}: {
  file: ChangedFile;
  state: string;
  staged: boolean;
  selected: boolean;
  busy: boolean;
  onSelect: () => void;
  onToggle: () => void;
}) {
  const slash = file.path.lastIndexOf("/");
  const name = file.path.slice(slash + 1);
  const folder = slash >= 0 ? file.path.slice(0, slash) : "";
  return (
    <li
      className={cn(
        "group flex min-w-0 cursor-pointer items-center gap-2 py-1 pr-1 pl-3 text-sm transition-colors",
        selected ? "bg-primary/10" : "hover:bg-foreground/[0.04]",
      )}
      onClick={onSelect}
      title={file.origPath ? `${file.origPath} → ${file.path}` : file.path}
    >
      <span className="min-w-0 flex-1 truncate">
        <span className={cn(selected && "text-primary", state === "D" && "line-through opacity-70")}>{name}</span>
        {folder && <span className="ml-1.5 text-xs text-muted-foreground">{folder}</span>}
      </span>
      <button
        type="button"
        disabled={busy}
        onClick={(e) => {
          e.stopPropagation();
          onToggle();
        }}
        className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition group-hover:opacity-100 hover:bg-primary/10 hover:text-primary focus-visible:opacity-100 disabled:opacity-40"
        aria-label={staged ? "Retirer de l'index" : "Indexer"}
        title={staged ? "Retirer de l'index" : "Indexer"}
      >
        {staged ? <Minus className="size-3.5" /> : <Plus className="size-3.5" />}
      </button>
      <span className={cn("w-4 shrink-0 text-center font-mono text-xs font-semibold", STATE_COLOR[state])} title={STATE_LABEL[state]}>
        {state === "?" ? "U" : state === "U" ? "!" : state}
      </span>
    </li>
  );
}

function Section({
  title,
  files,
  staged,
  selection,
  busy,
  actionLabel,
  onAction,
  onSelect,
  onToggle,
}: {
  title: string;
  files: ChangedFile[];
  staged: boolean;
  selection: Selection | null;
  busy: boolean;
  actionLabel: string;
  onAction: () => void;
  onSelect: (f: ChangedFile) => void;
  onToggle: (f: ChangedFile) => void;
}) {
  if (files.length === 0) return null;
  return (
    <div>
      <div className="eyebrow sticky top-0 z-10 flex items-center justify-between border-b bg-card px-3 py-1.5">
        <span>
          {title} <span className="tabular-nums">({files.length})</span>
        </span>
        <button type="button" disabled={busy} onClick={onAction} className="normal-case tracking-normal text-primary hover:underline disabled:opacity-50">
          {actionLabel}
        </button>
      </div>
      <ul className="py-1">
        {files.map((f) => (
          <FileItem
            key={f.path}
            file={f}
            state={(staged ? f.staged : f.unstaged) ?? "M"}
            staged={staged}
            selected={selection?.path === f.path && selection.staged === staged}
            busy={busy}
            onSelect={() => onSelect(f)}
            onToggle={() => onToggle(f)}
          />
        ))}
      </ul>
    </div>
  );
}

export function CommitDialog({
  projectId,
  canPush,
  open,
  onOpenChange,
  onCommitted,
  onPushError,
}: {
  projectId: number;
  /** Faux en HEAD détachée. */
  canPush: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCommitted: (d: ProjectDetails) => void;
  onPushError: (message: string) => void;
}) {
  const [files, setFiles] = useState<ChangedFile[] | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [diff, setDiff] = useState<{ key: string; text: string } | null>(null);
  const [message, setMessageState] = useState("");
  const [busy, setBusy] = useState(false);
  /** Action en cours : commit seul ou commit suivi d'un push. */
  const [committing, setCommitting] = useState<"commit" | "push" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);

  const setMessage = (m: string) => {
    drafts.set(projectId, m);
    setMessageState(m);
  };

  const load = () => {
    setError(null);
    api.git.changes(projectId).then(setFiles, (e) => setError(String(e)));
  };

  useEffect(() => {
    if (!open) return;
    setFiles(null);
    setSelection(null);
    setDiff(null);
    setMessageState(drafts.get(projectId) ?? "");
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, projectId]);

  const staged = useMemo(() => (files ?? []).filter((f) => f.staged), [files]);
  const unstaged = useMemo(() => (files ?? []).filter((f) => f.unstaged), [files]);
  const conflicts = (files ?? []).filter((f) => f.conflict).length;

  // Sélection par défaut, et suivi d'un fichier qui passe d'une liste à l'autre.
  useEffect(() => {
    if (!files) return;
    const inList = (s: Selection) => (s.staged ? staged : unstaged).some((f) => f.path === s.path);
    if (selection && inList(selection)) return;
    if (selection && inList({ path: selection.path, staged: !selection.staged })) {
      setSelection({ path: selection.path, staged: !selection.staged });
      return;
    }
    const first = staged[0] ?? unstaged[0];
    setSelection(first ? { path: first.path, staged: staged.length > 0 } : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files]);

  // Diff du fichier sélectionné, relu quand la liste change (indexation partielle depuis l'éditeur…).
  const diffKey = selection ? `${selection.staged ? "i" : "w"}:${selection.path}` : null;
  useEffect(() => {
    if (!selection || !diffKey) return;
    let cancelled = false;
    api.git.fileDiff(projectId, selection.path, selection.staged).then(
      (text) => !cancelled && setDiff({ key: diffKey, text }),
      (e) => !cancelled && setDiff({ key: diffKey, text: String(e) }),
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [diffKey, files, projectId]);

  const toggle = async (paths: string[], stage: boolean) => {
    if (paths.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      setFiles(await api.git.stage(projectId, paths, stage));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const all = staged.length === 0;
  const canCommit = !!files && files.length > 0 && message.trim().length > 0 && !busy && !committing;

  const commit = async (andPush: boolean) => {
    if (!canCommit) return;
    setCommitting(andPush ? "push" : "commit");
    setError(null);
    let details: ProjectDetails;
    try {
      details = await api.git.createCommit(projectId, message, all);
    } catch (e) {
      setError(String(e));
      load();
      setCommitting(null);
      return;
    }
    drafts.delete(projectId);
    setMessageState("");
    onCommitted(details);
    if (andPush) {
      // Le commit est fait : un échec du push est signalé dans le panneau du projet.
      try {
        onCommitted(await api.git.push(projectId));
      } catch (e) {
        onPushError(String(e));
      }
    }
    setCommitting(null);
    onOpenChange(false);
  };

  const total = files?.length ?? 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex h-[min(46rem,calc(100vh-4rem))] max-w-6xl flex-col"
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          textRef.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            Commit
            <button
              type="button"
              onClick={load}
              className="rounded-md p-1 text-muted-foreground hover:bg-primary/10 hover:text-primary"
              aria-label="Relire les modifications"
              title="Relire les modifications"
            >
              <RefreshCw className="size-3.5" />
            </button>
          </DialogTitle>
          <DialogDescription>
            {!files
              ? "Lecture des modifications…"
              : total === 0
                ? "Aucune modification à committer."
                : all
                  ? "Rien n'est indexé : toutes les modifications seront committées."
                  : `${staged.length} fichier${staged.length > 1 ? "s" : ""} indexé${staged.length > 1 ? "s" : ""} : seuls ceux-ci seront committés.`}
          </DialogDescription>
        </DialogHeader>

        <div className="grid min-h-0 flex-1 grid-cols-[minmax(16rem,22rem)_1fr] overflow-hidden rounded-lg border">
          <div className="min-h-0 overflow-y-auto border-r">
            {!files ? (
              <p className="flex items-center gap-2 px-3 py-3 text-sm text-muted-foreground">
                {!error && <><Loader2 className="size-4 animate-spin" /> Lecture…</>}
              </p>
            ) : total === 0 ? (
              <p className="px-3 py-3 text-sm text-muted-foreground">L'arbre de travail est propre.</p>
            ) : (
              <>
                <Section
                  title="Indexés"
                  files={staged}
                  staged
                  selection={selection}
                  busy={busy}
                  actionLabel="Tout retirer"
                  onAction={() => toggle(staged.map((f) => f.path), false)}
                  onSelect={(f) => setSelection({ path: f.path, staged: true })}
                  onToggle={(f) => toggle([f.path], false)}
                />
                <Section
                  title="Modifications"
                  files={unstaged}
                  staged={false}
                  selection={selection}
                  busy={busy}
                  actionLabel="Tout indexer"
                  onAction={() => toggle(unstaged.map((f) => f.path), true)}
                  onSelect={(f) => setSelection({ path: f.path, staged: false })}
                  onToggle={(f) => toggle([f.path], true)}
                />
              </>
            )}
          </div>
          <div className="min-h-0 min-w-0 overflow-auto bg-black">
            {!selection ? null : diff?.key !== diffKey ? (
              <p className="flex items-center gap-2 px-3 py-3 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" /> Chargement du diff…
              </p>
            ) : diff.text.trim() ? (
              <DiffView patch={diff.text} />
            ) : (
              <p className="px-3 py-3 text-sm text-muted-foreground">Pas de différence textuelle à afficher.</p>
            )}
          </div>
        </div>

        {conflicts > 0 && (
          <p className="text-sm text-destructive">
            {conflicts} fichier{conflicts > 1 ? "s" : ""} en conflit : résolvez-les puis indexez-les avant de committer.
          </p>
        )}
        {error && <p className="max-h-32 overflow-y-auto text-sm whitespace-pre-line text-destructive select-text">{error}</p>}

        <form
          className="grid gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            commit(false);
          }}
        >
          <textarea
            ref={textRef}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                commit(e.shiftKey && canPush);
              }
            }}
            rows={3}
            spellCheck={false}
            placeholder={"Message du commit\n\nDescription (facultative)"}
            className="w-full resize-none rounded-lg border border-input bg-card px-3 py-2 font-mono text-sm text-foreground outline-none transition placeholder:text-muted-foreground/70 hover:border-foreground/20 focus:border-primary focus:ring-2 focus:ring-primary/15"
          />
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-muted-foreground">
              Ctrl + Entrée pour committer{canPush && ", Ctrl + Maj + Entrée pour committer et pousser"}
            </span>
            <div className="flex gap-2">
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                Annuler
              </Button>
              {canPush && (
                <Button type="button" variant="outline" disabled={!canCommit} onClick={() => commit(true)}>
                  {committing === "push" ? <Loader2 className="animate-spin" /> : <ArrowUp />}
                  {committing === "push" ? "Envoi…" : "Committer et pousser"}
                </Button>
              )}
              <Button type="submit" disabled={!canCommit}>
                {committing === "commit" ? <Loader2 className="animate-spin" /> : <GitCommitHorizontal />}
                {all && total > 0 ? "Tout committer" : "Committer"}
              </Button>
            </div>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
