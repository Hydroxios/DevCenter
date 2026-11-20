import { useMemo, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ArrowDown, ArrowUp, Copy, Globe, Hash, Lock, Play, Search, Square } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { contextMenu, copyText } from "@/components/ui/context-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { usePolling } from "@/hooks/usePolling";
import { cn } from "@/lib/utils";
import { api } from "@/services/tauri";
import type { ListeningPort } from "@/types";
import { portKey, portUrl, useRunLabel } from "./ports";

type SortKey = "port" | "process" | "pid";
type ProtoFilter = "all" | "tcp" | "udp";

const COLUMNS: { key: SortKey | null; label: string; className: string }[] = [
  { key: "port", label: "Port", className: "w-24 text-left" },
  { key: null, label: "Adresse", className: "w-40 text-left" },
  { key: "process", label: "Processus", className: "text-left" },
  { key: "pid", label: "PID", className: "w-20 text-right" },
];

/** Adresse lisible : « toutes » pour 0.0.0.0 / ::, sinon la liste des adresses. */
function addressLabel(addrs: string[]) {
  if (addrs.every((a) => a === "0.0.0.0" || a === "::")) return "toutes";
  if (addrs.every((a) => a === "127.0.0.1" || a === "::1")) return "locale";
  return addrs.join(", ");
}

