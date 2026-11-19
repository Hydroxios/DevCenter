import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { ChevronLeft, ChevronRight, GitCommitHorizontal, Loader2, RefreshCw, X } from "lucide-react";

import { useHoverTip } from "@/components/ui/hover-tip";
import { cn } from "@/lib/utils";
import { api } from "@/services/tauri";
import type { CommitActivity, DayCommit } from "@/types";
import { CommitPanel } from "@/modules/projects/GitHistory";

/* ------------------------------------------------------------------ */
/* Outils de dates                                                     */
/* ------------------------------------------------------------------ */

/** Clé `AAAA-MM-JJ` d'une date, en heure locale. */
export function dayKey(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function addDays(d: Date, n: number) {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

const MONTHS_FR = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];
const plural = (n: number, word: string) => `${n} ${word}${n > 1 ? "s" : ""}`;
const fmtDay = new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
const fmtTime = new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit" });

export const GRID_LEVELS = ["bg-foreground/[0.07]", "bg-primary/30", "bg-primary/55", "bg-primary/80", "bg-primary"];

/** Séries : en cours (aujourd'hui peut encore être vide) et la plus longue. */
export function streaks(counts: Map<string, number>) {
  const today = startOfToday();
  let current = 0;
  let cursor = counts.get(dayKey(today)) ? today : addDays(today, -1);
  while (counts.get(dayKey(cursor))) {
    current++;
    cursor = addDays(cursor, -1);
  }
  let longest = 0;
  let run = 0;
  let prev: Date | null = null;
  for (const key of [...counts.keys()].sort()) {
    if (!counts.get(key)) continue;
    const d = new Date(`${key}T00:00:00`);
    run = prev && dayKey(addDays(prev, 1)) === key ? run + 1 : 1;
    longest = Math.max(longest, run);
    prev = d;
  }
  return { current, longest };
}

/* ------------------------------------------------------------------ */
/* Grille de contributions                                             */
/* ------------------------------------------------------------------ */

export const GRID_GAP = 3;
export const GRID_LEFT = 26;

/** Grille façon profil GitHub : une colonne par semaine, lundi en haut, la semaine en cours à droite. */
export function ContributionGrid({
  counts,
  weeks,
  cell,
  selected,
  onSelect,
}: {
  counts: Map<string, number>;
  weeks: number;
  cell: number;
  selected?: string | null;
  onSelect: (date: Date) => void;
}) {
  const { bind, tip, hide } = useHoverTip();
  const today = startOfToday();
  const todayKey = dayKey(today);
  const start = addDays(today, -((today.getDay() + 6) % 7) - (weeks - 1) * 7);

  const cols = Array.from({ length: weeks }, (_, c) =>
    Array.from({ length: 7 }, (_, r) => {
      const date = addDays(start, c * 7 + r);
      const key = dayKey(date);
      return { key, date, count: counts.get(key) ?? 0, future: date > today };
    }),
  );
  const visible = cols.flat().filter((d) => !d.future);
  const max = Math.max(1, ...visible.map((d) => d.count));
  const level = (n: number) => (n === 0 ? 0 : Math.min(4, Math.ceil((n / max) * 4)));
  const step = cell + GRID_GAP;

  return (
    <div className="grid gap-1" style={{ width: GRID_LEFT + weeks * step - GRID_GAP }}>
      <div className="relative h-[10px]" style={{ marginLeft: GRID_LEFT }}>
        {cols.map((col, c) => {
          // Mois écrit au-dessus de la colonne qui contient le 1er (sauf trop près du bord droit).
          const first = col.find((d) => d.date.getDate() === 1);
          if (!first || c > weeks - 2) return null;
          return (
            <span key={c} className="absolute top-0 text-[10px] leading-none text-muted-foreground" style={{ left: c * step }}>
              {MONTHS_FR[first.date.getMonth()]}
            </span>
          );
        })}
      </div>
      <div className="flex">
        <div
          className="grid shrink-0 text-[10px] leading-none text-muted-foreground"
          style={{ width: GRID_LEFT, gridTemplateRows: `repeat(7, ${cell}px)`, rowGap: GRID_GAP }}
        >
          {["lun.", "", "mer.", "", "ven.", "", ""].map((l, i) => (
            <span key={i} className="flex items-center">
              {cell >= 8 ? l : ""}
            </span>
          ))}
        </div>
        <div
          className="grid grid-flow-col"
          style={{ gridTemplateRows: `repeat(7, ${cell}px)`, gridAutoColumns: `${cell}px`, gap: GRID_GAP }}
          onMouseLeave={hide}
        >
          {cols.flat().map((d) =>
            d.future ? (
              <span key={d.key} />
            ) : (
              <button
                type="button"
                key={d.key}
                onClick={() => {
                  hide();
                  onSelect(d.date);
                }}
                aria-label={`${plural(d.count, "commit")} le ${fmtDay.format(d.date)}`}
                aria-pressed={selected === d.key}
                className={cn(
                  "rounded-[2px] outline-none transition-shadow hover:ring-1 hover:ring-foreground/70 focus-visible:ring-1 focus-visible:ring-foreground",
                  GRID_LEVELS[level(d.count)],
                  d.key === todayKey && "ring-1 ring-foreground/40",
                  selected === d.key && "ring-2 ring-foreground hover:ring-2 hover:ring-foreground",
                )}
                {...bind(
                  <>
                    <p className="font-medium">
                      {d.count === 0 ? "Aucun commit" : plural(d.count, "commit")}
                      {d.key === todayKey && <span className="ml-1.5 text-primary">· aujourd'hui</span>}
                    </p>
                    <p className="text-muted-foreground first-letter:uppercase">{fmtDay.format(d.date)}</p>
                  </>,
                )}
              />
            ),
          )}
        </div>
      </div>
      {tip}
    </div>
  );
}

/** Bouton « Actualiser » : l'icône tourne pendant la relecture. */
export function RefreshButton({
  onClick,
  loading,
  label = "Actualiser",
  className,
}: {
  onClick: () => void;
  loading?: boolean;
  label?: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={loading}
      title={loading ? "Actualisation…" : label}
      aria-label={label}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors enabled:hover:bg-primary/10 enabled:hover:text-primary disabled:cursor-default",
        className ?? "size-6",
      )}
    >
      <RefreshCw className={cn("size-3.5", loading && "animate-spin text-primary")} />
    </button>
  );
}

