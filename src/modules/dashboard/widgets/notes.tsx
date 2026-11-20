import { useEffect, useRef, useState } from "react";
import { Check, ListChecks, Plus, StickyNote, Trash2, X } from "lucide-react";

import { cn } from "@/lib/utils";
import { api, isTauri } from "@/services/tauri";
import { readLocal, writeLocal } from "./polling";

interface NoteItem {
  id: string;
  text: string;
  done: boolean;
}

interface NotesData {
  mode: "list" | "text";
  text: string;
  items: NoteItem[];
}

const EMPTY: NotesData = { mode: "list", text: "", items: [] };
const SAVE_DELAY_MS = 600;

/** Données lues, normalisées (fichier modifié à la main, ancienne version). */
function normalize(raw: unknown): NotesData {
  const v = (raw ?? {}) as Partial<NotesData>;
  return {
    mode: v.mode === "text" ? "text" : "list",
    text: typeof v.text === "string" ? v.text : "",
    items: Array.isArray(v.items)
      ? v.items
          .filter((it): it is NoteItem => !!it && typeof it.text === "string")
          .map((it) => ({ id: String(it.id ?? crypto.randomUUID()), text: it.text, done: it.done === true }))
      : [],
  };
}

// Hors de l'application (navigateur seul), les notes restent dans le stockage local.
const load = (widget: string) =>
  isTauri() ? api.dashboard.notes<NotesData>(widget) : Promise.resolve(readLocal<NotesData | null>(`devcenter.dashboard.notes.${widget}`, null));
const save = (widget: string, data: NotesData) =>
  isTauri() ? api.dashboard.saveNotes(widget, data) : Promise.resolve(writeLocal(`devcenter.dashboard.notes.${widget}`, data));

