import { useEffect, useMemo, useRef, useState } from "react";
import { Eye, EyeOff, FilePlus2, Loader2, Plus, RefreshCw, Save, Trash2, Undo2, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { confirmAction } from "@/components/ui/confirm";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { api } from "@/services/tauri";
import type { EnvFile, EnvOverview } from "@/types";

/**
 * Fichiers `.env*` d'un projet : table clé / valeur éditable et profil injecté dans les scripts.
 * Les valeurs sont des secrets : masquées par défaut, jamais écrites dans le journal.
 */

interface Row {
  /** Identifiant local stable (clé React). */
  uid: number;
  /** Rang dans le fichier lu, `null` pour une nouvelle variable. */
  index: number | null;
  key: string;
  value: string;
}

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const NAME_RE = /^\.env(\.[A-Za-z0-9_-]+)*$/;
const MASK = "••••••••••";

let nextUid = 1;
const toRows = (file: EnvFile): Row[] => file.entries.map((e) => ({ uid: nextUid++, index: e.index, key: e.key, value: e.value }));

function sameRows(rows: Row[], file: EnvFile | null): boolean {
  if (!file) return rows.length === 0;
  if (rows.length !== file.entries.length) return false;
  return rows.every((r, i) => {
    const e = file.entries[i];
    return r.index === e.index && r.key === e.key && r.value === e.value;
  });
}

const area =
  "w-full resize-y rounded-lg border border-input bg-card px-3 py-2 font-mono text-xs text-foreground outline-none transition hover:border-foreground/20 focus:border-primary focus:ring-2 focus:ring-primary/15";

export function EnvPanel({ projectId }: { projectId: number }) {
  const [overview, setOverview] = useState<EnvOverview | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [file, setFile] = useState<EnvFile | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [revealed, setRevealed] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const loadSeq = useRef(0);

  const dirty = !sameRows(rows, file);

  const loadFile = async (name: string | null) => {
    const seq = ++loadSeq.current;
    setSelected(name);
    setRevealed(new Set());
    if (!name) {
      setFile(null);
      setRows([]);
      return;
    }
    setLoading(true);
    try {
      const f = await api.env.read(projectId, name);
      if (seq !== loadSeq.current) return;
      setFile(f);
      setRows(toRows(f));
      setError(null);
    } catch (e) {
      if (seq !== loadSeq.current) return;
      setFile(null);
      setRows([]);
      setError(String(e));
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  };

  const loadOverview = async (keep: string | null) => {
    try {
      const ov = await api.env.overview(projectId);
      setOverview(ov);
      const names = ov.files.map((f) => f.name);
      const pick = keep && names.includes(keep) ? keep : (ov.active && names.includes(ov.active) ? ov.active : names[0] ?? null);
      await loadFile(pick);
    } catch (e) {
      setError(String(e));
    }
  };

  useEffect(() => {
    setOverview(null);
    setFile(null);
    setRows([]);
    setError(null);
    setCreating(false);
    loadOverview(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const confirmDiscard = async () =>
    !dirty ||
    confirmAction({
      title: "Abandonner les modifications ?",
      description: `Les changements non enregistrés de ${selected} seront perdus.`,
      confirmLabel: "Abandonner",
    });

  const switchTo = async (name: string) => {
    if (name === selected || !(await confirmDiscard())) return;
    await loadFile(name);
  };

  // Validation : clés invalides ou en double.
  const problems = useMemo(() => {
    const bad = new Set<number>();
    const seen = new Map<string, number>();
    for (const r of rows) {
      const k = r.key.trim();
      if (!KEY_RE.test(k)) bad.add(r.uid);
      const prev = seen.get(k);
      if (prev !== undefined) {
        bad.add(prev);
        bad.add(r.uid);
      } else seen.set(k, r.uid);
    }
    return bad;
  }, [rows]);

  const presentKeys = new Set(rows.map((r) => r.key.trim()));
  const missing = (file?.missing ?? []).filter((k) => !presentKeys.has(k));

  const update = (uid: number, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.uid === uid ? { ...r, ...patch } : r)));
  const toggleReveal = (uid: number) =>
    setRevealed((s) => {
      const n = new Set(s);
      if (n.has(uid)) n.delete(uid);
      else n.add(uid);
      return n;
    });
  const addRow = (key = "") => {
    const uid = nextUid++;
    setRows((rs) => [...rs, { uid, index: null, key, value: "" }]);
    setRevealed((s) => new Set(s).add(uid));
  };
  const allRevealed = rows.length > 0 && rows.every((r) => revealed.has(r.uid));

  const save = async () => {
    if (!file || problems.size > 0) return;
    setSaving(true);
    try {
      const saved = await api.env.save(
        projectId,
        file.name,
        file.revision,
        rows.map((r) => ({ index: r.index, key: r.key.trim(), value: r.value })),
      );
      setFile(saved);
      setRows(toRows(saved));
      setRevealed(new Set());
      setError(null);
      setOverview((ov) =>
        ov && { ...ov, files: ov.files.map((f) => (f.name === saved.name ? { ...f, entries: saved.entries.length } : f)) },
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const setActive = async (name: string | null) => {
    try {
      setOverview(await api.env.setActive(projectId, name));
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  };

  const files = overview?.files ?? [];
  const profiles = files.filter((f) => !f.isExample);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="grid gap-4 p-6">
        <Card>
          <CardHeader>
            <CardTitle>Profil des scripts</CardTitle>
          </CardHeader>
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <Select
              aria-label="Profil actif"
              className="w-64"
              value={overview?.active ?? ""}
              disabled={!overview}
              onChange={(e) => setActive(e.target.value || null)}
            >
              <option value="">Aucun (variables non injectées)</option>
              {profiles.map((f) => (
                <option key={f.name} value={f.name}>{f.name}</option>
              ))}
              {overview?.active && !profiles.some((f) => f.name === overview.active) && (
                <option value={overview.active}>{overview.active} (introuvable)</option>
              )}
            </Select>
            <p className="min-w-0 flex-1 text-xs text-muted-foreground">
              Les variables de ce fichier sont injectées dans l'environnement des scripts lancés depuis DevCenter
              (projet, workspaces, automatisations, téléphone).
            </p>
          </div>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Fichiers .env</CardTitle>
            <Button variant="ghost" size="sm" onClick={async () => (await confirmDiscard()) && loadOverview(selected)} title="Relire depuis le disque">
              <RefreshCw /> Recharger
            </Button>
          </CardHeader>

          <div className="flex flex-wrap items-center gap-1.5">
            {files.map((f) => (
              <button
                key={f.name}
                type="button"
                onClick={() => switchTo(f.name)}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 font-mono text-xs transition-colors",
                  f.name === selected ? "border-primary/60 bg-primary/10 text-primary" : "text-muted-foreground hover:border-primary/40 hover:text-foreground",
                )}
              >
                {f.name}
                <span className="tabular-nums opacity-70">{f.entries}</span>
                {f.name === overview?.active && <Badge variant="success" className="px-1 py-0 font-sans">actif</Badge>}
                {f.isExample && <Badge variant="outline" className="px-1 py-0 font-sans">modèle</Badge>}
              </button>
            ))}
            {!creating && (
              <Button variant="ghost" size="sm" onClick={() => setCreating(true)}>
                <FilePlus2 /> Nouveau fichier
              </Button>
            )}
          </div>

          {creating && (
            <CreateForm
              projectId={projectId}
              existing={files.map((f) => f.name)}
              example={files.find((f) => f.isExample)?.name ?? null}
              onCancel={() => setCreating(false)}
              onCreated={async (name) => {
                setCreating(false);
                if (await confirmDiscard()) await loadOverview(name);
                else setOverview(await api.env.overview(projectId).catch(() => overview));
              }}
            />
          )}

          {overview && files.length === 0 && !creating && (
            <p className="text-sm text-muted-foreground">Aucun fichier .env à la racine du projet.</p>
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}

          {selected && (
            <>
              {missing.length > 0 && (
                <div className="grid gap-2 rounded-lg border border-warning/30 bg-warning/5 px-3 py-2.5 text-sm">
                  <div className="flex items-center gap-2">
                    <span className="text-warning">
                      {missing.length} clé{missing.length > 1 && "s"} de {file?.example} absente{missing.length > 1 && "s"}
                    </span>
                    <button type="button" className="ml-auto text-xs text-primary hover:underline" onClick={() => missing.forEach((k) => addRow(k))}>
                      Tout ajouter
                    </button>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {missing.map((k) => (
                      <button
                        key={k}
                        type="button"
                        onClick={() => addRow(k)}
                        title="Ajouter cette variable"
                        className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 font-mono text-xs text-muted-foreground hover:border-primary/50 hover:text-primary"
                      >
                        <Plus className="size-3" /> {k}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div className="overflow-hidden rounded-lg border">
                <div className="grid grid-cols-[minmax(10rem,2fr)_minmax(0,3fr)_auto] items-center gap-2 border-b bg-foreground/[0.02] px-3 py-1.5">
                  <span className="eyebrow">Clé</span>
                  <span className="eyebrow">Valeur</span>
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-primary"
                    onClick={() => setRevealed(allRevealed ? new Set() : new Set(rows.map((r) => r.uid)))}
                    disabled={rows.length === 0}
                  >
                    {allRevealed ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                    {allRevealed ? "Tout masquer" : "Tout afficher"}
                  </button>
                </div>
                {loading ? (
                  <p className="flex items-center gap-2 px-3 py-3 text-sm text-muted-foreground">
                    <Loader2 className="size-4 animate-spin" /> Lecture…
                  </p>
                ) : rows.length === 0 ? (
                  <p className="px-3 py-3 text-sm text-muted-foreground">Aucune variable.</p>
                ) : (
                  <ul className="divide-y">
                    {rows.map((r) => {
                      const shown = revealed.has(r.uid);
                      const multiline = r.value.includes("\n");
                      return (
                        <li key={r.uid} className="grid grid-cols-[minmax(10rem,2fr)_minmax(0,3fr)_auto] items-start gap-2 px-3 py-1.5">
                          <Input
                            aria-label="Clé"
                            className={cn("h-8 font-mono text-xs", problems.has(r.uid) && "border-destructive focus:border-destructive")}
                            value={r.key}
                            spellCheck={false}
                            autoComplete="off"
                            onChange={(e) => update(r.uid, { key: e.target.value })}
                            placeholder="NOM_VARIABLE"
                            title={problems.has(r.uid) ? "Nom invalide ou en double" : undefined}
                          />
                          {!shown ? (
                            <button
                              type="button"
                              onClick={() => toggleReveal(r.uid)}
                              className="flex h-8 min-w-0 items-center rounded-lg border border-input bg-card px-3 text-left font-mono text-xs text-muted-foreground hover:border-foreground/20"
                              title="Afficher la valeur"
                            >
                              {r.value === "" ? <span className="italic opacity-60">vide</span> : MASK}
                              {multiline && <span className="ml-2 font-sans opacity-60">(multiligne)</span>}
                            </button>
                          ) : multiline ? (
                            <textarea
                              aria-label="Valeur"
                              className={cn(area, "min-h-16")}
                              value={r.value}
                              spellCheck={false}
                              autoComplete="off"
                              onChange={(e) => update(r.uid, { value: e.target.value })}
                            />
                          ) : (
                            <Input
                              aria-label="Valeur"
                              className="h-8 font-mono text-xs"
                              value={r.value}
                              spellCheck={false}
                              autoComplete="off"
                              onChange={(e) => update(r.uid, { value: e.target.value })}
                            />
                          )}
                          <div className="flex items-center">
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-8"
                              onClick={() => toggleReveal(r.uid)}
                              aria-label={shown ? "Masquer la valeur" : "Afficher la valeur"}
                              title={shown ? "Masquer" : "Afficher"}
                            >
                              {shown ? <EyeOff /> : <Eye />}
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-8"
                              onClick={() => setRows((rs) => rs.filter((x) => x.uid !== r.uid))}
                              aria-label="Supprimer la variable"
                              title="Supprimer"
                            >
                              <Trash2 />
                            </Button>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <Button variant="secondary" size="sm" onClick={() => addRow()} disabled={loading || !file}>
                  <Plus /> Ajouter une variable
                </Button>
                {problems.size > 0 && <span className="text-xs text-destructive">Noms de variables invalides ou en double.</span>}
                <div className="ml-auto flex items-center gap-2">
                  {dirty && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        if (file) setRows(toRows(file));
                        setRevealed(new Set());
                      }}
                    >
                      <Undo2 /> Annuler
                    </Button>
                  )}
                  <Button size="sm" onClick={save} disabled={!dirty || saving || problems.size > 0 || !file}>
                    {saving ? <Loader2 className="animate-spin" /> : <Save />} Enregistrer
                  </Button>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                Commentaires, ordre et guillemets du fichier sont conservés ; les nouvelles variables sont ajoutées à la fin.
              </p>
            </>
          )}
        </Card>
      </div>
    </div>
  );
}

function CreateForm({
  projectId,
  existing,
  example,
  onCancel,
  onCreated,
}: {
  projectId: number;
  existing: string[];
  example: string | null;
  onCancel: () => void;
  onCreated: (name: string) => void;
}) {
  const [name, setName] = useState(existing.includes(".env") ? ".env.local" : ".env");
  const [copyFrom, setCopyFrom] = useState<string>(example ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmed = name.trim();
  const valid = NAME_RE.test(trimmed) && !existing.includes(trimmed);

  const submit = async () => {
    if (!valid) return;
    setBusy(true);
    try {
      await api.env.create(projectId, trimmed, copyFrom || null);
      onCreated(trimmed);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="grid gap-2 rounded-lg border bg-foreground/[0.02] p-3"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Input
          aria-label="Nom du fichier"
          className="h-8 w-48 font-mono text-xs"
          value={name}
          spellCheck={false}
          autoFocus
          onChange={(e) => setName(e.target.value)}
          placeholder=".env.local"
        />
        <Select aria-label="Contenu initial" className="w-56" value={copyFrom} onChange={(e) => setCopyFrom(e.target.value)}>
          <option value="">Fichier vide</option>
          {existing.map((n) => (
            <option key={n} value={n}>Copie de {n}</option>
          ))}
        </Select>
        <Button size="sm" type="submit" disabled={!valid || busy}>
          {busy ? <Loader2 className="animate-spin" /> : <FilePlus2 />} Créer
        </Button>
        <Button variant="ghost" size="icon" type="button" className="size-8" onClick={onCancel} aria-label="Annuler">
          <X />
        </Button>
      </div>
      {!valid && trimmed && (
        <p className="text-xs text-muted-foreground">
          {existing.includes(trimmed) ? "Ce fichier existe déjà." : "Nom attendu : .env ou .env.<suffixe> (lettres, chiffres, - et _)."}
        </p>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </form>
  );
}
