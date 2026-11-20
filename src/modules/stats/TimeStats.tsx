// Statistiques de temps : temps par jour, par projet et par workspace, commits par projet.
// Graphiques en simple CSS, dans le style du widget Claude Code.

import { useEffect, useState } from "react";
import { Link } from "react-router";
import { BarChart3, Loader2 } from "lucide-react";

import { useHoverTip } from "@/components/ui/hover-tip";
import { cn } from "@/lib/utils";
import { api } from "@/services/tauri";
import type { TimeStats } from "@/types";
import { RefreshButton, dayKey } from "@/modules/dashboard/activity";

/** Périodes proposées, en jours. */
export const TIME_RANGES = [7, 30, 90] as const;
export type TimeRange = (typeof TIME_RANGES)[number];

/** Durée compacte : « 3 h 05 », « 45 min ». */
export function hm(secs: number): string {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (h >= 100) return `${h} h`;
  if (h > 0) return `${h} h ${String(m).padStart(2, "0")}`;
  return `${m} min`;
}

const fmtLong = new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "numeric", month: "long" });
const fmtShort = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short" });
const plural = (n: number, word: string) => `${n} ${word}${n > 1 ? "s" : ""}`;

/** Les `points` derniers jours (le dernier est aujourd'hui), jours vides compris. */
function timeDays(stats: TimeStats, points: number) {
  const byDay = new Map(stats.daily.map((d) => [d.date, d.seconds]));
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Array.from({ length: points }, (_, i) => {
    const date = new Date(today);
    date.setDate(today.getDate() - (points - 1 - i));
    const key = dayKey(date);
    return { key, date, seconds: byDay.get(key) ?? 0 };
  });
}

