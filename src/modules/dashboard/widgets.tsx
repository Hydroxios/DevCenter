import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ArrowUpRight, Loader2, Play, Square, Star, X } from "lucide-react";

import { Progress } from "@/components/ui/progress";
import { usePolling } from "@/hooks/usePolling";
import { cn, formatBytes, formatDuration, formatRelative } from "@/lib/utils";
import { api, isTauri } from "@/services/tauri";
import { useRuns } from "@/stores/runs";
import { useWorkspaces } from "@/stores/workspaces";
import { WorkspaceToggle } from "@/modules/workspaces/WorkspacesPage";
import { ActivityView, ContributionGrid, GRID_GAP, GRID_LEFT, GridLegend, RefreshButton, dayKey, streaks } from "./activity";
import { UsageBars, UsageView, compact, rangeLabel, usageDays, usd } from "./usage";
import { USAGE_RANGES, hasHistory, pointsOf } from "./config";
import type { ChartStyle, DashboardData, ProcessSort, UsageRange, WidgetSettings } from "./config";

/* ------------------------------------------------------------------ */
/* Briques communes                                                    */
/* ------------------------------------------------------------------ */

export function WidgetLink({ to, children = "Ouvrir" }: { to: string; children?: React.ReactNode }) {
  return (
    <Link to={to} className="flex items-center gap-0.5 text-xs text-muted-foreground transition-colors hover:text-primary">
      {children}
      <ArrowUpRight className="size-3" />
    </Link>
  );
}

/** Grand chiffre en mono, avec unité plus discrète. */
function BigValue({ value, unit, sub, fluid }: { value: string; unit?: string; sub?: React.ReactNode; fluid?: boolean }) {
  return (
    <div className="min-w-0">
      <p
        className={cn("font-mono leading-none font-semibold tracking-tight tabular-nums", !fluid && "text-3xl")}
        // Graphiques qui s'étirent : le chiffre suit la taille du widget (unités de conteneur).
        style={fluid ? { fontSize: "clamp(1.25rem, min(13cqw, 20cqh), 3.75rem)" } : undefined}
      >
        {value}
        {unit && <span className="ml-1 text-base font-normal text-muted-foreground">{unit}</span>}
      </p>
      {sub && <p className="meta mt-1.5 truncate">{sub}</p>}
    </div>
  );
}

