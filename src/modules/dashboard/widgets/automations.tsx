import { useState } from "react";
import { Link } from "react-router";
import { Loader2, Play, Star } from "lucide-react";

import { cn, formatRelative } from "@/lib/utils";
import { api } from "@/services/tauri";
import type { Automation, AutomationRun, AutomationRunStatus } from "@/types";
import { readLocal, useWidgetPolling, writeLocal } from "./polling";

/** Lecture SQLite locale, peu coûteuse : suit les exécutions en cours de près. */
const AUTOMATIONS_MS = 10_000;
const RUNS_SHOWN = 12;
const FAVORITES_KEY = "devcenter.dashboard.automations.favorites";

const STATUS: Record<AutomationRunStatus, { label: string; dot: string }> = {
  running: { label: "En cours", dot: "animate-pulse bg-primary" },
  success: { label: "Réussie", dot: "bg-success" },
  failed: { label: "Échec", dot: "bg-destructive" },
  stopped: { label: "Condition non remplie", dot: "bg-muted-foreground/50" },
  timeout: { label: "Délai dépassé", dot: "bg-warning" },
};

function duration(run: AutomationRun) {
  const end = run.endedAt ?? Date.now() / 1000;
  const s = Math.max(0, end - run.startedAt);
  if (s < 1) return "< 1 s";
  if (s < 60) return `${Math.round(s)} s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m} min ${Math.round(s % 60)} s` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

const fetchAll = () =>
  Promise.all([api.automations.list(), api.automations.history(null, RUNS_SHOWN)]).then(([automations, runs]) => ({ automations, runs }));

const iconBtn = "flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors";

/** Dernières exécutions d'automatisations, et relance en un clic des favorites (étoile). */
export function AutomationsBody() {
  const { data, error, refresh } = useWidgetPolling("automations", fetchAll, AUTOMATIONS_MS);
  const [favorites, setFavorites] = useState<number[]>(() => readLocal<number[]>(FAVORITES_KEY, []));
  const [runError, setRunError] = useState<string | null>(null);
  const toggleFavorite = (id: number) =>
    setFavorites((prev) => {
      const next = prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id];
      writeLocal(FAVORITES_KEY, next);
      return next;
    });
  const run = (a: Automation) => {
    setRunError(null);
    api.automations
      .run(a.id)
      .then(() => refresh())
      .catch((e) => setRunError(`${a.name} : ${String(e)}`));
  };

  if (error && !data) return <p className="text-sm text-destructive">{error}</p>;
  if (!data) return <p className="text-sm text-muted-foreground">Chargement…</p>;
  if (data.automations.length === 0)
    return (
      <p className="text-sm text-muted-foreground">
        Aucune automatisation.{" "}
        <Link to="/automations" className="text-primary hover:underline">
          En créer une
        </Link>
      </p>
    );

  const byId = new Map(data.automations.map((a) => [a.id, a]));
  const favs = favorites.map((id) => byId.get(id)).filter((a): a is Automation => !!a);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="grid gap-1.5">
        <p className="eyebrow text-[10px]">Favorites</p>
        {favs.length === 0 ? (
          <p className="text-xs text-muted-foreground">Ajoutez une étoile à une exécution ci-dessous pour la relancer d'ici.</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {favs.map((a) => (
              <button
                key={a.id}
                type="button"
                onClick={() => run(a)}
                disabled={a.running}
                title={a.running ? "Déjà en cours" : `Lancer « ${a.name} »`}
                className="flex max-w-full items-center gap-1.5 rounded-md border bg-background/40 px-2 py-1 text-xs transition-colors enabled:hover:border-success/50 enabled:hover:bg-success/10 enabled:hover:text-success disabled:opacity-60"
              >
                {a.running ? <Loader2 className="size-3 shrink-0 animate-spin" /> : <Play className="size-3 shrink-0 fill-current" />}
                <span className="truncate">{a.name}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-1.5">
        <p className="eyebrow text-[10px]">Dernières exécutions</p>
        {data.runs.length === 0 ? (
          <p className="text-xs text-muted-foreground">Aucune exécution pour l'instant.</p>
        ) : (
          <ul className="grid min-h-0 content-start gap-1 overflow-y-auto">
            {data.runs.map((r) => {
              const a = r.automationId !== null ? byId.get(r.automationId) : undefined;
              const fav = a ? favorites.includes(a.id) : false;
              const st = STATUS[r.status];
              return (
                <li key={r.id} className="group flex items-center gap-2.5 rounded-lg px-2 py-1 transition-colors hover:bg-foreground/[0.03]">
                  <span className={cn("size-2 shrink-0 rounded-full", st.dot)} title={st.label} aria-label={st.label} />
                  <span className="min-w-0 flex-1 truncate text-sm">
                    {r.automationName}
                    <span className={cn("ml-2 text-xs", r.status === "failed" || r.status === "timeout" ? "text-destructive" : "text-muted-foreground")}>
                      {st.label}
                    </span>
                  </span>
                  <span className="meta shrink-0 tabular-nums">{duration(r)}</span>
                  <span className="meta w-20 shrink-0 truncate text-right">{formatRelative(r.startedAt)}</span>
                  {a && (
                    <>
                      <button
                        type="button"
                        onClick={() => toggleFavorite(a.id)}
                        title={fav ? "Retirer des favorites" : "Ajouter aux favorites"}
                        aria-pressed={fav}
                        aria-label={`${fav ? "Retirer" : "Ajouter"} « ${a.name} » ${fav ? "des" : "aux"} favorites`}
                        className={cn(
                          iconBtn,
                          "hover:bg-warning/15 hover:text-warning",
                          fav ? "text-warning" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
                        )}
                      >
                        <Star className={cn("size-3.5", fav && "fill-current")} />
                      </button>
                      <button
                        type="button"
                        onClick={() => run(a)}
                        disabled={a.running}
                        title={a.running ? "Déjà en cours" : "Relancer"}
                        aria-label={`Relancer « ${a.name} »`}
                        className={cn(iconBtn, "-mr-1 enabled:hover:bg-success/15 enabled:hover:text-success disabled:opacity-50")}
                      >
                        {a.running ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5 fill-current" />}
                      </button>
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {runError && <p className="truncate text-xs text-destructive" title={runError}>{runError}</p>}
    </div>
  );
}
