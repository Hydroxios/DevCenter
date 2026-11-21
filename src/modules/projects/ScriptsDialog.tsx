import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Loader2, Plus, Save, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { confirmAction } from "@/components/ui/confirm";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { api } from "@/services/tauri";
import type { NodeScript, ProjectDetails } from "@/types";

interface Row extends NodeScript {
  key: number;
}

let nextKey = 1;
const toRows = (scripts: NodeScript[]): Row[] => scripts.map((s) => ({ ...s, key: nextKey++ }));
const same = (a: NodeScript[], b: NodeScript[]) =>
  a.length === b.length && a.every((s, i) => s.name === b[i].name && s.command === b[i].command);

/**
 * Édition des scripts du package.json : seul le bloc `"scripts"` est réécrit,
 * le reste du fichier (ordre des clés, indentation) est conservé.
 */
export function ScriptsDialog({
  projectId,
  open,
  onOpenChange,
  onSaved,
  runningScripts,
}: {
  projectId: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: (d: ProjectDetails) => void;
  /** Scripts en cours d'exécution : leur modification ne s'applique qu'au prochain lancement. */
  runningScripts: string[];
}) {
  const [revision, setRevision] = useState<string | null>(null);
  const [initial, setInitial] = useState<NodeScript[]>([]);
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const focusKey = useRef<number | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await api.nodeScripts.read(projectId);
      setRevision(r.revision);
      setInitial(r.scripts);
      setRows(toRows(r.scripts));
    } catch (e) {
      setRevision(null);
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, projectId]);

  const current: NodeScript[] = rows.map(({ name, command }) => ({ name: name.trim(), command }));
  const dirty = !same(current, initial);

  // Erreurs par ligne, affichées sans bloquer la saisie.
  const counts = new Map<string, number>();
  for (const s of current) counts.set(s.name, (counts.get(s.name) ?? 0) + 1);
  const rowError = (s: NodeScript) =>
    !s.name ? "Nom requis" : (counts.get(s.name) ?? 0) > 1 ? "Nom en double" : !s.command.trim() ? "Commande requise" : null;
  const invalid = current.some((s) => rowError(s) !== null);

  const update = (key: number, patch: Partial<NodeScript>) =>
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const move = (i: number, delta: number) =>
    setRows((rs) => {
      const j = i + delta;
      if (j < 0 || j >= rs.length) return rs;
      const next = [...rs];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  const add = () => {
    const key = nextKey++;
    focusKey.current = key;
    setRows((rs) => [...rs, { key, name: "", command: "" }]);
  };

  const close = async () => {
    if (
      dirty &&
      !(await confirmAction({
        title: "Abandonner les modifications ?",
        description: "Les changements apportés aux scripts ne seront pas enregistrés.",
        confirmLabel: "Abandonner",
      }))
    )
      return;
    onOpenChange(false);
  };

  const save = async () => {
    if (!revision || invalid || !dirty) return;
    const renamedOrRemoved = initial.filter((s) => !current.some((c) => c.name === s.name)).map((s) => s.name);
    if (
      renamedOrRemoved.length > 0 &&
      !(await confirmAction({
        title: "Scripts renommés ou supprimés",
        description: `${renamedOrRemoved.map((n) => `« ${n} »`).join(", ")} ne ${renamedOrRemoved.length > 1 ? "seront" : "sera"} plus disponible${renamedOrRemoved.length > 1 ? "s" : ""}. Les workspaces et automatisations qui ${renamedOrRemoved.length > 1 ? "les" : "le"} lancent échoueront.`,
        confirmLabel: "Enregistrer",
      }))
    )
      return;
    setSaving(true);
    setError(null);
    try {
      const r = await api.nodeScripts.save(projectId, revision, current);
      setRevision(r.revision);
      setInitial(r.scripts);
      api.projects.details(projectId).then(onSaved, () => {});
      onOpenChange(false);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? onOpenChange(true) : close())}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Modifier les scripts</DialogTitle>
          <DialogDescription>
            Scripts du <span className="font-mono">package.json</span>. Seul le bloc « scripts » est réécrit : le reste du fichier est conservé tel quel.
          </DialogDescription>
        </DialogHeader>

        <form
          className="grid min-w-0 gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
              e.preventDefault();
              save();
            }
          }}
        >
          {loading ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Lecture du package.json…
            </p>
          ) : (
            revision && (
              <div className="max-h-[55vh] overflow-y-auto rounded-lg border">
                {rows.length === 0 && <p className="px-3 py-3 text-sm text-muted-foreground">Aucun script. Ajoutez-en un ci-dessous.</p>}
                <ul className="divide-y">
                  {rows.map((r, i) => {
                    const err = rowError(current[i]);
                    const changed = !initial.some((s) => s.name === current[i].name && s.command === current[i].command);
                    return (
                      <li key={r.key} className={cn("grid gap-1 px-3 py-2", changed && "bg-primary/[0.04]")}>
                        <div className="flex items-center gap-2">
                          <Input
                            aria-label="Nom du script"
                            className="h-8 w-44 shrink-0 font-mono"
                            value={r.name}
                            maxLength={100}
                            placeholder="nom"
                            autoFocus={focusKey.current === r.key}
                            onChange={(e) => update(r.key, { name: e.target.value })}
                          />
                          <Input
                            aria-label="Commande"
                            className="h-8 min-w-0 flex-1 font-mono"
                            value={r.command}
                            maxLength={4000}
                            placeholder="commande, ex. vite --host"
                            onChange={(e) => update(r.key, { command: e.target.value })}
                          />
                          <div className="flex shrink-0">
                            <Button type="button" variant="ghost" size="icon" className="size-8" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Monter">
                              <ArrowUp />
                            </Button>
                            <Button type="button" variant="ghost" size="icon" className="size-8" disabled={i === rows.length - 1} onClick={() => move(i, 1)} aria-label="Descendre">
                              <ArrowDown />
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="size-8 hover:text-destructive"
                              onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}
                              aria-label="Supprimer"
                            >
                              <Trash2 />
                            </Button>
                          </div>
                        </div>
                        {err && (r.name || r.command) && <p className="text-xs text-destructive">{err}</p>}
                        {!err && changed && runningScripts.includes(current[i].name) && (
                          <p className="text-xs text-muted-foreground">En cours d'exécution : la modification s'appliquera au prochain lancement.</p>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            )
          )}

          {error && <p className="text-sm whitespace-pre-line text-destructive">{error}</p>}

          <DialogFooter className="items-center sm:justify-between">
            <Button type="button" variant="outline" size="sm" onClick={add} disabled={!revision || loading}>
              <Plus /> Ajouter un script
            </Button>
            <div className="flex items-center gap-2">
              {error && !loading && (
                <Button type="button" variant="ghost" size="sm" onClick={load}>
                  Recharger
                </Button>
              )}
              <Button type="button" variant="ghost" onClick={close}>
                Annuler
              </Button>
              <Button type="submit" disabled={!revision || !dirty || invalid || saving}>
                {saving ? <Loader2 className="animate-spin" /> : <Save />} Enregistrer
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