/** Courbe d'historique 0–100 %, alignée à droite au démarrage, dans le style choisi. */
export function HistoryChart({
  history,
  points = 60,
  variant = "area",
  className,
}: {
  history: number[];
  points?: number;
  variant?: Exclude<ChartStyle, "gauge" | "none">;
  className?: string;
}) {
  const shown = history.slice(-points);
  const offset = points - shown.length;
  const xy = shown.map((v, i) => [offset + i, 100 - Math.max(0, Math.min(100, v))] as const);

  let line = "";
  if (xy.length > 1) {
    if (variant === "step") {
      // Palier horizontal jusqu'à la mesure suivante, puis saut vertical.
      line = `M${xy[0][0]},${xy[0][1]}` + xy.slice(1).map(([x, y], i) => `L${x},${xy[i][1]}L${x},${y}`).join("");
    } else if (variant === "smooth") {
      // Courbes de Bézier dont les points de contrôle sont à mi-chemin : lissé, sans dépasser les mesures.
      line =
        `M${xy[0][0]},${xy[0][1]}` +
        xy
          .slice(1)
          .map(([x, y], i) => {
            const [px, py] = xy[i];
            const mx = (px + x) / 2;
            return `C${mx},${py} ${mx},${y} ${x},${y}`;
          })
          .join("");
    } else {
      line = `M${xy.map(([x, y]) => `${x},${y}`).join("L")}`;
    }
  }
  const filled = variant === "area" || variant === "smooth" || variant === "step";
  const area = line && filled ? `${line}L${points - 1},100L${offset},100Z` : "";

  return (
    <svg
      viewBox={`0 0 ${points - 1} 100`}
      preserveAspectRatio="none"
      className={cn("w-full rounded-sm border border-primary/15 bg-primary/5", className)}
      aria-hidden
    >
      {[25, 50, 75].map((y) => (
        <line key={y} x1={0} x2={points - 1} y1={y} y2={y} className="stroke-primary/10" vectorEffect="non-scaling-stroke" />
      ))}
      {variant === "bars" ? (
        xy.map(([x, y]) => <rect key={x} x={x - 0.36} y={y} width={0.72} height={100 - y} className="fill-primary/70" />)
      ) : (
        <>
          {area && <path d={area} className="fill-primary/20" />}
          {line && (
            <path
              d={line}
              fill="none"
              className="stroke-primary"
              strokeWidth={variant === "line" ? 1.75 : 1.25}
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
          )}
        </>
      )}
    </svg>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className="eyebrow text-[10px]">{label}</p>
      <p className="truncate font-mono text-sm tabular-nums">{value}</p>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  // Un message d'attente ou d'absence n'est jamais agrandi (voir AutoFit).
  return <p data-fit-max="1" className="text-sm text-muted-foreground">{children}</p>;
}

/**
 * Ajuste le contenu à la taille du widget : on cherche l'échelle la plus grande (bornée) pour
 * laquelle le contenu, remis en page à la largeur correspondante, tient en hauteur.
 * Tout est fait directement sur le DOM, sans re-rendu React.
 */
const FIT_MIN = 0.5;
// Jamais agrandi : le texte garde sa taille normale, seul le rétrécissement sert à tenir dans le widget.
const FIT_MAX = 1;

export function AutoFit({ children, center = true }: { children: React.ReactNode; center?: boolean }) {
  const outer = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const fitRef = useRef<() => void>(() => {});

  fitRef.current = () => {
    const o = outer.current;
    const i = inner.current;
    if (!o || !i) return;
    const W = o.clientWidth;
    const H = o.clientHeight;
    if (!W || !H) return;
    // Tient si la hauteur rentre. Au-delà de la taille normale, on n'agrandit que tant qu'aucun
    // texte n'est coupé (« … ») ; en dessous, les noms longs restent tronqués comme d'habitude.
    const truncated = Array.from(i.querySelectorAll<HTMLElement>(".truncate"));
    const fits = (k: number) => {
      i.style.width = `${W / k}px`;
      if (i.offsetHeight * k > H + 0.5) return false;
      return k <= 1 || truncated.every((el) => el.scrollWidth <= el.clientWidth + 1);
    };
    const cap = i.querySelector("[data-fit-max]") ? Number(i.querySelector("[data-fit-max]")!.getAttribute("data-fit-max")) : FIT_MAX;
    let best = FIT_MIN;
    if (fits(cap)) best = cap;
    else {
      let lo = FIT_MIN;
      let hi = cap;
      for (let n = 0; n < 9; n++) {
        const mid = (lo + hi) / 2;
        if (fits(mid)) lo = mid;
        else hi = mid;
      }
      best = lo;
    }
    i.style.width = `${W / best}px`;
    i.style.transform = `scale(${best})`;
    i.style.top = center ? `${Math.max(0, (H - i.offsetHeight * best) / 2)}px` : "0px";
  };

  // Après chaque rendu (nouvelles données) et à chaque redimensionnement du widget.
  useLayoutEffect(() => fitRef.current());
  useLayoutEffect(() => {
    const o = outer.current;
    if (!o) return;
    const ro = new ResizeObserver(() => fitRef.current());
    ro.observe(o);
    return () => ro.disconnect();
  }, []);

  return (
    <div ref={outer} className="relative min-h-0 flex-1 overflow-hidden">
      <div ref={inner} className="absolute top-0 left-0 flex origin-top-left flex-col gap-3">
        {children}
      </div>
    </div>
  );
}

/** Taille d'un élément, mise à jour quand il est redimensionné. */
function useSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size] as const;
}

const pct = (v: number) => `${v.toFixed(0)} %`;
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/* ------------------------------------------------------------------ */
/* Contenu des widgets                                                 */
/* ------------------------------------------------------------------ */

/**
 * Met son contenu à l'échelle pour qu'il tienne en largeur (jamais agrandi) ;
 * la hauteur occupée suit l'échelle, le reste du widget profite de la place libérée.
 */
function FitWidth({ children, className }: { children: React.ReactNode; className?: string }) {
  const outer = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const fitRef = useRef<() => void>(() => {});
  fitRef.current = () => {
    const o = outer.current;
    const i = inner.current;
    if (!o || !i) return;
    const k = Math.min(1, o.clientWidth / Math.max(1, i.offsetWidth));
    i.style.transform = `scale(${k})`;
    o.style.height = `${i.offsetHeight * k}px`;
  };
  useLayoutEffect(() => fitRef.current());
  useLayoutEffect(() => {
    const o = outer.current;
    if (!o) return;
    const ro = new ResizeObserver(() => fitRef.current());
    ro.observe(o);
    return () => ro.disconnect();
  }, []);
  return (
    <div ref={outer} className="relative shrink-0 overflow-hidden">
      <div ref={inner} className={cn("absolute top-0 left-0 w-max origin-top-left", className)}>
        {children}
      </div>
    </div>
  );
}