/** Notes et liste de tâches, éditables directement sur le widget, enregistrées en SQLite. */
export function NotesBody({ widgetId = "notes" }: { widgetId?: string }) {
  const [data, setData] = useState<NotesData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  /** Échap : la modification en cours est abandonnée (le blur qui suit ne doit rien enregistrer). */
  const cancelEdit = useRef(false);
  const pending = useRef<NotesData | null>(null);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    load(widgetId)
      .then((raw) => !cancelled && setData(normalize(raw ?? EMPTY)))
      .catch((e) => {
        if (cancelled) return;
        setError(String(e));
        setData(EMPTY);
      });
    return () => {
      cancelled = true;
    };
  }, [widgetId]);

  // Enregistrement différé ; ce qui reste en attente est écrit à la fermeture du widget.
  const flush = () => {
    window.clearTimeout(timer.current);
    const next = pending.current;
    pending.current = null;
    if (next) save(widgetId, next).then(() => setError(null), (e) => setError(String(e)));
  };
  const flushRef = useRef(flush);
  flushRef.current = flush;
  useEffect(() => () => flushRef.current(), []);

  const update = (fn: (d: NotesData) => NotesData) =>
    setData((prev) => {
      const next = fn(prev ?? EMPTY);
      pending.current = next;
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => flushRef.current(), SAVE_DELAY_MS);
      return next;
    });

  if (!data) return <p className="text-sm text-muted-foreground">Chargement…</p>;

  const add = () => {
    const text = draft.trim();
    if (!text) return;
    update((d) => ({ ...d, items: [...d.items, { id: crypto.randomUUID(), text, done: false }] }));
    setDraft("");
  };
  const patchItem = (id: string, patch: Partial<NoteItem>) =>
    update((d) => ({ ...d, items: d.items.map((it) => (it.id === id ? { ...it, ...patch } : it)) }));
  const removeItem = (id: string) => update((d) => ({ ...d, items: d.items.filter((it) => it.id !== id) }));
  const done = data.items.filter((it) => it.done).length;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex items-center gap-2">
        <div className="inline-flex rounded-md border bg-background/40 p-px" role="tablist" aria-label="Affichage">
          {(
            [
              { id: "list", label: "Tâches", icon: ListChecks },
              { id: "text", label: "Texte", icon: StickyNote },
            ] as const
          ).map((m) => (
            <button
              key={m.id}
              type="button"
              role="tab"
              aria-selected={data.mode === m.id}
              onClick={() => update((d) => ({ ...d, mode: m.id }))}
              className={cn(
                "flex items-center gap-1 rounded-[5px] px-2 py-0.5 text-[11px] leading-4 transition-colors",
                data.mode === m.id ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              <m.icon className="size-3" />
              {m.label}
            </button>
          ))}
        </div>
        {data.mode === "list" && data.items.length > 0 && (
          <span className="ml-auto flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <span className="font-mono tabular-nums">
              {done}/{data.items.length}
            </span>
            {done > 0 && (
              <button
                type="button"
                onClick={() => update((d) => ({ ...d, items: d.items.filter((it) => !it.done) }))}
                title="Retirer les tâches terminées"
                aria-label="Retirer les tâches terminées"
                className="flex size-5 items-center justify-center rounded-md transition-colors hover:bg-destructive/15 hover:text-destructive"
              >
                <Trash2 className="size-3" />
              </button>
            )}
          </span>
        )}
      </div>

      {data.mode === "text" ? (
        <textarea
          value={data.text}
          onChange={(e) => {
            const text = e.target.value;
            update((d) => ({ ...d, text }));
          }}
          onBlur={() => flushRef.current()}
          placeholder="Notez quelque chose…"
          spellCheck={false}
          maxLength={20000}
          className="min-h-0 flex-1 resize-none rounded-lg border bg-background/40 px-3 py-2 font-mono text-xs leading-relaxed outline-none placeholder:text-muted-foreground focus:border-primary/50"
        />
      ) : (
        <>
          <ul className="grid min-h-0 content-start gap-0.5 overflow-y-auto">
            {data.items.length === 0 && <li className="px-1 text-xs text-muted-foreground">Aucune tâche.</li>}
            {data.items.map((it) => (
              <li key={it.id} className="group flex items-center gap-2 rounded-md px-1 py-0.5 hover:bg-foreground/[0.03]">
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={it.done}
                  aria-label={it.done ? `Marquer « ${it.text} » à faire` : `Marquer « ${it.text} » terminée`}
                  onClick={() => patchItem(it.id, { done: !it.done })}
                  className={cn(
                    "flex size-4 shrink-0 items-center justify-center rounded border transition-colors",
                    it.done ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/50 hover:border-primary",
                  )}
                >
                  {it.done && <Check className="size-3" />}
                </button>
                {editing === it.id ? (
                  <input
                    autoFocus
                    defaultValue={it.text}
                    maxLength={300}
                    aria-label="Modifier la tâche"
                    onBlur={(e) => {
                      if (cancelEdit.current) {
                        cancelEdit.current = false;
                        setEditing(null);
                        return;
                      }
                      const text = e.target.value.trim();
                      if (text) patchItem(it.id, { text });
                      else removeItem(it.id);
                      setEditing(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") e.currentTarget.blur();
                      if (e.key === "Escape") {
                        cancelEdit.current = true;
                        e.currentTarget.blur();
                      }
                    }}
                    className="min-w-0 flex-1 rounded border border-primary/50 bg-background/60 px-1 text-sm outline-none"
                  />
                ) : (
                  <span
                    onDoubleClick={() => setEditing(it.id)}
                    title="Double-cliquez pour modifier"
                    className={cn("min-w-0 flex-1 cursor-text text-sm break-words", it.done && "text-muted-foreground line-through")}
                  >
                    {it.text}
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => removeItem(it.id)}
                  title="Supprimer la tâche"
                  aria-label={`Supprimer « ${it.text} »`}
                  className="flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-colors group-hover:opacity-100 hover:bg-destructive/15 hover:text-destructive focus-visible:opacity-100"
                >
                  <X className="size-3" />
                </button>
              </li>
            ))}
          </ul>
          <form
            className="mt-auto flex shrink-0 items-center gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              add();
            }}
          >
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Ajouter une tâche…"
              maxLength={300}
              aria-label="Nouvelle tâche"
              className="h-7 min-w-0 flex-1 rounded-md border bg-background/40 px-2 text-sm outline-none placeholder:text-muted-foreground focus:border-primary/50"
            />
            <button
              type="submit"
              disabled={!draft.trim()}
              title="Ajouter"
              aria-label="Ajouter la tâche"
              className="flex size-7 shrink-0 items-center justify-center rounded-md border text-muted-foreground transition-colors enabled:hover:border-primary/50 enabled:hover:text-primary disabled:opacity-40"
            >
              <Plus className="size-3.5" />
            </button>
          </form>
        </>
      )}
      {error && <p className="truncate text-xs text-destructive" title={error}>{error}</p>}
    </div>
  );
}
