import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, Plus, Star, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { api } from "@/services/tauri";
import { useWorkspaces } from "@/stores/workspaces";
import type { ProjectScript, Workspace, WorkspaceStep } from "@/types";
import { STEP_KINDS, defaultStep, stepIcon } from "./steps";

/** Scripts d'un projet, chargés à la demande et mis en cache le temps de l'édition. */
function useProjectScripts() {
  const [cache, setCache] = useState<Record<number, ProjectScript[] | "loading">>({});
  const get = (projectId: number) => {
    const v = cache[projectId];
    if (v === undefined && projectId) {
      setCache((c) => ({ ...c, [projectId]: "loading" }));
      api.projects
        .details(projectId)
        .then((d) => setCache((c) => ({ ...c, [projectId]: d.meta.scripts })))
        .catch(() => setCache((c) => ({ ...c, [projectId]: [] })));
    }
    return v === "loading" || v === undefined ? null : v;
  };
  return get;
}

function Checkbox({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="flex items-center gap-2 text-sm text-muted-foreground">
      <input type="checkbox" className="accent-[var(--primary)]" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

function StepFields({
  step,
  onChange,
  scriptsOf,
}: {
  step: WorkspaceStep;
  onChange: (s: WorkspaceStep) => void;
  scriptsOf: (projectId: number) => ProjectScript[] | null;
}) {
  const { projects, apps } = useWorkspaces();

  const projectSelect = (projectId: number, set: (id: number) => void) => (
    <Select value={projectId} onChange={(e) => set(Number(e.target.value))} aria-label="Projet" className="min-w-0 flex-1">
      {projects.length === 0 && <option value={0}>Aucun projet : ajoutez-en dans Projets</option>}
      {projects.map((p) => (
        <option key={p.id} value={p.id}>{p.name}</option>
      ))}
    </Select>
  );

  switch (step.kind) {
    case "editor":
    case "folder":
      return projectSelect(step.projectId, (projectId) => onChange({ ...step, projectId }));

    case "script": {
      const scripts = scriptsOf(step.projectId);
      const known = scripts?.some((s) => s.name === step.script);
      return (
        <div className="grid min-w-0 flex-1 gap-2">
          <div className="flex gap-2">
            {projectSelect(step.projectId, (projectId) => {
              const next = scriptsOf(projectId);
              const script = next?.find((s) => s.name === step.script)?.name ?? next?.find((s) => s.name === "dev")?.name ?? next?.[0]?.name ?? step.script;
              onChange({ ...step, projectId, script });
            })}
            <Select value={step.script} onChange={(e) => onChange({ ...step, script: e.target.value })} aria-label="Script" className="w-40">
              {scripts === null && <option value={step.script}>{step.script}</option>}
              {scripts && !known && <option value={step.script}>{step.script} (absent)</option>}
              {scripts?.map((s) => (
                <option key={s.name} value={s.name}>{s.name}</option>
              ))}
            </Select>
          </div>
          <Checkbox
            label="Ouvrir le navigateur quand le serveur est prêt"
            checked={step.openBrowser}
            onChange={(openBrowser) => onChange({ ...step, openBrowser })}
          />
        </div>
      );
    }

    case "app":
      return (
        <div className="grid min-w-0 flex-1 gap-2">
          <Select value={step.appId} onChange={(e) => onChange({ ...step, appId: Number(e.target.value) })} aria-label="Application">
            {apps.length === 0 && <option value={0}>Aucune application : ajoutez-en dans Système</option>}
            {apps.map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </Select>
          <Checkbox
            label="Fermer à l'arrêt de la session (.exe uniquement)"
            checked={step.closeOnStop}
            onChange={(closeOnStop) => onChange({ ...step, closeOnStop })}
          />
        </div>
      );

    case "url":
      return (
        <Input
          value={step.url}
          onChange={(e) => onChange({ ...step, url: e.target.value })}
          placeholder="http://localhost:3000"
          aria-label="URL"
          className="min-w-0 flex-1"
        />
      );
  }
}

export function WorkspaceEditor({
  workspace,
  open,
  onOpenChange,
}: {
  /** null = création. */
  workspace: Workspace | null;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const { projects, apps, save, error, clearError, refreshRefs } = useWorkspaces();
  const scriptsOf = useProjectScripts();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [favorite, setFavorite] = useState(false);
  const [steps, setSteps] = useState<WorkspaceStep[]>([]);

  useEffect(() => {
    if (!open) return;
    refreshRefs();
    clearError();
    setName(workspace?.name ?? "");
    setDescription(workspace?.description ?? "");
    setFavorite(workspace?.favorite ?? false);
    setSteps(workspace?.steps ?? []);
  }, [open, workspace, refreshRefs, clearError]);

  const update = (i: number, s: WorkspaceStep) => setSteps((prev) => prev.map((p, j) => (j === i ? s : p)));
  const move = (i: number, d: -1 | 1) =>
    setSteps((prev) => {
      const next = [...prev];
      [next[i], next[i + d]] = [next[i + d], next[i]];
      return next;
    });

  const submit = async () => {
    if (await save({ id: workspace?.id ?? null, name, description, favorite, steps })) onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-2xl grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden">
        <DialogHeader>
          <DialogTitle>{workspace ? "Modifier le workspace" : "Nouveau workspace"}</DialogTitle>
          <DialogDescription>Les étapes s'exécutent dans l'ordre au démarrage. « Arrêter » coupe les scripts lancés.</DialogDescription>
        </DialogHeader>

        <div className="grid min-h-0 gap-4 overflow-y-auto pr-1">
          <div className="flex gap-2">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nom (ex. Front DevCenter)" aria-label="Nom" maxLength={80} />
            <Button
              type="button"
              variant="outline"
              size="icon"
              onClick={() => setFavorite((f) => !f)}
              aria-pressed={favorite}
              aria-label="Favori"
              title={favorite ? "Retirer des favoris" : "Ajouter aux favoris"}
            >
              <Star className={cn(favorite && "fill-warning text-warning")} />
            </Button>
          </div>
          <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Description (optionnelle)" aria-label="Description" maxLength={300} />

          <div className="grid gap-2">
            <p className="text-sm font-medium">Étapes</p>
            {steps.length === 0 && (
              <p className="rounded-lg border border-dashed px-3 py-4 text-center text-sm text-muted-foreground">
                Ajoutez une première étape ci-dessous.
              </p>
            )}
            <ol className="grid gap-2">
              {steps.map((step, i) => {
                const Icon = stepIcon(step.kind);
                return (
                  <li key={i} className="flex items-start gap-2 rounded-lg border p-2">
                    <span className="mt-2 flex w-14 shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                      <span className="tabular-nums">{i + 1}.</span>
                      <Icon className="size-4" />
                    </span>
                    <StepFields step={step} onChange={(s) => update(i, s)} scriptsOf={scriptsOf} />
                    <div className="flex shrink-0">
                      <Button variant="ghost" size="icon" className="size-9" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Monter">
                        <ArrowUp />
                      </Button>
                      <Button variant="ghost" size="icon" className="size-9" disabled={i === steps.length - 1} onClick={() => move(i, 1)} aria-label="Descendre">
                        <ArrowDown />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-9 hover:text-destructive"
                        onClick={() => setSteps((prev) => prev.filter((_, j) => j !== i))}
                        aria-label="Supprimer l'étape"
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ol>
            <div className="flex flex-wrap gap-2">
              {STEP_KINDS.map(({ kind, label }) => (
                <Button key={kind} variant="secondary" size="sm" onClick={() => setSteps((prev) => [...prev, defaultStep(kind, projects, apps)])}>
                  <Plus /> {label}
                </Button>
              ))}
            </div>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Annuler</Button>
          <Button onClick={submit} disabled={!name.trim() || steps.length === 0}>Enregistrer</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