/** En dessous de cette largeur, l'en-tête du processeur passe sur deux lignes et rétrécit en bloc. */
const CPU_WIDE = 340;

export function CpuBody({ snap, info, history, settings }: DashboardData & { settings: WidgetSettings }) {
  const points = pointsOf(settings);
  const h = history.cpu.slice(-points);
  const [ref, { w }] = useSize<HTMLDivElement>();
  const value = snap ? snap.cpuUsage.toFixed(0) : "—";
  const stats = (
    <>
      <Stat label="Moyenne" value={h.length ? pct(avg(h)) : "—"} />
      <Stat label="Pic" value={h.length ? pct(Math.max(...h)) : "—"} />
      <Stat label="Threads" value={info ? String(info.cpuCores) : "—"} />
    </>
  );
  if (!hasHistory(settings.chart)) {
    // Sans courbe pour remplir la hauteur : contenu mis à l'échelle pour tenir, centré verticalement.
    return (
      <AutoFit center>
        <BigValue value={value} unit="%" sub={info?.cpuBrand} />
        <div className="grid grid-cols-3 gap-x-5">{stats}</div>
        {settings.chart === "gauge" && <Progress value={snap?.cpuUsage ?? 0} />}
      </AutoFit>
    );
  }
  return (
    <div ref={ref} className="flex min-h-0 flex-1 flex-col gap-3">
      {w === 0 || w >= CPU_WIDE ? (
        <div className="flex items-end justify-between gap-4">
          <BigValue fluid value={value} unit="%" sub={info?.cpuBrand} />
          <div className="grid shrink-0 grid-cols-3 gap-x-5 text-right">{stats}</div>
        </div>
      ) : (
        // Étroit : tout reste visible, le bloc est simplement réduit à la largeur du widget.
        <FitWidth className="grid max-w-56 gap-3">
          <BigValue value={value} unit="%" sub={info?.cpuBrand} />
          <div className="grid grid-cols-3 gap-x-5">{stats}</div>
        </FitWidth>
      )}
      <HistoryChart history={h} points={points} variant={settings.chart as Exclude<ChartStyle, "gauge" | "none">} className="min-h-0 flex-1" />
    </div>
  );
}

export function MemoryBody({ snap, history, settings }: DashboardData & { settings: WidgetSettings }) {
  const memPct = snap && snap.memoryTotal ? (snap.memoryUsed / snap.memoryTotal) * 100 : 0;
  const swapPct = snap && snap.swapTotal ? (snap.swapUsed / snap.swapTotal) * 100 : null;
  const chart = hasHistory(settings.chart);
  const value = (
    <BigValue
      fluid={chart}
      value={snap ? memPct.toFixed(0) : "—"}
      unit="%"
      sub={snap ? `${formatBytes(snap.memoryUsed)} / ${formatBytes(snap.memoryTotal)}` : undefined}
    />
  );
  const swap = swapPct !== null && snap && (
    <div className="grid gap-1">
      <div className="flex justify-between gap-2">
        <span className="eyebrow text-[10px]">Swap</span>
        <span className="meta truncate">
          {formatBytes(snap.swapUsed)} / {formatBytes(snap.swapTotal)}
        </span>
      </div>
      <Progress value={swapPct} />
    </div>
  );
  if (!chart) {
    // Sans courbe pour remplir la hauteur : contenu mis à l'échelle pour tenir, centré verticalement.
    return (
      <AutoFit center>
        {value}
        {settings.chart === "gauge" && <Progress value={memPct} />}
        {swap}
      </AutoFit>
    );
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      {value}
      <HistoryChart
        history={history.mem}
        points={pointsOf(settings)}
        variant={settings.chart as Exclude<ChartStyle, "gauge" | "none">}
        className="min-h-0 flex-1"
      />
      {swap}
    </div>
  );
}

export function SystemBody({ snap, info }: DashboardData) {
  return (
    <>
      <BigValue value={snap ? formatDuration(snap.uptimeSecs) : "—"} sub="Temps de fonctionnement" />
      <div className="mt-auto grid grid-cols-2 gap-3">
        <Stat label="Machine" value={info?.hostName ?? "—"} />
        <Stat label="Build" value={info?.kernelVersion ?? "—"} />
        <Stat label="OS" value={info?.osVersion ?? info?.osName ?? "—"} />
        <Stat label="Disques" value={snap ? String(snap.disks.filter((d) => d.totalBytes > 0).length) : "—"} />
      </div>
    </>
  );
}

/** Hauteur minimale d'une case de cœur (étiquette en surimpression comprise). */
const CORE_MIN_H = 16;