function KillPortDialog({
  target,
  label,
  onClose,
  onDone,
}: {
  target: ListeningPort | null;
  label: string | null;
  onClose: () => void;
  onDone: (message: string, error: boolean) => void;
}) {
  const [busy, setBusy] = useState(false);

  const confirm = async () => {
    if (!target || target.startTime === null) return;
    setBusy(true);
    try {
      const res = await api.processes.kill(target.pid, target.startTime);
      onDone(
        res.killed
          ? `${res.name} (${res.pid}) arrêté, port ${target.port} libéré.`
          : `Windows a refusé d'arrêter ${res.name} (droits insuffisants ?).`,
        !res.killed,
      );
    } catch (e) {
      onDone(String(e), true);
    } finally {
      setBusy(false);
      onClose();
    }
  };

  return (
    <Dialog open={target !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            Arrêter {target?.processName ?? `le processus ${target?.pid}`} ?
          </DialogTitle>
          <DialogDescription>
            Le processus {target?.pid}, qui écoute sur le port {target?.port}, sera terminé immédiatement. Les données
            non enregistrées de cette application seront perdues.
          </DialogDescription>
        </DialogHeader>
        {label && (
          <p className="rounded-md bg-secondary px-3 py-2 text-xs">
            Lancé par DevCenter : <span className="font-medium">{label}</span>
          </p>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Annuler
          </Button>
          <Button variant="destructive" onClick={confirm} disabled={busy}>
            Arrêter le processus
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function PortsTable() {
  const { data, error } = usePolling(api.processes.ports, 3000);
  const runLabel = useRunLabel();
  const [query, setQuery] = useState("");
  const [proto, setProto] = useState<ProtoFilter>("tcp");
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "port", desc: false });
  const [target, setTarget] = useState<ListeningPort | null>(null);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = (data ?? []).filter((p) => {
      if (proto !== "all" && p.protocol !== proto) return false;
      if (!q) return true;
      return (
        String(p.port).includes(q) ||
        String(p.pid).includes(q) ||
        !!p.processName?.toLowerCase().includes(q) ||
        p.addresses.some((a) => a.includes(q)) ||
        !!runLabel(p)?.toLowerCase().includes(q)
      );
    });
    const dir = sort.desc ? -1 : 1;
    filtered.sort((a, b) => {
      const r =
        sort.key === "process"
          ? (a.processName ?? "").localeCompare(b.processName ?? "")
          : sort.key === "pid"
            ? a.pid - b.pid
            : a.port - b.port;
      return (r || a.port - b.port) * dir;
    });
    return filtered;
  }, [data, query, proto, sort, runLabel]);

  const toggleSort = (key: SortKey) => setSort((s) => (s.key === key ? { key, desc: !s.desc } : { key, desc: false }));
  const ask = (p: ListeningPort) => {
    setMessage(null);
    setTarget(p);
  };
  const canKill = (p: ListeningPort) => !p.protected && p.startTime !== null;

  return (
    <Card className="gap-3">
      <CardHeader className="items-center">
        <CardTitle>
          Ports en écoute {data && <span className="tabular-nums">({rows.length})</span>}
        </CardTitle>
        <div className="flex items-center gap-2">
          <Select
            value={proto}
            onChange={(e) => setProto(e.target.value as ProtoFilter)}
            className="w-28"
            aria-label="Protocole"
          >
            <option value="tcp">TCP</option>
            <option value="udp">UDP</option>
            <option value="all">Tous</option>
          </Select>
          <div className="relative w-64">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Port, processus, PID, projet…"
              className="pl-8"
              aria-label="Filtrer les ports"
            />
          </div>
        </div>
      </CardHeader>

      {message && (
        <p className={cn("text-sm", message.error ? "text-destructive" : "text-success")} role="status">
          {message.text}
        </p>
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="max-h-[520px] overflow-auto rounded-lg border">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-secondary text-xs text-muted-foreground">
            <tr>
              {COLUMNS.map((c) => (
                <th key={c.label} className={cn("px-3 py-2 font-medium", c.className)}>
                  {c.key ? (
                    <button
                      type="button"
                      onClick={() => toggleSort(c.key!)}
                      className="inline-flex items-center gap-1 hover:text-foreground"
                    >
                      {c.label}
                      {sort.key === c.key && (sort.desc ? <ArrowDown className="size-3" /> : <ArrowUp className="size-3" />)}
                    </button>
                  ) : (
                    c.label
                  )}
                </th>
              ))}
              <th className="w-20" aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {!data && !error && (
              <tr>
                <td colSpan={5} className="px-3 py-6 text-center text-muted-foreground">
                  Chargement…
                </td>
              </tr>
            )}
            {data && rows.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-6 text-center text-muted-foreground">
                  Aucun port ne correspond.
                </td>
              </tr>
            )}
            {rows.map((p) => {
              const label = runLabel(p);
              const tcp = p.protocol === "tcp";
              return (
                <tr
                  key={portKey(p)}
                  className="border-t hover:bg-accent/40"
                  onContextMenu={contextMenu(() => [
                    { heading: `${p.protocol.toUpperCase()} ${p.port} · ${p.processName ?? p.pid}` },
                    tcp && { label: "Ouvrir dans le navigateur", icon: Globe, onSelect: () => openUrl(portUrl(p.port)).catch(() => {}) },
                    {
                      label: canKill(p) ? "Arrêter le processus…" : "Processus protégé",
                      icon: canKill(p) ? Square : Lock,
                      danger: canKill(p),
                      disabled: !canKill(p),
                      onSelect: () => ask(p),
                    },
                    { separator: true },
                    { label: "Copier le port", icon: Hash, onSelect: () => copyText(String(p.port)) },
                    tcp && { label: "Copier l'URL", icon: Copy, onSelect: () => copyText(portUrl(p.port)) },
                    { label: "Copier le PID", icon: Hash, onSelect: () => copyText(String(p.pid)) },
                  ])}
                >
                  <td className="px-3 py-1.5">
                    <span className="font-mono tabular-nums">{p.port}</span>
                    <span className="ml-1.5 text-[10px] text-muted-foreground uppercase">{p.protocol}</span>
                  </td>
                  <td className="max-w-0 px-3 py-1.5 text-muted-foreground">
                    <div className="truncate font-mono text-xs" title={p.addresses.join(", ")}>
                      {addressLabel(p.addresses)}
                    </div>
                  </td>
                  <td className="max-w-0 px-3 py-1.5">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="truncate">{p.processName ?? "—"}</span>
                      {label && (
                        <Badge variant="primary" className="max-w-[60%] shrink-0" title="Script lancé par DevCenter">
                          <Play className="fill-current" />
                          <span className="truncate">{label}</span>
                        </Badge>
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">{p.pid}</td>
                  <td className="px-2 py-1.5 text-right whitespace-nowrap">
                    {tcp && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-8 text-muted-foreground hover:text-primary"
                        onClick={() => openUrl(portUrl(p.port)).catch(() => {})}
                        aria-label={`Ouvrir ${portUrl(p.port)}`}
                        title={`Ouvrir ${portUrl(p.port)}`}
                      >
                        <Globe />
                      </Button>
                    )}
                    {canKill(p) ? (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-8 text-muted-foreground hover:text-destructive"
                        onClick={() => ask(p)}
                        aria-label={`Arrêter ${p.processName ?? p.pid}`}
                        title="Arrêter le processus"
                      >
                        <Square />
                      </Button>
                    ) : (
                      <span
                        className="inline-flex size-8 items-center justify-center text-muted-foreground"
                        title="Processus protégé"
                      >
                        <Lock className="size-3.5" />
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <KillPortDialog
        target={target}
        label={target ? runLabel(target) : null}
        onClose={() => setTarget(null)}
        onDone={(text, err) => setMessage({ text, error: err })}
      />
    </Card>
  );
}
