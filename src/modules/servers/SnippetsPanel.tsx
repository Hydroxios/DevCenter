import { useCallback, useEffect, useRef, useState } from "react";
import { Copy, Globe, Loader2, Pencil, Play, Plus, RotateCw, ShieldAlert, SquareTerminal, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { confirmAction } from "@/components/ui/confirm";
import { contextMenu, copyText } from "@/components/ui/context-menu";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { api } from "@/services/tauri";
import type { CommandResult, Server, Snippet, SnippetInput } from "@/types";

/** Commandes proposées à l'ajout (enregistrées comme commandes globales). */
const SUGGESTIONS: Omit<SnippetInput, "id" | "serverId">[] = [
  { name: "Espace disque", command: "df -h", confirm: false, sudo: false },
  { name: "Mémoire", command: "free -h", confirm: false, sudo: false },
  { name: "Redémarrer nginx", command: "systemctl restart nginx", confirm: true, sudo: true },
  { name: "Derniers logs système", command: "journalctl -n 100 --no-pager -o short-iso", confirm: false, sudo: false },
  {
    name: "Mise à jour apt",
    command: "DEBIAN_FRONTEND=noninteractive apt-get update && DEBIAN_FRONTEND=noninteractive apt-get -y upgrade",
    confirm: true,
    sudo: true,
  },
];

const AREA =
  "min-h-24 w-full resize-y rounded-lg border border-input bg-card px-3 py-2 font-mono text-xs text-foreground outline-none transition placeholder:text-muted-foreground/70 hover:border-foreground/20 focus:border-primary focus:ring-2 focus:ring-primary/15";

// ------------------------------------------------------------------ Édition

function SnippetDialog({
  server,
  snippet,
  open,
  onOpenChange,
  onSaved,
}: {
  server: Server;
  snippet: Snippet | null;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onSaved: (list: Snippet[]) => void;
}) {
  const [form, setForm] = useState<SnippetInput>({ id: null, name: "", command: "", serverId: server.id, confirm: false, sudo: false });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setForm(snippet ? { ...snippet } : { id: null, name: "", command: "", serverId: server.id, confirm: false, sudo: false });
  }, [open, snippet, server.id]);

  const set = (patch: Partial<SnippetInput>) => setForm((f) => ({ ...f, ...patch }));

  const submit = async () => {
    try {
      onSaved(await api.snippets.save(form));
      onOpenChange(false);
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{snippet ? "Modifier la commande" : "Nouvelle commande"}</DialogTitle>
          <DialogDescription>Exécutée telle quelle par le shell du serveur, sans terminal interactif.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <label className="grid gap-1.5">
            <span className="text-sm font-medium">Nom</span>
            <Input value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder="Espace disque" maxLength={80} />
          </label>
          <label className="grid gap-1.5">
            <span className="text-sm font-medium">Commande</span>
            <textarea
              className={AREA}
              value={form.command}
              onChange={(e) => set({ command: e.target.value })}
              placeholder="df -h"
              spellCheck={false}
              maxLength={4000}
            />
          </label>
          <label className="grid gap-1.5">
            <span className="text-sm font-medium">Disponible sur</span>
            <Select value={form.serverId === null ? "all" : "this"} onChange={(e) => set({ serverId: e.target.value === "all" ? null : (snippet?.serverId ?? server.id) })}>
              <option value="all">Tous les serveurs</option>
              <option value="this">{snippet?.serverId != null && snippet.serverId !== server.id ? "Son serveur uniquement" : `${server.name} uniquement`}</option>
            </Select>
          </label>
          <div className="grid gap-2">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" className="accent-[var(--primary)]" checked={form.sudo} onChange={(e) => set({ sudo: e.target.checked })} />
              Exécuter avec <code>sudo -n</code>
              <span className="text-xs text-muted-foreground">(sudo sans mot de passe requis)</span>
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" className="accent-[var(--primary)]" checked={form.confirm} onChange={(e) => set({ confirm: e.target.checked })} />
              Demander une confirmation avant l'exécution
            </label>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Annuler</Button>
          <Button onClick={submit} disabled={!form.name.trim() || !form.command.trim()}>Enregistrer</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ------------------------------------------------------------------ Résultat

type RunState = { snippet: Snippet; result: CommandResult | null; error: string | null };

function OutputBlock({ label, text, tone }: { label: string; text: string; tone?: "error" }) {
  return (
    <div className="grid gap-1.5">
      <div className="flex items-center justify-between">
        <span className={cn("text-xs font-medium", tone === "error" ? "text-destructive" : "text-muted-foreground")}>{label}</span>
        <Button variant="ghost" size="sm" className="h-7" onClick={() => copyText(text)}>
          <Copy /> Copier
        </Button>
      </div>
      <pre className="max-h-[42vh] overflow-auto rounded-lg border bg-black p-3 font-mono text-xs leading-relaxed whitespace-pre text-[#d4d4d8] select-text">
        {text}
      </pre>
    </div>
  );
}

function ResultDialog({ server, run, onClose, onRerun }: { server: Server; run: RunState | null; onClose: () => void; onRerun: (s: Snippet) => void }) {
  const r = run?.result;
  const ok = r?.exitCode === 0;
  return (
    <Dialog open={run !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-4xl">
        {run && (
          <>
            <DialogHeader>
              <DialogTitle className="truncate">
                {run.snippet.name} · {server.name}
              </DialogTitle>
              <DialogDescription className="truncate font-mono text-xs" title={run.snippet.command}>
                {run.snippet.sudo ? "sudo -n " : ""}
                {run.snippet.command}
              </DialogDescription>
            </DialogHeader>
            {!r && !run.error && (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" /> Exécution en cours…
              </p>
            )}
            {run.error && <p className="text-sm text-destructive">{run.error}</p>}
            {r && (
              <div className="grid gap-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={ok ? "success" : "destructive"}>code {r.exitCode ?? "?"}</Badge>
                  <span className="text-xs text-muted-foreground tabular-nums">{(r.durationMs / 1000).toFixed(1)} s</span>
                  {r.truncated && <Badge variant="warning">sortie tronquée</Badge>}
                </div>
                {r.stdout.trim() !== "" && <OutputBlock label="Sortie" text={r.stdout} />}
                {r.stderr.trim() !== "" && <OutputBlock label="Erreurs (stderr)" text={r.stderr} tone={ok ? undefined : "error"} />}
                {r.stdout.trim() === "" && r.stderr.trim() === "" && <p className="text-sm text-muted-foreground">Aucune sortie.</p>}
              </div>
            )}
            <DialogFooter>
              {r && (
                <Button
                  variant="ghost"
                  onClick={() => copyText([`$ ${run.snippet.command}`, r.stdout, r.stderr, `(code ${r.exitCode ?? "?"})`].filter((x) => x.trim()).join("\n"))}
                >
                  <Copy /> Tout copier
                </Button>
              )}
              <Button variant="outline" disabled={!r && !run.error} onClick={() => onRerun(run.snippet)}>
                <RotateCw /> Relancer
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ------------------------------------------------------------------ Panneau

export function SnippetsPanel({ server }: { server: Server }) {
  const [snippets, setSnippets] = useState<Snippet[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editor, setEditor] = useState<{ open: boolean; snippet: Snippet | null }>({ open: false, snippet: null });
  const [busy, setBusy] = useState<Set<number>>(new Set());
  const [run, setRun] = useState<RunState | null>(null);
  /** Seul le résultat de la dernière exécution lancée est affiché. */
  const token = useRef(0);

  useEffect(() => {
    api.snippets.list().then(setSnippets).catch((e) => setError(String(e)));
  }, []);

  const mine = (snippets ?? []).filter((s) => s.serverId === null || s.serverId === server.id);
  const suggestions = SUGGESTIONS.filter((sg) => !mine.some((s) => s.command.trim() === sg.command));

  const execute = useCallback(
    async (s: Snippet) => {
      if (s.confirm) {
        const ok = await confirmAction({
          title: `Exécuter « ${s.name} » sur ${server.name} ?`,
          description: `${s.sudo ? "sudo -n " : ""}${s.command}`,
          confirmLabel: "Exécuter",
        });
        if (!ok) return;
      }
      const t = ++token.current;
      setRun({ snippet: s, result: null, error: null });
      setBusy((b) => new Set(b).add(s.id));
      try {
        const result = await api.snippets.run(server.id, s.id);
        if (t === token.current) setRun({ snippet: s, result, error: null });
      } catch (e) {
        if (t === token.current) setRun({ snippet: s, result: null, error: String(e) });
      } finally {
        setBusy((b) => {
          const next = new Set(b);
          next.delete(s.id);
          return next;
        });
      }
    },
    [server.id, server.name],
  );

  const remove = async (s: Snippet) => {
    const ok = await confirmAction({
      title: `Supprimer « ${s.name} » ?`,
      description: s.serverId === null ? "Cette commande globale disparaît de tous les serveurs." : "La commande est retirée de ce serveur.",
      confirmLabel: "Supprimer",
    });
    if (!ok) return;
    try {
      setSnippets(await api.snippets.remove(s.id));
    } catch (e) {
      setError(String(e));
    }
  };

  const addSuggestion = async (sg: (typeof SUGGESTIONS)[number]) => {
    try {
      setSnippets(await api.snippets.save({ ...sg, id: null, serverId: null }));
    } catch (e) {
      setError(String(e));
    }
  };

  const menu = (s: Snippet) =>
    contextMenu(() => [
      { heading: s.name },
      { label: "Exécuter", icon: Play, disabled: busy.has(s.id), onSelect: () => execute(s) },
      { label: "Modifier…", icon: Pencil, onSelect: () => setEditor({ open: true, snippet: s }) },
      { label: "Copier la commande", icon: Copy, onSelect: () => copyText(s.command) },
      { separator: true },
      { label: "Supprimer", icon: Trash2, danger: true, onSelect: () => remove(s) },
    ]);

  return (
    <div className="grid gap-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          {snippets ? `${mine.length} commande${mine.length > 1 ? "s" : ""}` : "Chargement…"}
        </p>
        <Button variant="outline" size="sm" onClick={() => setEditor({ open: true, snippet: null })}>
          <Plus /> Nouvelle commande
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Exécution non interactive (clé SSH, délai de 5 min). Les commandes marquées sudo utilisent <code>sudo -n</code> : elles nécessitent un sudo sans mot de passe.
      </p>
      {error && <p className="text-sm text-destructive">{error}</p>}

      {snippets && mine.length === 0 && (
        <p className="rounded-lg border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">
          Aucune commande. Créez-en une ou ajoutez une suggestion ci-dessous.
        </p>
      )}
      {mine.length > 0 && (
        <ul className="divide-y rounded-lg border">
          {mine.map((s) => (
            <li key={s.id} className="flex items-center gap-3 px-3 py-2" onContextMenu={menu(s)}>
              <SquareTerminal className="size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-2 text-sm">
                  <span className="truncate font-medium">{s.name}</span>
                  {s.serverId === null && (
                    <span title="Disponible sur tous les serveurs" className="text-muted-foreground">
                      <Globe className="size-3.5" aria-label="Globale" />
                    </span>
                  )}
                  {s.sudo && <Badge variant="warning">sudo</Badge>}
                  {s.confirm && (
                    <span title="Confirmation demandée" className="text-muted-foreground">
                      <ShieldAlert className="size-3.5" aria-label="Confirmation demandée" />
                    </span>
                  )}
                </p>
                <p className="truncate font-mono text-xs text-muted-foreground" title={s.command}>
                  {s.command}
                </p>
              </div>
              <div className="flex shrink-0 items-center">
                <Button variant="ghost" size="icon" className="size-8" onClick={() => execute(s)} disabled={busy.has(s.id)} aria-label="Exécuter" title="Exécuter">
                  {busy.has(s.id) ? <Loader2 className="animate-spin" /> : <Play />}
                </Button>
                <Button variant="ghost" size="icon" className="size-8" onClick={() => setEditor({ open: true, snippet: s })} aria-label="Modifier" title="Modifier">
                  <Pencil />
                </Button>
                <Button variant="ghost" size="icon" className="size-8 hover:text-destructive" onClick={() => remove(s)} aria-label="Supprimer" title="Supprimer">
                  <Trash2 />
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {snippets && suggestions.length > 0 && (
        <section className="grid gap-2">
          <h4 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Suggestions</h4>
          <ul className="grid gap-2 sm:grid-cols-2">
            {suggestions.map((sg) => (
              <li key={sg.command} className="flex items-center gap-2 rounded-lg border border-dashed px-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-2 text-sm">
                    <span className="truncate">{sg.name}</span>
                    {sg.sudo && <Badge variant="warning">sudo</Badge>}
                  </p>
                  <p className="truncate font-mono text-xs text-muted-foreground" title={sg.command}>
                    {sg.command}
                  </p>
                </div>
                <Button variant="ghost" size="sm" onClick={() => addSuggestion(sg)} title="Ajouter (disponible sur tous les serveurs)">
                  <Plus /> Ajouter
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <SnippetDialog
        server={server}
        snippet={editor.snippet}
        open={editor.open}
        onOpenChange={(open) => setEditor((e) => ({ ...e, open }))}
        onSaved={setSnippets}
      />
      <ResultDialog server={server} run={run} onClose={() => setRun(null)} onRerun={execute} />
    </div>
  );
}
