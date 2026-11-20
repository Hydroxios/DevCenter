import { Link } from "react-router";

import { cn } from "@/lib/utils";
import { api } from "@/services/tauri";
import type { Server } from "@/types";
import { RefreshButton } from "../activity";
import { useWidgetPolling } from "./polling";

/** Une connexion SSH par serveur : intervalle volontairement long. */
const PING_MS = 60_000;

type PingResult = { ok: true; ms: number } | { ok: false; error: string };

/** Tous les serveurs testés en parallèle ; un serveur injoignable n'empêche pas les autres. */
async function pingAll(): Promise<Record<number, PingResult>> {
  const servers = await api.servers.list();
  const results = await Promise.all(
    servers.map((s) =>
      api.servers
        .ping(s.id)
        .then((ms): [number, PingResult] => [s.id, { ok: true, ms }])
        .catch((e): [number, PingResult] => [s.id, { ok: false, error: String(e) }]),
    ),
  );
  return Object.fromEntries(results);
}

function latencyTone(ms: number) {
  return ms < 150 ? "text-success" : ms < 500 ? "text-warning" : "text-destructive";
}

/** Serveurs SSH enregistrés : en ligne / hors ligne et latence ; un clic ouvre la page Serveurs. */
export function ServersBody() {
  const list = useWidgetPolling<Server[]>("servers:list", api.servers.list, PING_MS);
  const pings = useWidgetPolling("servers:ping", pingAll, PING_MS);
  const servers = list.data;

  if (list.error && !servers) return <p className="text-sm text-destructive">{list.error}</p>;
  if (!servers) return <p className="text-sm text-muted-foreground">Chargement…</p>;
  if (servers.length === 0)
    return (
      <p className="text-sm text-muted-foreground">
        Aucun serveur.{" "}
        <Link to="/servers" className="text-primary hover:underline">
          Ajouter un serveur
        </Link>
      </p>
    );

  const results = pings.data ?? {};
  const online = servers.filter((s) => results[s.id]?.ok).length;
  const tested = servers.filter((s) => results[s.id]).length;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
        <span className="truncate">
          {tested === 0 ? (
            "Test des connexions…"
          ) : (
            <>
              <span className="font-mono text-foreground tabular-nums">{online}</span>/{servers.length} en ligne
            </>
          )}
        </span>
        <RefreshButton
          onClick={() => {
            list.refresh();
            pings.refresh();
          }}
          loading={pings.loading}
          label="Tester à nouveau les serveurs"
          className="size-5"
        />
      </div>
      <ul className="grid min-h-0 content-start gap-1 overflow-y-auto">
        {servers.map((s) => {
          const r = results[s.id];
          const target = `${s.user ? `${s.user}@` : ""}${s.host}${s.port !== 22 ? `:${s.port}` : ""}`;
          return (
            <li key={s.id}>
              <Link
                to="/servers"
                title={r && !r.ok ? r.error : `Ouvrir ${s.name}`}
                className="flex items-center gap-3 rounded-lg border bg-background/40 px-3 py-2 transition-colors hover:border-primary/40 hover:bg-primary/5"
              >
                <span
                  className={cn(
                    "size-2 shrink-0 rounded-full",
                    !r ? "animate-pulse bg-muted-foreground/40" : r.ok ? "bg-success" : "bg-destructive",
                  )}
                  aria-label={!r ? "Test en cours" : r.ok ? "En ligne" : "Hors ligne"}
                />
                <span className="min-w-0 flex-1 truncate text-sm">
                  <span className="font-medium">{s.name}</span>
                  <span className="ml-2 font-mono text-xs text-muted-foreground">{target}</span>
                </span>
                <span className={cn("shrink-0 font-mono text-xs tabular-nums", r?.ok ? latencyTone(r.ms) : "text-muted-foreground")}>
                  {!r ? "…" : r.ok ? `${r.ms} ms` : "hors ligne"}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
