import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, Trash2 } from "lucide-react";

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
import type { AutomationCondition, AutomationInput, AutomationStep, AutomationTrigger, HttpMethod } from "@/types";
import { CONDITION_KINDS, DAYS, STEP_KINDS, defaultCondition, defaultStep, snippetsFor, stepIcon, type Refs } from "./model";

function Num({ value, onChange, min, max, className, label }: { value: number; onChange: (n: number) => void; min: number; max: number; className?: string; label: string }) {
  return (
    <Input
      type="number"
      aria-label={label}
      className={cn("w-24", className)}
      value={value}
      min={min}
      max={max}
      onChange={(e) => onChange(Math.min(max, Math.max(min, Number(e.target.value) || min)))}
    />
  );
}

function RefSelect({ items, value, onChange, empty, label }: { items: { id: number; name: string }[]; value: number; onChange: (id: number) => void; empty: string; label: string }) {
  return (
    <Select value={value} onChange={(e) => onChange(Number(e.target.value))} aria-label={label} className="min-w-0 flex-1">
      {items.length === 0 && <option value={0}>{empty}</option>}
      {items.map((i) => (
        <option key={i.id} value={i.id}>{i.name}</option>
      ))}
    </Select>
  );
}

function TriggerEditor({ trigger, onChange }: { trigger: AutomationTrigger; onChange: (t: AutomationTrigger) => void }) {
  return (
    <div className="grid gap-2">
      <Select
        value={trigger.kind}
        aria-label="Déclencheur"
        onChange={(e) => {
          const kind = e.target.value as AutomationTrigger["kind"];
          onChange(
            kind === "interval"
              ? { kind, minutes: 15 }
              : kind === "daily"
                ? { kind, time: "09:00", days: [0, 1, 2, 3, 4] }
                : { kind },
          );
        }}
      >
        <option value="manual">Manuel (bouton « Exécuter »)</option>
        <option value="interval">Toutes les N minutes</option>
        <option value="daily">Chaque jour à une heure fixe</option>
        <option value="appStart">Au démarrage de DevCenter</option>
      </Select>
      {trigger.kind === "interval" && (
        <label className="flex items-center gap-2 text-sm">
          Toutes les <Num label="Minutes" value={trigger.minutes} min={1} max={1440} onChange={(minutes) => onChange({ ...trigger, minutes })} /> minutes
        </label>
      )}
      {trigger.kind === "daily" && (
        <div className="flex flex-wrap items-center gap-2">
          <Input type="time" aria-label="Heure" className="w-32" value={trigger.time} onChange={(e) => onChange({ ...trigger, time: e.target.value })} />
          <div className="flex gap-1">
            {DAYS.map((d, i) => {
              const on = trigger.days.length === 0 || trigger.days.includes(i);
              return (
                <button
                  key={d}
                  type="button"
                  aria-pressed={on}
                  onClick={() => {
                    const current = trigger.days.length === 0 ? [0, 1, 2, 3, 4, 5, 6] : trigger.days;
                    const days = on ? current.filter((x) => x !== i) : [...current, i].sort();
                    onChange({ ...trigger, days: days.length === 7 ? [] : days });
                  }}
                  className={cn("h-8 w-10 rounded-md border text-xs", on ? "border-primary bg-primary/12 text-primary" : "text-muted-foreground")}
                >
                  {d}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function ConditionEditor({ condition, onChange, refs }: { condition: AutomationCondition; onChange: (c: AutomationCondition) => void; refs: Refs }) {
  const option = (c: AutomationCondition) => `${c.kind}:${c.negate}`;
  return (
    <div className="grid min-w-0 flex-1 gap-2">
      <Select
        aria-label="Condition"
        value={option(condition)}
        onChange={(e) => {
          const [kind, neg] = e.target.value.split(":") as [AutomationCondition["kind"], string];
          const next = kind === condition.kind ? condition : defaultCondition(kind, refs);
          onChange({ ...next, negate: neg === "true" } as AutomationCondition);
        }}
      >
        {CONDITION_KINDS.flatMap((c) => [
          <option key={`${c.kind}:false`} value={`${c.kind}:false`}>{c.label}</option>,
          <option key={`${c.kind}:true`} value={`${c.kind}:true`}>{c.negLabel}</option>,
        ])}
      </Select>
      <div className="flex flex-wrap items-center gap-2">
        {condition.kind === "processRunning" && (
          <Input aria-label="Processus" value={condition.name} onChange={(e) => onChange({ ...condition, name: e.target.value })} placeholder="Docker Desktop.exe" />
        )}
        {condition.kind === "serverReachable" && (
          <RefSelect label="Serveur" items={refs.servers} value={condition.serverId} onChange={(serverId) => onChange({ ...condition, serverId })} empty="Aucun serveur" />
        )}
        {condition.kind === "workspaceActive" && (
          <RefSelect label="Workspace" items={refs.workspaces} value={condition.workspaceId} onChange={(workspaceId) => onChange({ ...condition, workspaceId })} empty="Aucun workspace" />
        )}
        {condition.kind === "portOpen" && (
          <>
            <Input aria-label="Hôte" className="min-w-0 flex-1" value={condition.host} onChange={(e) => onChange({ ...condition, host: e.target.value })} />
            <Num label="Port" value={condition.port} min={1} max={65535} onChange={(port) => onChange({ ...condition, port })} />
          </>
        )}
        {(condition.kind === "cpuAbove" || condition.kind === "memoryAbove") && (
          <label className="flex items-center gap-2 text-sm">
            <Num label="Pourcentage" value={condition.percent} min={0} max={100} onChange={(percent) => onChange({ ...condition, percent })} /> %
          </label>
        )}
        {condition.kind === "timeBetween" && (
          <>
            <Input type="time" aria-label="Début" className="w-32" value={condition.start} onChange={(e) => onChange({ ...condition, start: e.target.value })} />
            <span className="text-sm text-muted-foreground">et</span>
            <Input type="time" aria-label="Fin" className="w-32" value={condition.end} onChange={(e) => onChange({ ...condition, end: e.target.value })} />
          </>
        )}
      </div>
      <p className="text-xs text-muted-foreground">Sinon, le workflow s'arrête ici (sans erreur).</p>
    </div>
  );
}

const HTTP_METHODS: HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"];

function HttpFields({ step, onChange }: { step: Extract<AutomationStep, { kind: "httpRequest" }>; onChange: (s: AutomationStep) => void }) {
  const withBody = step.method !== "GET" && step.method !== "HEAD";
  const [advanced, setAdvanced] = useState(step.headers !== "" || step.body !== "" || step.expectStatus !== "");
  const area =
    "min-h-16 w-full resize-y rounded-lg border border-input bg-card px-3 py-2 font-mono text-xs text-foreground outline-none transition placeholder:text-muted-foreground/70 hover:border-foreground/20 focus:border-primary focus:ring-2 focus:ring-primary/15";
  return (
    <div className="grid min-w-0 flex-1 gap-2">
      <div className="flex gap-2">
        <Select aria-label="Méthode" className="w-28 font-mono" value={step.method} onChange={(e) => onChange({ ...step, method: e.target.value as HttpMethod })}>
          {HTTP_METHODS.map((m) => (
            <option key={m} value={m}>{m}</option>
          ))}
        </Select>
        <Input aria-label="URL" className="min-w-0 flex-1 font-mono" value={step.url} onChange={(e) => onChange({ ...step, url: e.target.value })} placeholder="https://…" />
      </div>
      {advanced ? (
        <>
          <textarea
            aria-label="En-têtes"
            className={area}
            value={step.headers}
            onChange={(e) => onChange({ ...step, headers: e.target.value })}
            placeholder={"En-têtes, un par ligne\nContent-Type: application/json"}
            spellCheck={false}
          />
          {withBody && (
            <textarea
              aria-label="Corps"
              className={cn(area, "min-h-20")}
              value={step.body}
              onChange={(e) => onChange({ ...step, body: e.target.value })}
              placeholder={'Corps de la requête\n{"text": "Déploiement terminé"}'}
              spellCheck={false}
            />
          )}
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-muted-foreground">Codes attendus</span>
            <Input aria-label="Codes attendus" className="w-32 font-mono" value={step.expectStatus} onChange={(e) => onChange({ ...step, expectStatus: e.target.value })} placeholder="2xx" />
            <span className="text-muted-foreground">délai</span>
            <Num label="Délai" value={step.timeoutSecs} min={1} max={300} onChange={(timeoutSecs) => onChange({ ...step, timeoutSecs })} /> s
          </div>
        </>
      ) : (
        <button type="button" className="justify-self-start text-xs text-primary hover:underline" onClick={() => setAdvanced(true)}>
          En-têtes, corps, codes attendus…
        </button>
      )}
      <p className="text-xs text-muted-foreground">L'étape échoue si le code reçu n'est pas attendu (par défaut : 2xx).</p>
    </div>
  );
}

function SshFields({ step, onChange, refs }: { step: Extract<AutomationStep, { kind: "sshCommand" }>; onChange: (s: AutomationStep) => void; refs: Refs }) {
  const available = snippetsFor(refs, step.serverId);
  // Commande enregistrée supprimée ou non disponible sur ce serveur : on l'affiche quand même.
  const missing = step.snippetId !== null && !available.some((s) => s.id === step.snippetId);
  return (
    <div className="grid min-w-0 flex-1 gap-2">
      <div className="flex gap-2">
        <RefSelect
          label="Serveur"
          items={refs.servers}
          value={step.serverId}
          onChange={(serverId) => {
            const keep = step.snippetId !== null && snippetsFor(refs, serverId).some((s) => s.id === step.snippetId);
            onChange({ ...step, serverId, snippetId: keep ? step.snippetId : null });
          }}
          empty="Aucun serveur"
        />
        <Select
          aria-label="Commande"
          className="min-w-0 flex-1"
          value={step.snippetId ?? "free"}
          onChange={(e) => onChange({ ...step, snippetId: e.target.value === "free" ? null : Number(e.target.value) })}
        >
          <option value="free">Commande libre…</option>
          {missing && <option value={step.snippetId!}>Commande #{step.snippetId} (indisponible)</option>}
          {available.map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </Select>
      </div>
      {step.snippetId === null && (
        <>
          <textarea
            aria-label="Commande"
            className="min-h-14 w-full resize-y rounded-lg border border-input bg-card px-3 py-2 font-mono text-xs text-foreground outline-none transition placeholder:text-muted-foreground/70 hover:border-foreground/20 focus:border-primary focus:ring-2 focus:ring-primary/15"
            value={step.command}
            maxLength={4000}
            onChange={(e) => onChange({ ...step, command: e.target.value })}
            placeholder="systemctl is-active nginx"
            spellCheck={false}
          />
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <input type="checkbox" className="accent-[var(--primary)]" checked={step.sudo} onChange={(e) => onChange({ ...step, sudo: e.target.checked })} />
            Avec <code>sudo -n</code>
          </label>
        </>
      )}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
        <label className="flex items-center gap-2 text-muted-foreground">
          <input type="checkbox" className="accent-[var(--primary)]" checked={step.failOnError} onChange={(e) => onChange({ ...step, failOnError: e.target.checked })} />
          Échouer si code ≠ 0
        </label>
        <span className="flex items-center gap-2 text-muted-foreground">
          délai <Num label="Délai" value={step.timeoutSecs} min={1} max={3600} onChange={(timeoutSecs) => onChange({ ...step, timeoutSecs })} /> s
        </span>
      </div>
      <p className="text-xs text-muted-foreground">Exécution non interactive (clé SSH). La sortie est enregistrée dans l'historique (tronquée).</p>
    </div>
  );
}

function StepFields({ step, onChange, refs }: { step: AutomationStep; onChange: (s: AutomationStep) => void; refs: Refs }) {
  switch (step.kind) {
    case "startWorkspace":
    case "stopWorkspace":
      return <RefSelect label="Workspace" items={refs.workspaces} value={step.workspaceId} onChange={(workspaceId) => onChange({ ...step, workspaceId })} empty="Aucun workspace" />;
    case "openEditor":
    case "openFolder":
      return <RefSelect label="Projet" items={refs.projects} value={step.projectId} onChange={(projectId) => onChange({ ...step, projectId })} empty="Aucun projet" />;
    case "runScript":
    case "stopScript":
      return (
        <div className="grid min-w-0 flex-1 gap-2">
          <div className="flex gap-2">
            <RefSelect label="Projet" items={refs.projects} value={step.projectId} onChange={(projectId) => onChange({ ...step, projectId })} empty="Aucun projet" />
            <Input aria-label="Script" className="w-32 font-mono" value={step.script} onChange={(e) => onChange({ ...step, script: e.target.value })} />
          </div>
          {step.kind === "runScript" && (
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              <input type="checkbox" className="accent-[var(--primary)]" checked={step.openBrowser} onChange={(e) => onChange({ ...step, openBrowser: e.target.checked })} />
              Ouvrir le navigateur quand le serveur est prêt
            </label>
          )}
        </div>
      );
    case "launchApp":
      return <RefSelect label="Application" items={refs.apps} value={step.appId} onChange={(appId) => onChange({ ...step, appId })} empty="Aucune application (voir Système)" />;
    case "openTunnel":
    case "closeTunnel":
      return <RefSelect label="Tunnel" items={refs.tunnels} value={step.tunnelId} onChange={(tunnelId) => onChange({ ...step, tunnelId })} empty="Aucun tunnel (voir Serveurs › Tunnels)" />;
    case "openUrl":
      return <Input aria-label="URL" className="min-w-0 flex-1" value={step.url} onChange={(e) => onChange({ ...step, url: e.target.value })} />;
    case "notify":
      return (
        <div className="grid min-w-0 flex-1 gap-2">
          <Input aria-label="Titre" value={step.title} maxLength={120} onChange={(e) => onChange({ ...step, title: e.target.value })} placeholder="Titre" />
          <Input aria-label="Message" value={step.body} maxLength={500} onChange={(e) => onChange({ ...step, body: e.target.value })} placeholder="Message (optionnel)" />
        </div>
      );
    case "wait":
      return (
        <label className="flex items-center gap-2 text-sm">
          <Num label="Secondes" value={step.seconds} min={1} max={3600} onChange={(seconds) => onChange({ ...step, seconds })} /> secondes
        </label>
      );
    case "waitForPort":
      return (
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2 text-sm">
          <Input aria-label="Hôte" className="min-w-0 flex-1" value={step.host} onChange={(e) => onChange({ ...step, host: e.target.value })} />
          <Num label="Port" value={step.port} min={1} max={65535} onChange={(port) => onChange({ ...step, port })} />
          <span className="text-muted-foreground">pendant</span>
          <Num label="Délai" value={step.timeoutSecs} min={1} max={3600} onChange={(timeoutSecs) => onChange({ ...step, timeoutSecs })} /> s max.
        </div>
      );
    case "httpRequest":
      return <HttpFields step={step} onChange={onChange} />;
    case "sshCommand":
      return <SshFields step={step} onChange={onChange} refs={refs} />;
    case "condition":
      return <ConditionEditor condition={step.condition} onChange={(condition) => onChange({ ...step, condition })} refs={refs} />;
  }
}

export function AutomationEditor({
  initial,
  open,
  onOpenChange,
  onSave,
  refs,
}: {
  initial: AutomationInput | null;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onSave: (input: AutomationInput) => Promise<string | null>;
  refs: Refs;
}) {
  const [form, setForm] = useState<AutomationInput | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState<AutomationStep["kind"]>("notify");

  useEffect(() => {
    if (open) {
      setError(null);
      setForm(
        initial ?? {
          id: null,
          name: "",
          description: "",
          enabled: true,
          trigger: { kind: "manual" },
          steps: [],
          onError: "stop",
          timeoutMinutes: 30,
        },
      );
    }
  }, [open, initial]);

  if (!form) return null;
  const set = (patch: Partial<AutomationInput>) => setForm((f) => (f ? { ...f, ...patch } : f));
  const setStep = (i: number, s: AutomationStep) => set({ steps: form.steps.map((x, j) => (j === i ? s : x)) });
  const move = (i: number, d: -1 | 1) => {
    const steps = [...form.steps];
    [steps[i], steps[i + d]] = [steps[i + d], steps[i]];
    set({ steps });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] max-w-3xl grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden">
        <DialogHeader>
          <DialogTitle>{form.id ? "Modifier l'automatisation" : "Nouvelle automatisation"}</DialogTitle>
          <DialogDescription>Un déclencheur, puis des étapes exécutées dans l'ordre.</DialogDescription>
        </DialogHeader>

        <div className="grid min-h-0 gap-5 overflow-y-auto pr-1">
          <div className="grid gap-2">
            <Input value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder="Nom" aria-label="Nom" maxLength={80} />
            <Input value={form.description} onChange={(e) => set({ description: e.target.value })} placeholder="Description (optionnelle)" aria-label="Description" maxLength={300} />
          </div>

          <section className="grid gap-2">
            <h4 className="text-sm font-medium">Déclencheur</h4>
            <TriggerEditor trigger={form.trigger} onChange={(trigger) => set({ trigger })} />
          </section>

          <section className="grid gap-2">
            <h4 className="text-sm font-medium">Étapes</h4>
            {form.steps.length === 0 && (
              <p className="rounded-lg border border-dashed px-3 py-4 text-center text-sm text-muted-foreground">Ajoutez une première étape.</p>
            )}
            <ol className="grid gap-2">
              {form.steps.map((step, i) => {
                const Icon = stepIcon(step.kind);
                const meta = STEP_KINDS.find((k) => k.kind === step.kind)!;
                return (
                  <li key={i} className={cn("rounded-lg border p-2", step.kind === "condition" && "border-primary/40 bg-primary/4")}>
                    <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
                      <span className="tabular-nums">{i + 1}.</span>
                      <Icon className="size-3.5" />
                      <span className="flex-1 font-medium">{meta.label}</span>
                      <Button variant="ghost" size="icon" className="size-7" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Monter"><ArrowUp /></Button>
                      <Button variant="ghost" size="icon" className="size-7" disabled={i === form.steps.length - 1} onClick={() => move(i, 1)} aria-label="Descendre"><ArrowDown /></Button>
                      <Button variant="ghost" size="icon" className="size-7 hover:text-destructive" onClick={() => set({ steps: form.steps.filter((_, j) => j !== i) })} aria-label="Supprimer l'étape"><Trash2 /></Button>
                    </div>
                    <div className="flex gap-2 pl-6">
                      <StepFields step={step} onChange={(s) => setStep(i, s)} refs={refs} />
                    </div>
                  </li>
                );
              })}
            </ol>
            <div className="flex gap-2">
              <Select value={adding} onChange={(e) => setAdding(e.target.value as AutomationStep["kind"])} aria-label="Type d'étape" className="flex-1">
                {["Workspaces", "Projets", "Ouvrir", "Serveurs", "Contrôle"].map((g) => (
                  <optgroup key={g} label={g}>
                    {STEP_KINDS.filter((k) => k.group === g).map((k) => (
                      <option key={k.kind} value={k.kind}>{k.label}</option>
                    ))}
                  </optgroup>
                ))}
              </Select>
              <Button variant="secondary" onClick={() => set({ steps: [...form.steps, defaultStep(adding, refs)] })}>Ajouter l'étape</Button>
            </div>
          </section>

          <section className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="grid gap-1.5 text-sm">
              <span className="font-medium">En cas d'erreur</span>
              <Select value={form.onError} onChange={(e) => set({ onError: e.target.value as AutomationInput["onError"] })}>
                <option value="stop">Arrêter le workflow</option>
                <option value="continue">Continuer avec l'étape suivante</option>
              </Select>
            </label>
            <label className="grid gap-1.5 text-sm">
              <span className="font-medium">Durée maximale</span>
              <span className="flex items-center gap-2">
                <Num label="Minutes" value={form.timeoutMinutes} min={1} max={1440} onChange={(timeoutMinutes) => set({ timeoutMinutes })} /> minutes
              </span>
            </label>
          </section>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter className="items-center">
          <label className="mr-auto flex items-center gap-2 text-sm text-muted-foreground">
            <input type="checkbox" className="accent-[var(--primary)]" checked={form.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
            Activée
          </label>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Annuler</Button>
          <Button
            disabled={!form.name.trim() || form.steps.length === 0}
            onClick={async () => {
              const err = await onSave(form);
              if (err) setError(err);
              else onOpenChange(false);
            }}
          >
            Enregistrer
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
