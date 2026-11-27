import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Bot, ChevronLeft, ChevronRight, Loader2, X } from "lucide-react";

import { useHoverTip } from "@/components/ui/hover-tip";
import { cn } from "@/lib/utils";
import { api } from "@/services/tauri";
import type { CcusageDay, CcusageDayDetail, CcusageReport, CcusageTotal } from "@/types";
import { RefreshButton, dayKey } from "./activity";
import { readLocal, writeLocal } from "./widgets/polling";

/* ------------------------------------------------------------------ */
/* Formats                                                             */
/* ------------------------------------------------------------------ */

export const usd = (v: number) => `$${v.toFixed(v >= 100 ? 0 : 2)}`;
export const compact = new Intl.NumberFormat("fr-FR", { notation: "compact", maximumFractionDigits: 1 });
const fmtLong = new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "numeric", month: "long" });
const fmtShort = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short" });
const fmtTime = new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit" });

/** Libellé court d'une période : « 7 jours », « 1 an ». */
export const rangeLabel = (n: number) => (n === 365 ? "1 an" : `${n} jours`);
const RANGES = [7, 14, 30, 90, 365] as const;

export interface UsageDay {
  key: string;
  date: Date;
  cost: number;
  tokens: number;
  r?: CcusageDay;
}

/** Les `points` derniers jours (le dernier est aujourd'hui), jours vides compris. */
export function usageDays(report: CcusageReport, points: number): UsageDay[] {
  const byDay = new Map(report.daily.map((d) => [d.period, d]));
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Array.from({ length: points }, (_, i) => {
    const date = new Date(today);
    date.setDate(today.getDate() - (points - 1 - i));
    const key = dayKey(date);
    const r = byDay.get(key);
    return { key, date, cost: r?.totalCost ?? 0, tokens: r?.totalTokens ?? 0, r };
  });
}

/* ------------------------------------------------------------------ */
/* Histogramme du coût par jour                                        */
/* ------------------------------------------------------------------ */