/**
 * Nombre de colonnes : des cases proches d'un format 2:1, 8 au maximum tant que la hauteur le
 * permet ; si le widget est trop bas, on ajoute des colonnes (jusqu'à une seule ligne).
 */
function coreColumns(n: number, W: number, H: number) {
  const GAP = 8;
  const cellH = (c: number) => {
    const r = Math.ceil(n / c);
    return (H - (r - 1) * GAP) / r;
  };
  let best = 0;
  let bestScore = Infinity;
  for (let c = 1; c <= Math.min(8, n); c++) {
    const ch = cellH(c);
    if (ch < CORE_MIN_H) continue;
    const score = Math.abs(Math.log((W - (c - 1) * GAP) / c / ch / 2.2));
    if (score < bestScore) {
      bestScore = score;
      best = c;
    }
  }
  if (best) return best;
  for (let c = 9; c <= n; c++) if (cellH(c) >= CORE_MIN_H) return c;
  return n;
}

export function CoresBody({ snap, history, settings }: DashboardData & { settings: WidgetSettings }) {
  const [ref, { w, h }] = useSize<HTMLDivElement>();
  const n = snap?.cpuPerCore.length ?? 0;
  const cols = n ? coreColumns(n, w, h) : 1;
  const mode = settings.chart ?? "area";
  return (
    <div ref={ref} className="min-h-0 flex-1">
      {!snap ? (
        <Empty>En attente des mesures…</Empty>
      ) : (
        <div
          className="grid h-full gap-2"
          style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${Math.ceil(n / cols)}, minmax(0, 1fr))` }}
          aria-label="Charge CPU par cœur"
        >
          {snap.cpuPerCore.map((v, i) => (
            // L'étiquette est posée sur le graphique : il garde toute la hauteur de la case, même très basse.
            <div
              key={i}
              className={cn("relative min-h-0 overflow-hidden rounded-sm", mode === "none" && "border border-primary/15")}
              title={`Cœur ${i} : ${v.toFixed(0)} %`}
            >
              {mode === "gauge" ? (
                <div className="absolute inset-0 bg-primary/8">
                  <div className="h-full bg-primary/45 transition-[width] duration-500" style={{ width: `${Math.max(0, Math.min(100, v))}%` }} />
                </div>
              ) : mode !== "none" ? (
                <HistoryChart history={history.cores[i] ?? []} points={pointsOf(settings)} variant={mode} className="absolute inset-0 h-full" />
              ) : null}
              {/* Case étroite : la valeur passe sur une 2e ligne, en bas à droite, au lieu de se couper. */}
              <div className="relative flex h-full flex-wrap content-between items-start gap-x-1 px-1 py-px font-mono text-[10px] leading-3 tabular-nums [text-shadow:0_0_3px_var(--card)]">
                <span className="whitespace-nowrap text-muted-foreground">#{i}</span>
                <span className="ml-auto whitespace-nowrap text-foreground">{v.toFixed(0)}%</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function StorageBody({ snap }: DashboardData) {
  const disks = (snap?.disks ?? []).filter((d) => d.totalBytes > 0);
  if (disks.length === 0) return <Empty>Aucun disque détecté.</Empty>;
  return (
    <>
      {disks.map((d) => {
        const used = ((d.totalBytes - d.availableBytes) / d.totalBytes) * 100;
        return (
          <div key={d.mountPoint} className="grid gap-1.5">
            <div className="flex items-baseline justify-between gap-2 text-sm">
              <span className="min-w-0 truncate font-medium">
                {d.mountPoint}
                {d.name && <span className="ml-2 font-normal text-muted-foreground">{d.name}</span>}
              </span>
              <span className="meta shrink-0">{pct(used)}</span>
            </div>
            <Progress value={used} />
            <p className="meta text-[11px]">
              {formatBytes(d.availableBytes)} libres sur {formatBytes(d.totalBytes)}
            </p>
          </div>
        );
      })}
    </>
  );
}

export function WorkspacesBody() {
  const workspaces = useWorkspaces((s) => s.workspaces);
  const error = useWorkspaces((s) => s.error);
  const shown = (workspaces ?? []).filter((w) => w.favorite || w.active);
  return (
    <>
      {shown.length === 0 ? (
        <Empty>Marquez un workspace d'une étoile pour le retrouver ici.</Empty>
      ) : (
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-2">
          {shown.map((w) => (
            <li key={w.id} className="flex items-center gap-3 rounded-lg border bg-background/40 px-3 py-2">
              {w.active ? (
                <span className="size-2 shrink-0 animate-pulse rounded-full bg-success" title="Session en cours" />
              ) : (
                <Star className="size-4 shrink-0 fill-warning text-warning" />
              )}
              <span className="min-w-0 flex-1 truncate text-sm font-medium">{w.name}</span>
              <WorkspaceToggle workspace={w} size="sm" />
            </li>
          ))}
        </ul>
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}
    </>
  );
}

/** Nombre de scripts récents affichés sous ceux en cours. */
const RECENT_SHOWN = 6;

function ProjectLink({ id, name }: { id: number; name: string }) {
  return (
    <Link
      to={`/projects?project=${id}`}
      title="Ouvrir le projet"
      className="font-medium underline-offset-2 transition-colors hover:text-primary hover:underline"
    >
      {name}
    </Link>
  );
}

const rowBtn = "flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors";

export function RunsBody() {
  const runs = useRuns((s) => s.runs);
  const stop = useRuns((s) => s.stop);
  const start = useRuns((s) => s.start);
  const recentAll = useRuns((s) => s.recent);
  const forget = useRuns((s) => s.forgetRecent);
  const runError = useRuns((s) => s.error);
  const projects = useWorkspaces((s) => s.projects);
  const running = Object.values(runs)
    .filter((r) => r.status === "running")
    .sort((a, b) => b.startedAt - a.startedAt);
  const nameOf = (id: number) => projects.find((p) => p.id === id)?.name ?? `Projet ${id}`;
  const isRunning = (projectId: number, script: string) => running.some((r) => r.projectId === projectId && r.script === script);
  // Récents : hors scripts déjà en cours, et hors projets supprimés (une fois la liste chargée).
  const recent = recentAll
    .filter((r) => !isRunning(r.projectId, r.script))
    .filter((r) => projects.length === 0 || projects.some((p) => p.id === r.projectId))
    .slice(0, RECENT_SHOWN);

  if (running.length === 0 && recent.length === 0) return <Empty>Aucun script lancé récemment.</Empty>;
  return (
    <>
      {running.length > 0 && (
        <ul className="grid gap-2">
          {running.map((r) => (
            <li key={r.id} className="flex items-center gap-3 rounded-lg border bg-background/40 px-3 py-2">
              <span className="size-2 shrink-0 animate-pulse rounded-full bg-success" />
              <span className="min-w-0 flex-1 truncate text-sm">
                <ProjectLink id={r.projectId} name={nameOf(r.projectId)} />
                <span className="ml-2 font-mono text-xs text-muted-foreground">{r.script}</span>
              </span>
              {r.url && (
                <button type="button" onClick={() => openUrl(r.url!).catch(() => {})} className="meta shrink-0 hover:text-primary">
                  {r.url.replace(/^https?:\/\//, "")}
                </button>
              )}
              <span className="meta shrink-0">{formatRelative(r.startedAt)}</span>
              <button
                type="button"
                onClick={() => stop(r.id)}
                title="Arrêter le script"
                aria-label={`Arrêter ${r.script} (${nameOf(r.projectId)})`}
                className={cn(rowBtn, "-mr-1 hover:bg-destructive/15 hover:text-destructive")}
              >
                <Square className="size-3.5 fill-current" />
              </button>
            </li>
          ))}
        </ul>
      )}

      {recent.length > 0 && (
        <div className="grid gap-1.5">
          <p className="eyebrow text-[10px]">Récents</p>
          <ul className="grid gap-1">
            {recent.map((r) => (
              <li
                key={`${r.projectId}:${r.script}`}
                className="group flex items-center gap-3 rounded-lg px-3 py-1.5 transition-colors hover:bg-foreground/[0.03]"
              >
                <span className="size-2 shrink-0 rounded-full bg-muted-foreground/40" />
                <span className="min-w-0 flex-1 truncate text-sm">
                  <ProjectLink id={r.projectId} name={nameOf(r.projectId)} />
                  <span className="ml-2 font-mono text-xs text-muted-foreground">{r.script}</span>
                </span>
                <span className="meta shrink-0">{formatRelative(r.lastRunAt)}</span>
                <button
                  type="button"
                  onClick={() => forget(r.projectId, r.script)}
                  title="Retirer des récents"
                  aria-label={`Retirer ${r.script} (${nameOf(r.projectId)}) des récents`}
                  className={cn(rowBtn, "opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:bg-foreground/10 hover:text-foreground")}
                >
                  <X className="size-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => start(r.projectId, r.script)}
                  title="Relancer le script"
                  aria-label={`Relancer ${r.script} (${nameOf(r.projectId)})`}
                  className={cn(rowBtn, "-mr-1 hover:bg-success/15 hover:text-success")}
                >
                  <Play className="size-3.5 fill-current" />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {runError && <p className="text-xs text-destructive">{runError}</p>}
    </>
  );
}

/** Carte graphique et températures : interrogé seulement quand le widget est affiché. */
export function HardwareBody() {
  const { data, error } = usePolling(api.system.hardware, 3000, isTauri());
  if (error) return <p className="text-sm text-destructive">{error}</p>;
  if (!data) return <Empty>Chargement…</Empty>;
  const sensors = data.sensors.filter((s) => s.temperature !== null);
  // Température du GPU si un capteur la nomme, sinon la plus haute relevée.
  const gpuSensor =
    sensors.find((s) => /gpu/i.test(s.label)) ??
    sensors.reduce<(typeof sensors)[number] | null>((m, s) => (!m || s.temperature! > m.temperature! ? s : m), null);
  if (data.gpus.length === 0) return <Empty>Aucun GPU détecté.</Empty>;
  return (
    <>
      {data.gpus.map((g, i) => (
        <div key={i} className="grid gap-2">
          <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
            <BigValue
              value={g.usage !== null ? g.usage.toFixed(0) : "—"}
              unit="%"
              sub={g.model ?? g.vendor ?? `GPU ${i}`}
            />
            <div className="flex shrink-0 gap-5">
              {g.memoryTotal ? <Stat label="VRAM" value={formatBytes(g.memoryTotal)} /> : null}
              {i === 0 && gpuSensor && <Stat label="Temp." value={`${gpuSensor.temperature!.toFixed(0)} °C`} />}
            </div>
          </div>
          {g.usage !== null && <Progress value={g.usage} />}
        </div>
      ))}
    </>
  );
}

/** Processus les plus gourmands en CPU : interrogé seulement quand le widget est affiché. */
export function ProcessesBody({ count = 8, sort = "cpu" }: { count?: number; sort?: ProcessSort }) {
  // Tri et coupe faits côté Rust : seuls les `count` premiers processus traversent l'IPC.
  const { data: top, error } = usePolling(() => api.processes.list(sort, count), 3000, isTauri());
  if (error) return <p className="text-sm text-destructive">{error}</p>;
  if (!top) return <Empty>Chargement…</Empty>;
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="eyebrow text-[10px]">
          <th className="pb-1 text-left font-normal">Processus</th>
          <th className="w-16 pb-1 text-right font-normal">CPU</th>
          <th className="w-20 pb-1 text-right font-normal">Mémoire</th>
        </tr>
      </thead>
      <tbody>
        {top.map((p) => (
          <tr key={p.pid} className="border-t border-border/60">
            <td className="max-w-0 truncate py-1 pr-2">{p.name}</td>
            <td className="py-1 text-right font-mono text-xs tabular-nums">{p.cpuUsage.toFixed(1)} %</td>
            <td className="py-1 text-right font-mono text-xs text-muted-foreground tabular-nums">{formatBytes(p.memory)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/* ------------------------------------------------------------------ */
/* Activité : commits et ccusage                                       */
/* ------------------------------------------------------------------ */

const ACTIVITY_REFRESH_MS = 5 * 60_000;

/**
 * Données lentes à obtenir (git sur tous les dépôts, ccusage), gardées en mémoire pour la session :
 * en revenant sur le tableau de bord, le widget s'affiche aussitôt avec la dernière valeur, et la
 * relecture n'a lieu que lorsque celle-ci a dépassé l'intervalle de rafraîchissement.
 */
const pollCache = new Map<string, { at: number; data: unknown }>();

/**
 * Comme `usePolling`, avec le cache ci-dessus. Quand `key` change (autre période), les données
 * précédentes restent affichées pendant la lecture : `loading` le signale, sans écran d'attente.
 * `dataKey` indique à quelle clé correspondent les données affichées.
 */
function useCachedPolling<T>(key: string, fetcher: (force: boolean) => Promise<T>, intervalMs = ACTIVITY_REFRESH_MS) {
  const read = (k: string) => pollCache.get(k) as { at: number; data: T } | undefined;
  const [state, setState] = useState<{ data: T | null; dataKey: string | null; error: string | null; loading: boolean }>(() => {
    const hit = read(key);
    return { data: hit?.data ?? null, dataKey: hit ? key : null, error: null, loading: !hit };
  });
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const refreshRef = useRef<() => void>(() => {});
  const enabled = isTauri();

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let timer: number | undefined;
    const hit = read(key);
    // Données déjà en cache pour cette clé : affichées tout de suite ; sinon on garde les précédentes.
    setState((s) => (hit ? { data: hit.data, dataKey: key, error: null, loading: false } : { ...s, error: null, loading: true }));

    const tick = async (force = false) => {
      if (force || document.visibilityState === "visible") {
        try {
          const data = await fetcherRef.current(force);
          pollCache.set(key, { at: Date.now(), data });
          if (!cancelled) setState({ data, dataKey: key, error: null, loading: false });
        } catch (e) {
          if (!cancelled) setState((s) => ({ ...s, error: String(e), loading: false }));
        }
      }
      if (!cancelled) timer = window.setTimeout(tick, intervalMs);
    };
    const onVisible = () => {
      const fresh = read(key);
      if (document.visibilityState === "visible" && (!fresh || Date.now() - fresh.at >= intervalMs)) {
        window.clearTimeout(timer);
        tick();
      }
    };
    timer = window.setTimeout(tick, hit ? Math.max(0, intervalMs - (Date.now() - hit.at)) : 0);
    // Actualisation à la demande : relecture immédiate, sans cache (y compris côté Rust).
    refreshRef.current = () => {
      window.clearTimeout(timer);
      setState((s) => ({ ...s, error: null, loading: true }));
      tick(true);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [key, intervalMs, enabled]);

  const refresh = useCallback(() => refreshRef.current(), []);
  return { ...state, refresh };
}
const fetchCommits = () => api.activity.commits(371);

/** Grille de contributions façon profil GitHub ; un clic ouvre la vue Activité en plein écran. */
export function CommitsBody() {
  const { data, error, loading, refresh } = useCachedPolling("commits", fetchCommits);
  const [ref, { w, h }] = useSize<HTMLDivElement>();
  const [openDay, setOpenDay] = useState<Date | null>(null);
  const counts = useMemo(() => new Map(data?.days.map((d) => [d.date, d.count]) ?? []), [data]);

  const TOP = 14; // libellés des mois
  const FOOT = 20; // total et légende
  // Taille de case dictée par la hauteur, puis nombre de semaines qui tiennent en largeur (53 au plus).
  let cell = Math.max(4, Math.min(22, (h - TOP - FOOT) / 7 - GRID_GAP));
  let weeks = Math.floor((w - GRID_LEFT + GRID_GAP) / (cell + GRID_GAP));
  if (weeks > 53) {
    weeks = 53;
    cell = Math.max(4, (w - GRID_LEFT + GRID_GAP) / 53 - GRID_GAP);
  }
  weeks = Math.max(1, weeks);

  // Total sur les semaines affichées.
  const today = new Date();
  const from = new Date(today);
  from.setDate(today.getDate() - ((today.getDay() + 6) % 7) - (weeks - 1) * 7);
  const fromKey = dayKey(from);
  const total = data?.days.reduce((a, d) => (d.date >= fromKey ? a + d.count : a), 0) ?? 0;
  const { current } = streaks(counts);

  return (
    <div ref={ref} className="flex min-h-0 flex-1 items-center justify-center overflow-hidden">
      {error && !data ? (
        <p className="text-sm text-destructive">{error}</p>
      ) : !data ? (
        <Empty>Lecture des dépôts…</Empty>
      ) : (
        w > 0 && (
          // Largeur calée sur la grille : le pied ne peut pas déborder du widget.
          <div className="grid gap-1" style={{ width: GRID_LEFT + weeks * (cell + GRID_GAP) - GRID_GAP }}>
            <ContributionGrid counts={counts} weeks={weeks} cell={cell} onSelect={setOpenDay} />
            <div className="mt-1 flex min-w-0 items-center justify-between gap-3 text-[11px] text-muted-foreground" style={{ marginLeft: GRID_LEFT }}>
              <span className="min-w-0 truncate">
                <span className="font-mono text-foreground tabular-nums">{total}</span> commit{total > 1 ? "s" : ""} · {data.repos} dépôt
                {data.repos > 1 ? "s" : ""}
                {current > 0 && (
                  <>
                    {" "}
                    · série de <span className="font-mono text-foreground tabular-nums">{current}</span> j
                  </>
                )}
              </span>
              <span className="flex shrink-0 items-center gap-1.5">
                {/* Légende seulement s'il reste de la place à côté du total. */}
                {weeks * (cell + GRID_GAP) > 420 && <GridLegend />}
                <RefreshButton onClick={refresh} loading={loading} label="Actualiser les commits" className="size-5" />
              </span>
            </div>
          </div>
        )
      )}
      {data && <ActivityView activity={data} onRefresh={refresh} refreshing={loading} day={openDay} onDayChange={setOpenDay} onClose={() => setOpenDay(null)} />}
    </div>
  );
}

/** Coût et tokens Claude Code par jour, relevés par `ccusage` ; un clic sur une barre ouvre le détail. */
const RANGE_KEY = "devcenter.dashboard.ccusage.range";

function readRange(): UsageRange {
  try {
    const v = Number(localStorage.getItem(RANGE_KEY));
    return (USAGE_RANGES as readonly number[]).includes(v) ? (v as UsageRange) : 30;
  } catch {
    return 30;
  }
}

/** Widget Claude Code : la période se choisit directement sur le widget (mémorisée localement). */
export function CcusageWidget() {
  const [range, setRange] = useState<UsageRange>(readRange);
  const change = (r: UsageRange) => {
    setRange(r);
    try {
      localStorage.setItem(RANGE_KEY, String(r));
    } catch {
      /* stockage indisponible : période non conservée */
    }
  };
  return <CcusageBody points={range} onRange={change} />;
}

/** Sélecteur compact de période, posé sur le widget. */
function RangePicker({ value, onChange }: { value: UsageRange; onChange: (r: UsageRange) => void }) {
  return (
    <div className="inline-flex shrink-0 rounded-md border bg-background/40 p-px" role="radiogroup" aria-label="Période">
      {USAGE_RANGES.map((n) => (
        <button
          key={n}
          type="button"
          role="radio"
          aria-checked={value === n}
          title={rangeLabel(n)}
          onClick={() => onChange(n)}
          className={cn(
            "rounded-[5px] px-1.5 py-0.5 font-mono text-[10px] leading-none transition-colors",
            value === n ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {n === 365 ? "1a" : `${n}j`}
        </button>
      ))}
    </div>
  );
}

function CcusageBody({ points, onRange }: { points: UsageRange; onRange: (r: UsageRange) => void }) {
  // Au moins le mois en cours (statistique « Ce mois »).
  const needed = Math.max(points, 31);
  // Un relevé plus long encore frais couvre aussi cette période : inutile de relancer ccusage.
  const fetchDays =
    USAGE_RANGES.map((n) => Math.max(n, 31)).find((n) => {
      const hit = pollCache.get(`ccusage:${n}`);
      return n >= needed && hit && Date.now() - hit.at < ACTIVITY_REFRESH_MS;
    }) ?? needed;
  const usage = useCachedPolling(`ccusage:${fetchDays}`, (force) => api.activity.ccusage(fetchDays, force));
  const { data, dataKey, error, loading } = usage;
  // Jours réellement couverts par les données affichées (les précédentes pendant une lecture).
  const covered = dataKey ? Number(dataKey.split(":")[1]) : fetchDays;
  const totalPoll = useCachedPolling("ccusage:total", (force) => api.activity.ccusageTotal(force));
  const total = totalPoll.data;
  const refresh = () => {
    usage.refresh();
    totalPoll.refresh();
  };
  const [openDay, setOpenDay] = useState<Date | null>(null);
  if (error && !data) return <p className="text-sm text-destructive">{error}</p>;
  if (!data) return <Empty>Lancement de ccusage…</Empty>;

  const days = usageDays(data, points);
  const sum = (n: number) => days.slice(-n).reduce((a, d) => a + d.cost, 0);
  const monthKey = dayKey(new Date()).slice(0, 7);
  const month = data.daily.filter((d) => d.period.startsWith(monthKey)).reduce((a, d) => a + d.totalCost, 0);
  const last = days[days.length - 1];

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
        <BigValue value={usd(last.cost)} sub={`${compact.format(last.tokens)} tokens aujourd'hui`} />
        <div className="flex shrink-0 gap-5">
          <Stat label="7 jours" value={usd(sum(7))} />
          <Stat label={rangeLabel(points)} value={usd(sum(points))} />
          <Stat label="Ce mois" value={usd(month)} />
          <Stat label="Total" value={total ? usd(total.cost) : "…"} />
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-1.5">
        <div className="flex items-center justify-end gap-2">
          {loading && (
            <span className="flex items-center gap-1 text-[10px] text-muted-foreground" role="status">
              <Loader2 className="size-3 animate-spin" /> Lecture…
            </span>
          )}
          {error && !loading && (
            <span className="truncate text-[10px] text-destructive" title={error}>
              Échec de la lecture
            </span>
          )}
          <RangePicker value={points} onChange={onRange} />
          <RefreshButton onClick={refresh} loading={loading || totalPoll.loading} label="Actualiser ccusage" className="size-5" />
        </div>
        <UsageBars days={days} onSelect={setOpenDay} className={cn("transition-opacity", loading && "animate-pulse opacity-50")} />
      </div>
      <UsageView report={data} total={total} onRefresh={refresh} refreshing={loading || totalPoll.loading} covered={covered} initialRange={points} day={openDay} onDayChange={setOpenDay} onClose={() => setOpenDay(null)} />
    </>
  );
}