/** Sélecteur de période ; `compact` pour les widgets. */
export function TimeRangePicker({ value, onChange, compact }: { value: TimeRange; onChange: (r: TimeRange) => void; compact?: boolean }) {
  return (
    <div className={cn("inline-flex shrink-0 border", compact ? "rounded-md bg-background/40 p-px" : "rounded-lg bg-secondary p-0.5")} role="radiogroup" aria-label="Période">
      {TIME_RANGES.map((n) => (
        <button
          key={n}
          type="button"
          role="radio"
          aria-checked={value === n}
          title={`${n} jours`}
          onClick={() => onChange(n)}
          className={cn(
            "transition-colors",
            compact ? "rounded-[5px] px-1.5 py-0.5 font-mono text-[10px] leading-none" : "rounded-md px-3 py-1 text-xs",
            value === n ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {compact ? `${n}j` : `${n} j`}
        </button>
      ))}
    </div>
  );
}

/** Une barre par jour de la période : temps d'activité (union des sessions et scripts). */
export function DailyTimeBars({ stats, points, className }: { stats: TimeStats; points: number; className?: string }) {
  const { bind, tip, hide } = useHoverTip();
  const days = timeDays(stats, points);
  const max = Math.max(60, ...days.map((d) => d.seconds));
  const todayKey = days[days.length - 1]?.key;
  return (
    <div
      className={cn("flex min-h-6 flex-1 rounded-sm border border-primary/15 bg-primary/5 px-1 pt-1", className)}
      style={{ gap: days.length > 60 ? 1 : 2 }}
      aria-label="Temps d'activité par jour"
      onMouseLeave={hide}
    >
      {days.map((d) => (
        <div
          key={d.key}
          tabIndex={0}
          aria-label={`${fmtLong.format(d.date)} : ${hm(d.seconds)}`}
          className="group flex min-w-0 flex-1 items-end rounded-t-[2px] outline-none hover:bg-primary/5 focus-visible:bg-primary/10"
          {...bind(
            <div className="grid gap-1">
              <p className="font-medium first-letter:uppercase">
                {fmtLong.format(d.date)}
                {d.key === todayKey && <span className="ml-1.5 text-primary">· aujourd'hui</span>}
              </p>
              <p className={cn("font-mono text-sm tabular-nums", d.seconds ? "text-primary" : "text-muted-foreground")}>
                {d.seconds ? hm(d.seconds) : "Aucune activité"}
              </p>
            </div>,
          )}
        >
          <span
            className={cn("block w-full rounded-t-[2px] transition-colors", d.key === todayKey ? "bg-primary" : "bg-primary/45 group-hover:bg-primary/80")}
            style={{ height: `${d.seconds > 0 ? Math.max(3, (d.seconds / max) * 100) : 0}%` }}
          />
        </div>
      ))}
      {tip}
    </div>
  );
}

/** Barre de proportion fine sous une ligne. */
export function Share({ value, max, muted }: { value: number; max: number; muted?: boolean }) {
  return (
    <div className="h-1 overflow-hidden rounded-full bg-foreground/[0.06]">
      <div
        className={cn("h-full rounded-full", muted ? "bg-foreground/30" : "bg-primary/70")}
        style={{ width: `${max > 0 && value > 0 ? Math.max(1, (value / max) * 100) : 0}%` }}
      />
    </div>
  );
}

function Panel({ title, aside, children }: { title: string; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="flex min-h-0 flex-col rounded-xl border bg-card">
      <div className="flex h-10 shrink-0 items-center justify-between gap-3 border-b px-4">
        <h3 className="eyebrow">{title}</h3>
        {aside}
      </div>
      <div className="min-h-0 flex-1 p-4">{children}</div>
    </section>
  );
}

const RANGE_KEY = "devcenter.timeStats.range";
export function readTimeRange(): TimeRange {
  try {
    const v = Number(localStorage.getItem(RANGE_KEY));
    return (TIME_RANGES as readonly number[]).includes(v) ? (v as TimeRange) : 30;
  } catch {
    return 30;
  }
}
export function saveTimeRange(r: TimeRange) {
  try {
    localStorage.setItem(RANGE_KEY, String(r));
  } catch {
    /* stockage indisponible : période non conservée */
  }
}

/** Vue détaillée (page Workspaces, section « Statistiques »). */
export function TimeStatsView({ onSelectWorkspace }: { onSelectWorkspace?: (id: number) => void }) {
  const [range, setRange] = useState<TimeRange>(readTimeRange);
  const [nonce, setNonce] = useState(0);
  const [state, setState] = useState<{ range: TimeRange; data?: TimeStats; error?: string; loading: boolean }>({ range, loading: true });

  useEffect(() => {
    let cancelled = false;
    setState((s) => ({ ...s, range, error: undefined, loading: true }));
    api.activity
      .timeStats(range)
      .then((data) => !cancelled && setState({ range, data, loading: false }))
      .catch((e) => !cancelled && setState((s) => ({ ...s, error: String(e), loading: false })));
    return () => {
      cancelled = true;
    };
  }, [range, nonce]);

  const change = (r: TimeRange) => {
    setRange(r);
    saveTimeRange(r);
  };

  const data = state.data;
  const points = data?.days ?? range;
  const activeDays = data?.daily.filter((d) => d.seconds > 0).length ?? 0;
  const best = data?.daily.reduce<{ date: string; seconds: number } | null>((m, d) => (!m || d.seconds > m.seconds ? d : m), null);
  const commits = data?.projects.reduce((a, p) => a + p.commits, 0) ?? 0;
  const projectMax = Math.max(0, ...(data?.projects.map((p) => p.seconds) ?? []));
  const commitMax = Math.max(0, ...(data?.projects.map((p) => p.commits) ?? []));
  const wsMax = Math.max(0, ...(data?.workspaces.map((w) => w.seconds) ?? []));

  const kpis: [string, string][] = data
    ? [
        [`${points} derniers jours`, hm(data.totalSeconds)],
        ["Moyenne par jour actif", activeDays ? hm(data.totalSeconds / activeDays) : "—"],
        ["Jours actifs", `${activeDays} / ${points}`],
        ["Record", best && best.seconds > 0 ? `${hm(best.seconds)} · ${fmtShort.format(new Date(`${best.date}T00:00:00`))}` : "—"],
        ["Commits", String(commits)],
      ]
    : [];

  return (
    <div className="grid gap-4">
      <section className="rounded-xl border bg-card p-4">
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <BarChart3 className="size-4 text-primary" />
          <h3 className="text-sm font-semibold">Temps d'activité</h3>
          <span className="meta">sessions de workspace et scripts lancés depuis DevCenter</span>
          <div className="ml-auto flex items-center gap-2">
            {state.loading && data && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
            <TimeRangePicker value={range} onChange={change} />
            <RefreshButton onClick={() => setNonce((n) => n + 1)} loading={state.loading} label="Actualiser les statistiques" className="size-7" />
          </div>
        </div>
        {state.error && <p className="mb-3 text-sm text-destructive">{state.error}</p>}
        {!data ? (
          !state.error && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" /> Calcul des statistiques…
            </p>
          )
        ) : (
          <>
            <dl className="mb-5 flex flex-wrap gap-x-10 gap-y-3">
              {kpis.map(([label, value]) => (
                <div key={label}>
                  <dt className="eyebrow text-[10px]">{label}</dt>
                  <dd className="mt-1 font-mono text-xl font-semibold tabular-nums">{value}</dd>
                </div>
              ))}
            </dl>
            <DailyTimeBars stats={data} points={points} className={cn("h-32 flex-none", state.loading && "opacity-50")} />
            <div className="mt-1.5 flex justify-between font-mono text-[10px] text-muted-foreground">
              <span>{fmtShort.format(new Date(data.from * 1000))}</span>
              <span>aujourd'hui</span>
            </div>
          </>
        )}
      </section>

      {data && (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
          <Panel title="Par projet" aside={<span className="meta">{plural(data.projects.length, "projet")}</span>}>
            {data.projects.length === 0 ? (
              <p className="text-sm text-muted-foreground">Aucune activité sur la période.</p>
            ) : (
              <ul className="grid gap-3.5">
                {data.projects.map((p) => (
                  <li key={p.id} className="grid gap-1">
                    <div className="flex items-center justify-between gap-3 text-sm">
                      <Link to={`/projects?project=${p.id}`} className="truncate font-medium hover:text-primary">
                        {p.name}
                      </Link>
                      <span className="shrink-0 font-mono tabular-nums">{p.seconds ? hm(p.seconds) : "—"}</span>
                    </div>
                    <Share value={p.seconds} max={projectMax} />
                    <div className="flex items-center gap-3">
                      <p className="meta min-w-0 flex-1 truncate">
                        {[p.sessions && plural(p.sessions, "session"), p.runs && plural(p.runs, "script"), plural(p.commits, "commit")].filter(Boolean).join(" · ")}
                      </p>
                      <div className="w-24 shrink-0" title={`${plural(p.commits, "commit")}`}>
                        <Share value={p.commits} max={commitMax} muted />
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
          <Panel title="Par workspace" aside={<span className="meta">{plural(data.workspaces.length, "workspace")}</span>}>
            {data.workspaces.length === 0 ? (
              <p className="text-sm text-muted-foreground">Aucune session sur la période.</p>
            ) : (
              <ul className="grid gap-3.5">
                {data.workspaces.map((w) => (
                  <li key={`${w.id ?? "x"}:${w.name}`} className="grid gap-1">
                    <div className="flex items-center justify-between gap-3 text-sm">
                      {w.id !== null && onSelectWorkspace ? (
                        <button type="button" onClick={() => onSelectWorkspace(w.id!)} className="truncate text-left font-medium hover:text-primary">
                          {w.name}
                        </button>
                      ) : (
                        <span className={cn("truncate", w.id === null && "text-muted-foreground")} title={w.id === null ? "Workspace supprimé" : undefined}>
                          {w.name}
                        </span>
                      )}
                      <span className="shrink-0 font-mono tabular-nums">{hm(w.seconds)}</span>
                    </div>
                    <Share value={w.seconds} max={wsMax} />
                    <p className="meta">{plural(w.sessions, "session")}</p>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      )}
    </div>
  );
}