function DayTip({ d, today }: { d: UsageDay; today: boolean }) {
  return (
    <div className="grid gap-1">
      <p className="font-medium first-letter:uppercase">
        {fmtLong.format(d.date)}
        {today && <span className="ml-1.5 text-primary">· aujourd'hui</span>}
      </p>
      {d.r ? (
        <>
          <p className="font-mono text-sm text-primary tabular-nums">
            {usd(d.cost)} <span className="text-xs text-muted-foreground">· {compact.format(d.tokens)} tokens</span>
          </p>
          <dl className="grid grid-cols-[auto_auto] gap-x-4 font-mono text-[11px] text-muted-foreground tabular-nums">
            <dt>Entrée</dt>
            <dd className="text-right text-foreground">{compact.format(d.r.inputTokens)}</dd>
            <dt>Sortie</dt>
            <dd className="text-right text-foreground">{compact.format(d.r.outputTokens)}</dd>
            <dt>Cache écrit</dt>
            <dd className="text-right text-foreground">{compact.format(d.r.cacheCreationTokens)}</dd>
            <dt>Cache lu</dt>
            <dd className="text-right text-foreground">{compact.format(d.r.cacheReadTokens)}</dd>
          </dl>
          <p className="text-[11px] text-muted-foreground">Cliquer pour le détail</p>
        </>
      ) : (
        <p className="text-muted-foreground">Aucune utilisation</p>
      )}
    </div>
  );
}

/** Une barre par jour ; toute la hauteur de la colonne est cliquable et réagit au survol. */
export function UsageBars({
  days,
  selected,
  onSelect,
  className,
}: {
  days: UsageDay[];
  selected?: string | null;
  onSelect: (d: Date) => void;
  className?: string;
}) {
  const { bind, tip, hide } = useHoverTip();
  const max = Math.max(0.01, ...days.map((d) => d.cost));
  const todayKey = days[days.length - 1]?.key;
  return (
    <div
      className={cn("flex min-h-6 flex-1 rounded-sm border border-primary/15 bg-primary/5 px-1 pt-1", className)}
      // Beaucoup de jours : barres serrées pour qu'elles restent visibles.
      style={{ gap: days.length > 180 ? 0 : days.length > 60 ? 1 : 2 }}
      aria-label="Coût Claude Code par jour"
      onMouseLeave={hide}
    >
      {days.map((d) => {
        const active = selected ? selected === d.key : d.key === todayKey;
        return (
          <button
            type="button"
            key={d.key}
            onClick={() => {
              hide();
              onSelect(d.date);
            }}
            aria-label={`${fmtLong.format(d.date)} : ${usd(d.cost)}`}
            aria-pressed={selected === d.key}
            className="group flex min-w-0 flex-1 cursor-pointer items-end rounded-t-[2px] outline-none hover:bg-primary/5 focus-visible:bg-primary/10"
            {...bind(<DayTip d={d} today={d.key === todayKey} />)}
          >
            <span
              className={cn(
                "block w-full rounded-t-[2px] transition-colors",
                active ? "bg-primary" : "bg-primary/45 group-hover:bg-primary/80",
              )}
              style={{ height: `${d.cost > 0 ? Math.max(3, (d.cost / max) * 100) : 0}%` }}
            />
          </button>
        );
      })}
      {tip}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Vue plein écran                                                     */
/* ------------------------------------------------------------------ */

/**
 * Détails par jour, conservés d'une session à l'autre (le jour en cours est toujours relu) :
 * un jour passé ne change plus, inutile de relancer ccusage pour le revoir.
 */
const DETAIL_KEY = "devcenter.dashboard.ccusageDays.v1";
const DETAIL_MAX = 90;
const detailCache = new Map<string, CcusageDayDetail>(readLocal<[string, CcusageDayDetail][]>(DETAIL_KEY, []));
function storeDetail(key: string, data: CcusageDayDetail) {
  detailCache.delete(key);
  detailCache.set(key, data);
  // Les plus récemment consultés en dernier : on écarte les plus anciens au-delà de la limite.
  while (detailCache.size > DETAIL_MAX) detailCache.delete(detailCache.keys().next().value!);
  writeLocal(DETAIL_KEY, [...detailCache]);
}

function useDayDetail(key: string | null, nonce = 0) {
  const [state, setState] = useState<{ key: string; data?: CcusageDayDetail; error?: string } | null>(null);
  useEffect(() => {
    if (!key) return;
    const cached = detailCache.get(key);
    if (cached && key !== dayKey(new Date()) && nonce === 0) {
      setState({ key, data: cached });
      return;
    }
    let cancelled = false;
    setState({ key, data: cached });
    api.activity
      .ccusageDay(key)
      .then((data) => {
        storeDetail(key, data);
        if (!cancelled) setState({ key, data });
      })
      .catch((e) => !cancelled && setState({ key, error: String(e) }));
    return () => {
      cancelled = true;
    };
  }, [key, nonce]);
  return state?.key === key ? state : null;
}

/** Barre de proportion fine sous une ligne de détail. */
function Share({ value, max }: { value: number; max: number }) {
  return (
    <div className="h-1 overflow-hidden rounded-full bg-foreground/[0.06]">
      <div className="h-full rounded-full bg-primary/70" style={{ width: `${max > 0 ? Math.max(1, (value / max) * 100) : 0}%` }} />
    </div>
  );
}

function Panel({ title, aside, children, className }: { title: string; aside?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={cn("flex min-h-0 flex-col rounded-xl border bg-card", className)}>
      <div className="flex h-10 shrink-0 items-center justify-between gap-3 border-b px-4">
        <h3 className="eyebrow">{title}</h3>
        {aside}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
    </section>
  );
}

const shortModel = (m: string) => m.replace(/^claude-/, "");

export function UsageView({
  report,
  total: allTime,
  covered,
  initialRange,
  day,
  onDayChange,
  onClose,
  onRefresh,
  refreshing,
}: {
  /** Relit le relevé du widget (sans cache) ; le jour affiché et la période choisie sont relus aussi. */
  onRefresh?: () => void;
  refreshing?: boolean;
  /** Relevé du widget et nombre de jours qu'il couvre. */
  report: CcusageReport;
  /** Total depuis le premier usage (facultatif, chargé à part). */
  total?: CcusageTotal | null;
  covered: number;
  initialRange: number;
  day: Date | null;
  onDayChange: (d: Date) => void;
  onClose: () => void;
}) {
  const [points, setPoints] = useState(initialRange);
  // Chaque ouverture repart de la période du widget.
  useEffect(() => {
    if (day === null) setPoints(initialRange);
  }, [day === null, initialRange]);

  // Période plus longue que le relevé du widget : lecture dédiée.
  const [nonce, setNonce] = useState(0);
  const wideNonce = useRef(0);
  const [wide, setWide] = useState<{ days: number; report?: CcusageReport; error?: string } | null>(null);
  useEffect(() => {
    if (points <= covered || (wide && wide.days >= points && !wide.error && nonce === wideNonce.current)) return;
    wideNonce.current = nonce;
    let cancelled = false;
    setWide((w) => ({ days: points, report: w && w.days >= points ? w.report : undefined }));
    api.activity
      .ccusage(points, nonce > 0)
      .then((r) => !cancelled && setWide({ days: points, report: r }))
      .catch((e) => !cancelled && setWide({ days: points, error: String(e) }));
    return () => {
      cancelled = true;
    };
  }, [points, covered, nonce]);
  const source = points <= covered ? report : wide?.report;
  const loadingRange = points > covered && !wide?.report;

  const days = useMemo(() => usageDays(source ?? report, points), [source, report, points]);
  const key = day ? dayKey(day) : null;
  const index = days.findIndex((d) => d.key === key);
  const current = index >= 0 ? days[index] : null;
  const detail = useDayDetail(key, nonce);
  // Période raccourcie : le jour choisi en sort, on passe au plus récent.
  useEffect(() => {
    if (day && index < 0 && days.length) onDayChange(days[days.length - 1].date);
  }, [day, index, days, onDayChange]);
  const { bind, tip, hide } = useHoverTip();

  const total = days.reduce((a, d) => a + d.cost, 0);
  const tokens = days.reduce((a, d) => a + d.tokens, 0);
  const active = days.filter((d) => d.cost > 0);
  const best = active.reduce<UsageDay | null>((m, d) => (!m || d.cost > m.cost ? d : m), null);

  const shift = (n: number) => {
    const next = days[index + n];
    if (next) onDayChange(next.date);
  };
  useEffect(() => {
    if (!day) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") shift(-1);
      else if (e.key === "ArrowRight") shift(1);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const r = current?.r;
  const tokenRows: [string, number][] = r
    ? [
        ["Entrée", r.inputTokens],
        ["Sortie", r.outputTokens],
        ["Cache écrit", r.cacheCreationTokens],
        ["Cache lu", r.cacheReadTokens],
      ]
    : [];
  const tokenMax = Math.max(0, ...tokenRows.map(([, v]) => v));
  const models = [...(r?.modelBreakdowns ?? [])].sort((a, b) => b.cost - a.cost);
  const projects = detail?.data?.projects ?? [];
  const projectMax = Math.max(0, ...projects.map((p) => p.cost));
  const blocks = detail?.data?.blocks ?? [];

  // Frise de la journée : position des fenêtres de 5 h sur 24 h (heure locale).
  const dayStart = day ? new Date(day).setHours(0, 0, 0, 0) : 0;
  const pos = (iso: string) => Math.max(0, Math.min(100, ((new Date(iso).getTime() - dayStart) / 86_400_000) * 100));

  const stats: [string, string][] = [
    [points === 365 ? "Sur 1 an" : `${points} derniers jours`, loadingRange ? "…" : usd(total)],
    ["Moyenne par jour actif", active.length ? usd(total / active.length) : "—"],
    ["Jours actifs", `${active.length} / ${points}`],
    ["Record", best ? `${usd(best.cost)} · ${fmtShort.format(best.date)}` : "—"],
    ["Tokens", compact.format(tokens)],
    [
      allTime?.since ? `Total depuis le ${fmtShort.format(new Date(`${allTime.since}T00:00:00`))}` : "Total",
      allTime ? `${usd(allTime.cost)} · ${compact.format(allTime.tokens)}` : "…",
    ],
  ];

  return (
    <DialogPrimitive.Root open={!!day} onOpenChange={(o) => !o && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className="dialog-content fixed inset-0 z-50 flex flex-col bg-background text-foreground outline-none"
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <header className="flex h-14 shrink-0 items-center gap-3 border-b px-6">
            <Bot className="size-4 text-primary" />
            <DialogPrimitive.Title className="text-sm font-semibold">Utilisation Claude Code</DialogPrimitive.Title>
            <span className="meta">relevé par ccusage</span>
            <RefreshButton
              onClick={() => {
                onRefresh?.();
                setNonce((n) => n + 1);
              }}
              loading={refreshing || (!!detail && !detail.data && !detail.error)}
              label="Actualiser l'utilisation"
              className="ml-auto size-8"
            />
            <DialogPrimitive.Close
              className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition hover:bg-primary/10 hover:text-primary"
              aria-label="Fermer"
              title="Fermer (Échap)"
            >
              <X className="size-4" />
            </DialogPrimitive.Close>
          </header>

          {/* Chiffres clés + histogramme */}
          <section className="shrink-0 border-b px-6 py-5">
            <dl className="mb-5 flex flex-wrap gap-x-10 gap-y-3">
              {stats.map(([label, value]) => (
                <div key={label}>
                  <dt className="eyebrow text-[10px]">{label}</dt>
                  <dd className="mt-1 font-mono text-xl font-semibold tabular-nums">{value}</dd>
                </div>
              ))}
            </dl>
            <div className="mb-3 flex items-center gap-3">
              <div className="inline-flex rounded-lg border bg-secondary p-0.5" role="radiogroup" aria-label="Période">
                {RANGES.map((n) => (
                  <button
                    key={n}
                    type="button"
                    role="radio"
                    aria-checked={points === n}
                    onClick={() => setPoints(n)}
                    className={cn(
                      "rounded-md px-3 py-1 text-xs transition-colors",
                      points === n ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {rangeLabel(n)}
                  </button>
                ))}
              </div>
              {loadingRange && (
                <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Loader2 className="size-3.5 animate-spin" /> Lecture de la période…
                </span>
              )}
              {wide?.error && points > covered && <span className="text-xs text-destructive">{wide.error}</span>}
            </div>
            <UsageBars days={days} selected={key} onSelect={onDayChange} className={cn("h-36 flex-none", loadingRange && "opacity-40")} />
            <div className="mt-1.5 flex justify-between font-mono text-[10px] text-muted-foreground">
              <span>{fmtShort.format(days[0].date)}</span>
              <span>{fmtShort.format(days[Math.floor(days.length / 2)].date)}</span>
              <span>aujourd'hui</span>
            </div>
          </section>

          {/* Jour choisi */}
          <div className="flex h-12 shrink-0 items-center gap-1 border-b px-6">
            <button
              type="button"
              onClick={() => shift(-1)}
              disabled={index <= 0}
              className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground enabled:hover:bg-primary/10 enabled:hover:text-primary disabled:opacity-30"
              aria-label="Jour précédent"
              title="Jour précédent (←)"
            >
              <ChevronLeft className="size-4" />
            </button>
            <button
              type="button"
              onClick={() => shift(1)}
              disabled={index >= days.length - 1}
              className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground enabled:hover:bg-primary/10 enabled:hover:text-primary disabled:opacity-30"
              aria-label="Jour suivant"
              title="Jour suivant (→)"
            >
              <ChevronRight className="size-4" />
            </button>
            <p className="ml-1 text-sm font-medium first-letter:uppercase">{day && fmtLong.format(day)}</p>
            {current && (
              <p className="ml-auto font-mono text-sm tabular-nums">
                <span className="text-lg font-semibold text-primary">{usd(current.cost)}</span>
                <span className="ml-2 text-muted-foreground">{compact.format(current.tokens)} tokens</span>
              </p>
            )}
          </div>

          <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] gap-4 p-6">
            <div className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] gap-4">
              <Panel title="Tokens">
                {!r ? (
                  <p className="text-sm text-muted-foreground">Aucune utilisation ce jour-là.</p>
                ) : (
                  <ul className="grid gap-3">
                    {tokenRows.map(([label, v]) => (
                      <li key={label} className="grid gap-1">
                        <div className="flex justify-between text-sm">
                          <span className="text-muted-foreground">{label}</span>
                          <span className="font-mono tabular-nums">{compact.format(v)}</span>
                        </div>
                        <Share value={v} max={tokenMax} />
                      </li>
                    ))}
                  </ul>
                )}
              </Panel>
              <Panel title="Modèles">
                {models.length === 0 ? (
                  <p className="text-sm text-muted-foreground">{r ? r.modelsUsed.map(shortModel).join(", ") : "—"}</p>
                ) : (
                  <ul className="grid gap-3">
                    {models.map((m) => (
                      <li key={m.modelName} className="grid gap-1">
                        <div className="flex justify-between gap-3 text-sm">
                          <span className="truncate font-mono text-xs">{shortModel(m.modelName)}</span>
                          <span className="font-mono tabular-nums">{usd(m.cost)}</span>
                        </div>
                        <Share value={m.cost} max={current?.cost ?? 0} />
                        <p className="meta">
                          {compact.format(m.inputTokens + m.outputTokens + m.cacheCreationTokens + m.cacheReadTokens)} tokens · sortie{" "}
                          {compact.format(m.outputTokens)}
                        </p>
                      </li>
                    ))}
                  </ul>
                )}
              </Panel>
            </div>

            <div className="grid min-h-0 grid-rows-[minmax(0,1fr)_auto] gap-4">
              <Panel title="Par projet" aside={projects.length > 0 && <span className="meta">{projects.length} projet{projects.length > 1 ? "s" : ""}</span>}>
                {detail?.error ? (
                  <p className="text-sm text-destructive">{detail.error}</p>
                ) : !detail?.data ? (
                  <p className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="size-3.5 animate-spin" /> Lancement de ccusage…
                  </p>
                ) : projects.length === 0 ? (
                  <p className="text-sm text-muted-foreground">Aucun projet ce jour-là.</p>
                ) : (
                  <ul className="grid gap-3.5">
                    {projects.map((p) => (
                      <li key={p.key} className="grid gap-1">
                        <div className="flex items-center justify-between gap-3 text-sm">
                          {p.projectId !== null ? (
                            <Link to={`/projects?project=${p.projectId}`} onClick={onClose} className="truncate font-medium hover:text-primary">
                              {p.name}
                            </Link>
                          ) : (
                            <span className="truncate text-muted-foreground" {...bind(<span className="font-mono">{p.key}</span>)}>
                              {p.name}
                            </span>
                          )}
                          <span className="shrink-0 font-mono tabular-nums">{usd(p.cost)}</span>
                        </div>
                        <Share value={p.cost} max={projectMax} />
                        <p className="meta truncate">
                          {compact.format(p.totalTokens)} tokens · {p.models.map(shortModel).join(", ")}
                        </p>
                      </li>
                    ))}
                  </ul>
                )}
              </Panel>

              <Panel title="Fenêtres de 5 h" aside={blocks.length > 0 && <span className="meta">{blocks.length}</span>}>
                {!detail?.data ? (
                  <p className="text-sm text-muted-foreground">…</p>
                ) : blocks.length === 0 ? (
                  <p className="text-sm text-muted-foreground">Aucune fenêtre ce jour-là.</p>
                ) : (
                  <div className="grid gap-3">
                    {/* Frise de 0 h à 24 h */}
                    <div className="relative h-7 rounded-md border bg-foreground/[0.03]" onMouseLeave={hide}>
                      {[6, 12, 18].map((h) => (
                        <span key={h} className="absolute inset-y-0 border-l border-dashed border-border" style={{ left: `${(h / 24) * 100}%` }} />
                      ))}
                      {blocks.map((b) => {
                        const left = pos(b.start);
                        const right = b.end ? pos(b.end) : b.active ? pos(new Date().toISOString()) : left + 0.5;
                        return (
                          <span
                            key={b.start}
                            className={cn("absolute inset-y-1 rounded-sm bg-primary/70", b.active && "animate-pulse bg-primary")}
                            style={{ left: `${left}%`, width: `${Math.max(0.6, right - left)}%` }}
                            {...bind(
                              <span className="font-mono">
                                {fmtTime.format(new Date(b.start))} → {b.end ? fmtTime.format(new Date(b.end)) : "en cours"} · {usd(b.cost)}
                              </span>,
                            )}
                          />
                        );
                      })}
                    </div>
                    <div className="-mt-2 flex justify-between font-mono text-[10px] text-muted-foreground">
                      <span>0 h</span>
                      <span>6 h</span>
                      <span>12 h</span>
                      <span>18 h</span>
                      <span>24 h</span>
                    </div>
                    <ul className="grid gap-px overflow-hidden rounded-lg border bg-border">
                      {blocks.map((b) => (
                        <li key={b.start} className="flex items-center gap-3 bg-card px-3 py-1.5 text-sm">
                          <span className="font-mono text-xs tabular-nums">
                            {fmtTime.format(new Date(b.start))} → {b.end ? fmtTime.format(new Date(b.end)) : "…"}
                          </span>
                          {b.active && <span className="rounded bg-primary/15 px-1.5 text-[10px] text-primary">en cours</span>}
                          <span className="meta ml-auto">
                            {b.entries} messages · {compact.format(b.totalTokens)} tokens
                          </span>
                          <span className="w-16 text-right font-mono tabular-nums">{usd(b.cost)}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </Panel>
            </div>
          </div>
          {tip}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
