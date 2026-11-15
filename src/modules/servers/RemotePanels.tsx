import { useCallback, useEffect, useMemo, useState } from "react";
import { Box, Clock, Cpu, FileText, HardDrive, Loader2, MemoryStick, Play, RefreshCw, RotateCw, Search, Square } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { usePolling } from "@/hooks/usePolling";
import { cn, formatBytes, formatDuration } from "@/lib/utils";
import { api } from "@/services/tauri";
import type { Container, RemoteAction, RemoteMetrics, RemoteService, Server } from "@/types";
import { remoteCache } from "./remoteCache";

// ------------------------------------------------------------------ Aperçu

export function OverviewPanel({ server }: { server: Server }) {
  const fetcher = useCallback(() => api.servers.metrics(server.id), [server.id]);
  const cacheKey = `metrics:${server.id}`;
  const { data: m, error } = usePolling(fetcher, 5000, true, {
    initial: remoteCache.get<RemoteMetrics>(cacheKey),
    onData: (d) => remoteCache.set(cacheKey, d),
  });

  if (error && !m) return <p className="text-sm text-destructive">{error}</p>;
  if (!m) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Connexion et lecture des métriques…
      </p>
    );
  }

  const memPct = m.memoryTotal ? (m.memoryUsed / m.memoryTotal) * 100 : 0;
  return (
    <div className="grid gap-4">
      {error && <p className="text-sm text-warning">Dernière mise à jour en échec : {error}</p>}
      <p className="text-sm text-muted-foreground">
        <span className="font-medium text-foreground">{m.hostname}</span> · {m.os} · noyau {m.kernel} · latence {m.latencyMs} ms
      </p>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>Processeur</CardTitle>
            <Cpu className="size-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">{m.cpuUsage.toFixed(0)} %</p>
            <Progress value={m.cpuUsage} />
            <p className="text-xs text-muted-foreground tabular-nums">
              {m.cpuCores} cœurs · charge {m.load.map((l) => l.toFixed(2)).join(" / ")}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Mémoire</CardTitle>
            <MemoryStick className="size-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">{memPct.toFixed(0)} %</p>
            <Progress value={memPct} />
            <p className="text-xs text-muted-foreground tabular-nums">
              {formatBytes(m.memoryUsed)} / {formatBytes(m.memoryTotal)}
              {m.swapTotal > 0 && ` · swap ${formatBytes(m.swapUsed)}`}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>En ligne depuis</CardTitle>
            <Clock className="size-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">{formatDuration(m.uptimeSecs)}</p>
            <div className="flex gap-1.5">
              <Badge variant={m.systemd ? "success" : "outline"}>systemd</Badge>
              <Badge variant={m.docker ? "success" : "outline"}>Docker</Badge>
            </div>
          </CardContent>
        </Card>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Stockage</CardTitle>
          <HardDrive className="size-4 text-muted-foreground" />
        </CardHeader>
        <CardContent className="gap-4">
          {m.disks.map((d) => (
            <div key={d.mount} className="grid gap-1.5">
              <div className="flex items-baseline justify-between text-sm">
                <span className="font-medium">{d.mount}</span>
                <span className="text-xs text-muted-foreground tabular-nums">
                  {formatBytes(d.totalBytes - d.usedBytes)} libres sur {formatBytes(d.totalBytes)}
                </span>
              </div>
              <Progress value={(d.usedBytes / d.totalBytes) * 100} />
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

// ------------------------------------------------------------------ Logs

export function LogsDialog({ title, load, onClose }: { title: string | null; load: () => Promise<string>; onClose: () => void }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    setError(null);
    load().then(setText).catch((e) => setError(String(e)));
  }, [load]);

  useEffect(() => {
    if (title) {
      setText(null);
      refresh();
    }
  }, [title, refresh]);

  return (
    <Dialog open={title !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-4xl">
        <DialogHeader className="flex-row items-center gap-2 pr-8">
          <DialogTitle className="min-w-0 flex-1 truncate">Logs · {title}</DialogTitle>
          <Button variant="ghost" size="icon" className="size-8" onClick={refresh} aria-label="Actualiser">
            <RefreshCw />
          </Button>
        </DialogHeader>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <pre
          ref={(el) => {
            if (el) el.scrollTop = el.scrollHeight;
          }}
          className="h-[60vh] overflow-auto rounded-lg border bg-black p-3 font-mono text-xs leading-relaxed text-[#d4d4d8] select-text"
        >
          {text ?? (error ? "" : "Chargement…")}
        </pre>
      </DialogContent>
    </Dialog>
  );
}

// ------------------------------------------------------------------ Actions partagées

function ActionButtons({
  running,
  busy,
  onAction,
  onLogs,
}: {
  running: boolean;
  busy: boolean;
  onAction: (a: RemoteAction) => void;
  onLogs: () => void;
}) {
  return (
    <div className="flex shrink-0 items-center">
      {busy ? (
        <Loader2 className="mx-2 size-4 animate-spin text-muted-foreground" />
      ) : running ? (
        <>
          <Button variant="ghost" size="icon" className="size-8" onClick={() => onAction("restart")} aria-label="Redémarrer" title="Redémarrer">
            <RotateCw />
          </Button>
          <Button variant="ghost" size="icon" className="size-8 hover:text-destructive" onClick={() => onAction("stop")} aria-label="Arrêter" title="Arrêter">
            <Square />
          </Button>
        </>
      ) : (
        <Button variant="ghost" size="icon" className="size-8" onClick={() => onAction("start")} aria-label="Démarrer" title="Démarrer">
          <Play />
        </Button>
      )}
      <Button variant="ghost" size="icon" className="size-8" onClick={onLogs} aria-label="Logs" title="Logs">
        <FileText />
      </Button>
    </div>
  );
}

/** Liste distante : affichée depuis le cache, puis rafraîchie en arrière-plan. */
function useRemoteList<T>(cacheKey: string, load: () => Promise<T[]>) {
  const [items, setItems] = useState<T[] | null>(() => remoteCache.get<T[]>(cacheKey) ?? null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const next = await load();
      remoteCache.set(cacheKey, next);
      setItems(next);
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [load, cacheKey]);
  useEffect(() => {
    refresh();
  }, [refresh]);
  return { items, error, setError, loading, refresh };
}

const ACTION_LABEL: Record<RemoteAction, string> = { start: "démarré", stop: "arrêté", restart: "redémarré" };

// ------------------------------------------------------------------ Services

export function ServicesPanel({ server }: { server: Server }) {
  const load = useCallback(() => api.servers.services(server.id), [server.id]);
  const { items, error, setError, loading, refresh } = useRemoteList<RemoteService>(`services:${server.id}`, load);
  const [query, setQuery] = useState("");
  const [onlyActive, setOnlyActive] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [logsFor, setLogsFor] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (items ?? []).filter(
      (s) => (!onlyActive || s.active === "active") && (!q || s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q)),
    );
  }, [items, query, onlyActive]);

  const act = async (name: string, action: RemoteAction) => {
    setBusy(name);
    setMessage(null);
    try {
      await api.servers.serviceAction(server.id, name, action);
      setMessage(`${name} ${ACTION_LABEL[action]}.`);
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const loadLogs = useCallback(() => api.servers.serviceLogs(server.id, logsFor ?? ""), [server.id, logsFor]);

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-64">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filtrer…" className="pl-8" aria-label="Filtrer les services" />
        </div>
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <input type="checkbox" className="accent-[var(--primary)]" checked={onlyActive} onChange={(e) => setOnlyActive(e.target.checked)} />
          Actifs uniquement
        </label>
        <Button variant="ghost" size="icon" className="ml-auto size-8" onClick={refresh} disabled={loading} aria-label="Actualiser">
          <RefreshCw className={cn(loading && "animate-spin")} />
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">Les actions utilisent <code>sudo -n</code> : elles nécessitent un sudo sans mot de passe pour systemctl.</p>
      {error && <p className="text-sm text-destructive">{error}</p>}
      {message && <p className="text-sm text-success">{message}</p>}
      {!items && !error && <p className="text-sm text-muted-foreground">Chargement…</p>}
      {items && (
        <ul className="max-h-[480px] divide-y overflow-y-auto rounded-lg border">
          {filtered.map((s) => (
            <li key={s.name} className="flex items-center gap-3 px-3 py-1.5">
              <span
                className={cn("size-2 shrink-0 rounded-full", s.active === "active" ? "bg-success" : s.active === "failed" ? "bg-destructive" : "bg-muted-foreground/40")}
                title={`${s.active} (${s.sub})`}
              />
              <div className="min-w-0 flex-1">
                <p className="truncate font-mono text-sm">{s.name.replace(/\.service$/, "")}</p>
                <p className="truncate text-xs text-muted-foreground">{s.description}</p>
              </div>
              <span className="w-20 shrink-0 text-xs text-muted-foreground">{s.sub}</span>
              <ActionButtons running={s.active === "active"} busy={busy === s.name} onAction={(a) => act(s.name, a)} onLogs={() => setLogsFor(s.name)} />
            </li>
          ))}
          {filtered.length === 0 && <li className="px-3 py-4 text-center text-sm text-muted-foreground">Aucun service.</li>}
        </ul>
      )}
      <LogsDialog title={logsFor} load={loadLogs} onClose={() => setLogsFor(null)} />
    </div>
  );
}

// ------------------------------------------------------------------ Docker

export function DockerPanel({ server }: { server: Server }) {
  const load = useCallback(() => api.servers.containers(server.id), [server.id]);
  const { items, error, setError, loading, refresh } = useRemoteList<Container>(`docker:${server.id}`, load);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [logsFor, setLogsFor] = useState<Container | null>(null);

  const act = async (c: Container, action: RemoteAction) => {
    setBusy(c.id);
    setMessage(null);
    try {
      await api.servers.containerAction(server.id, c.id, action);
      setMessage(`${c.name} ${ACTION_LABEL[action]}.`);
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const loadLogs = useCallback(() => api.servers.containerLogs(server.id, logsFor?.id ?? ""), [server.id, logsFor]);

  return (
    <div className="grid gap-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">{items ? `${items.length} conteneur(s)` : "Chargement…"}</p>
        <Button variant="ghost" size="icon" className="size-8" onClick={refresh} disabled={loading} aria-label="Actualiser">
          <RefreshCw className={cn(loading && "animate-spin")} />
        </Button>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      {message && <p className="text-sm text-success">{message}</p>}
      {items && items.length === 0 && (
        <p className="rounded-lg border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">Aucun conteneur sur ce serveur.</p>
      )}
      {items && items.length > 0 && (
        <ul className="divide-y rounded-lg border">
          {items.map((c) => (
            <li key={c.id} className="flex items-center gap-3 px-3 py-2">
              <Box className={cn("size-4 shrink-0", c.state === "running" ? "text-success" : "text-muted-foreground")} />
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-2 text-sm">
                  <span className="truncate font-medium">{c.name}</span>
                  <span className="truncate text-xs text-muted-foreground">{c.image}</span>
                </p>
                <p className="truncate text-xs text-muted-foreground" title={c.ports}>
                  {c.status}
                  {c.ports && ` · ${c.ports}`}
                </p>
              </div>
              <ActionButtons running={c.state === "running"} busy={busy === c.id} onAction={(a) => act(c, a)} onLogs={() => setLogsFor(c)} />
            </li>
          ))}
        </ul>
      )}
      <LogsDialog title={logsFor?.name ?? null} load={loadLogs} onClose={() => setLogsFor(null)} />
    </div>
  );
}