export function GridLegend({ className }: { className?: string }) {
  return (
    <span className={cn("flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground", className)}>
      Moins
      {GRID_LEVELS.map((c) => (
        <span key={c} className={cn("size-2.5 rounded-[2px]", c)} />
      ))}
      Plus
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Vue plein écran                                                     */
/* ------------------------------------------------------------------ */

/** Détail des commits par jour, stocké pour toute la session (les jours passés ne changent plus guère). */
const dayCache = new Map<string, DayCommit[]>();

function useDayCommits(key: string | null, nonce = 0) {
  const [state, setState] = useState<{ key: string; commits?: DayCommit[]; error?: string } | null>(null);
  useEffect(() => {
    if (!key) return;
    const cached = dayCache.get(key);
    // Le jour en cours est toujours relu (de nouveaux commits peuvent arriver).
    if (cached && key !== dayKey(new Date()) && nonce === 0) {
      setState({ key, commits: cached });
      return;
    }
    let cancelled = false;
    setState({ key, commits: cached });
    api.activity
      .commitsOn(key)
      .then((commits) => {
        dayCache.set(key, commits);
        if (!cancelled) setState({ key, commits });
      })
      .catch((e) => !cancelled && setState({ key, error: String(e) }));
    return () => {
      cancelled = true;
    };
  }, [key, nonce]);
  return state?.key === key ? state : null;
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

/** Activité Git en plein écran : grille sur un an, commits du jour choisi et détail du commit. */
export function ActivityView({
  activity,
  day,
  onDayChange,
  onClose,
  onRefresh,
  refreshing,
}: {
  activity: CommitActivity;
  /** Relit l'activité de tous les dépôts (widget) ; le jour affiché est relu aussi. */
  onRefresh?: () => void;
  refreshing?: boolean;
  day: Date | null;
  onDayChange: (d: Date) => void;
  onClose: () => void;
}) {
  const counts = useMemo(() => new Map(activity.days.map((d) => [d.date, d.count])), [activity]);
  const { current, longest } = useMemo(() => streaks(counts), [counts]);
  const best = useMemo(() => activity.days.reduce<{ date: string; count: number } | null>((m, d) => (!m || d.count > m.count ? d : m), null), [activity]);
  const activeDays = activity.days.filter((d) => d.count > 0).length;

  const [gridRef, gridW] = useWidth<HTMLDivElement>();
  const WEEKS = 53;
  const cell = Math.max(6, Math.min(18, (gridW - GRID_LEFT + GRID_GAP) / WEEKS - GRID_GAP));

  const key = day ? dayKey(day) : null;
  const [nonce, setNonce] = useState(0);
  const state = useDayCommits(key, nonce);
  const refresh = () => {
    onRefresh?.();
    setNonce((n) => n + 1);
  };
  const dayLoading = !!state && !state.commits && !state.error;
  const commits = state?.commits;
  const [picked, setPicked] = useState<DayCommit | null>(null);
  // Nouveau jour : on montre d'office son commit le plus récent.
  useEffect(() => setPicked(commits?.[0] ?? null), [commits]);

  const groups = useMemo(() => {
    const m = new Map<number, { name: string; items: DayCommit[] }>();
    for (const c of commits ?? []) {
      const g = m.get(c.projectId) ?? { name: c.projectName, items: [] };
      g.items.push(c);
      m.set(c.projectId, g);
    }
    return [...m];
  }, [commits]);

  const today = startOfToday();
  const isToday = key === dayKey(today);
  const shift = (n: number) => {
    if (!day) return;
    const next = addDays(day, n);
    if (next <= today) onDayChange(next);
  };

  // ← / → : jour précédent / suivant.
  useEffect(() => {
    if (!day) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === "ArrowLeft") shift(-1);
      else if (e.key === "ArrowRight") shift(1);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const stats: [string, React.ReactNode][] = [
    ["Commits sur l'année", activity.total],
    ["Jours actifs", activeDays],
    ["Série en cours", plural(current, "jour")],
    ["Plus longue série", plural(longest, "jour")],
    ["Record", best ? `${best.count} · ${new Date(`${best.date}T00:00:00`).toLocaleDateString("fr-FR", { day: "numeric", month: "short" })}` : "—"],
  ];

  return (
    <DialogPrimitive.Root open={!!day} onOpenChange={(o) => !o && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className="dialog-content fixed inset-0 z-50 flex flex-col bg-background text-foreground outline-none"
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          {/* En-tête */}
          <header className="flex h-14 shrink-0 items-center gap-3 border-b px-6">
            <GitCommitHorizontal className="size-4 text-primary" />
            <DialogPrimitive.Title className="text-sm font-semibold">Activité Git</DialogPrimitive.Title>
            <span className="meta">
              {plural(activity.repos, "dépôt")} · vos commits, toutes branches
            </span>
            <RefreshButton onClick={refresh} loading={refreshing || dayLoading} label="Actualiser l'activité" className="ml-auto size-8" />
            <DialogPrimitive.Close
              className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition hover:bg-primary/10 hover:text-primary"
              aria-label="Fermer"
              title="Fermer (Échap)"
            >
              <X className="size-4" />
            </DialogPrimitive.Close>
          </header>

          {/* Chiffres clés + grille sur l'année */}
          <section className="shrink-0 border-b px-6 py-5">
            <dl className="mb-5 flex flex-wrap gap-x-10 gap-y-3">
              {stats.map(([label, value]) => (
                <div key={label}>
                  <dt className="eyebrow text-[10px]">{label}</dt>
                  <dd className="mt-1 font-mono text-xl font-semibold tabular-nums">{value}</dd>
                </div>
              ))}
            </dl>
            <div ref={gridRef} className="flex justify-center">
              {gridW > 0 && <ContributionGrid counts={counts} weeks={WEEKS} cell={cell} selected={key} onSelect={onDayChange} />}
            </div>
            <div className="mt-2 flex justify-end">
              <GridLegend />
            </div>
          </section>

          {/* Jour choisi : liste des commits et détail */}
          <div className="flex min-h-0 flex-1">
            <div className="flex w-[min(460px,45%)] shrink-0 flex-col">
              <div className="flex h-12 shrink-0 items-center gap-1 border-b px-4">
                <button
                  type="button"
                  onClick={() => shift(-1)}
                  className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-primary/10 hover:text-primary"
                  aria-label="Jour précédent"
                  title="Jour précédent (←)"
                >
                  <ChevronLeft className="size-4" />
                </button>
                <button
                  type="button"
                  onClick={() => shift(1)}
                  disabled={isToday}
                  className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground enabled:hover:bg-primary/10 enabled:hover:text-primary disabled:opacity-30"
                  aria-label="Jour suivant"
                  title="Jour suivant (→)"
                >
                  <ChevronRight className="size-4" />
                </button>
                <p className="ml-1 min-w-0 flex-1 truncate text-sm font-medium first-letter:uppercase">{day && fmtDay.format(day)}</p>
                {!isToday && (
                  <button type="button" onClick={() => onDayChange(today)} className="meta shrink-0 hover:text-primary">
                    Aujourd'hui
                  </button>
                )}
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto p-4">
                {state?.error ? (
                  <p className="text-sm text-destructive">{state.error}</p>
                ) : !commits ? (
                  <p className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="size-3.5 animate-spin" /> Lecture des dépôts…
                  </p>
                ) : commits.length === 0 ? (
                  <p className="py-10 text-center text-sm text-muted-foreground">Aucun commit ce jour-là.</p>
                ) : (
                  <div className="grid gap-5">
                    {groups.map(([id, g]) => (
                      <section key={id} className="grid gap-1.5">
                        <div className="flex items-center justify-between gap-3 px-1">
                          <Link to={`/projects?project=${id}`} onClick={onClose} className="truncate text-sm font-medium hover:text-primary">
                            {g.name}
                          </Link>
                          <span className="meta shrink-0">{plural(g.items.length, "commit")}</span>
                        </div>
                        <ul className="grid gap-px overflow-hidden rounded-lg border bg-border">
                          {g.items.map((c) => {
                            const active = picked?.hash === c.hash;
                            return (
                              <li key={c.hash}>
                                <button
                                  type="button"
                                  onClick={() => setPicked(c)}
                                  className={cn(
                                    "flex w-full items-center gap-3 bg-card px-3 py-2 text-left text-sm transition-colors hover:bg-primary/5",
                                    active && "bg-primary/10 hover:bg-primary/10",
                                  )}
                                >
                                  <span className={cn("h-4 w-0.5 shrink-0 rounded-full", active ? "bg-primary" : "bg-transparent")} />
                                  <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">{fmtTime.format(c.time * 1000)}</span>
                                  <span className="shrink-0 font-mono text-xs text-primary">{c.hash.slice(0, 7)}</span>
                                  <span className="min-w-0 flex-1 truncate">{c.subject}</span>
                                </button>
                              </li>
                            );
                          })}
                        </ul>
                      </section>
                    ))}
                  </div>
                )}
              </div>
            </div>
            {picked ? (
              <CommitPanel
                key={`${picked.projectId}:${picked.hash}`}
                projectId={picked.projectId}
                commit={{ hash: picked.hash, short: picked.hash.slice(0, 7), subject: picked.subject, refs: [] }}
                onClose={() => setPicked(null)}
                className="w-auto min-w-0 flex-1"
              />
            ) : (
              <div className="flex flex-1 items-center justify-center border-l text-sm text-muted-foreground">
                {commits && commits.length > 0 ? "Choisissez un commit pour voir ses fichiers." : null}
              </div>
            )}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
