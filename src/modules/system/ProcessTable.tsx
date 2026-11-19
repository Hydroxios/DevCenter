import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Copy, FileText, Hash, Lock, Search, Square } from "lucide-react";

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
import { usePolling } from "@/hooks/usePolling";
import { cn, formatBytes, formatDuration } from "@/lib/utils";
import { api } from "@/services/tauri";
import type { ProcessInfo } from "@/types";

type SortKey = "name" | "pid" | "cpuUsage" | "memory";

const COLUMNS: { key: SortKey; label: string; className: string }[] = [
  { key: "name", label: "Nom", className: "text-left" },
  { key: "pid", label: "PID", className: "w-20 text-right" },
  { key: "cpuUsage", label: "CPU", className: "w-20 text-right" },
  { key: "memory", label: "Mémoire", className: "w-28 text-right" },
];

/** Nombre de lignes affichées : la recherche permet d'atteindre les autres. */
const MAX_ROWS = 200;

function KillDialog({
  target,
  onClose,
  onDone,
}: {
  target: ProcessInfo | null;
  onClose: () => void;
  onDone: (message: string, error: boolean) => void;
}) {
  const [busy, setBusy] = useState(false);

  const confirm = async () => {
    if (!target) return;
    setBusy(true);
    try {
      const res = await api.processes.kill(target.pid, target.startTime);
      onDone(
        res.killed ? `${res.name} (${res.pid}) arrêté.` : `Windows a refusé d'arrêter ${res.name} (droits insuffisants ?).`,
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
          <DialogTitle>Arrêter {target?.name} ?</DialogTitle>
          <DialogDescription>
            Le processus {target?.pid} sera terminé immédiatement. Les données non enregistrées de cette application
            seront perdues.
          </DialogDescription>
        </DialogHeader>
        {target?.exe && <p className="truncate rounded-md bg-secondary px-3 py-2 text-xs" title={target.exe}>{target.exe}</p>}
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

export function ProcessTable() {
  const { data, error } = usePolling(api.processes.list, 2000);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "cpuUsage", desc: true });
  const [target, setTarget] = useState<ProcessInfo | null>(null);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = (data ?? []).filter(
      (p) => !q || p.name.toLowerCase().includes(q) || String(p.pid).includes(q) || p.exe?.toLowerCase().includes(q),
    );
    const dir = sort.desc ? -1 : 1;
    filtered.sort((a, b) => {
      const av = a[sort.key];
      const bv = b[sort.key];
      return (typeof av === "string" ? av.localeCompare(bv as string) : (av as number) - (bv as number)) * dir;
    });
    return filtered;
  }, [data, query, sort]);

  const toggleSort = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, desc: !s.desc } : { key, desc: key !== "name" }));

  return (
    <Card className="gap-3">
      <CardHeader className="items-center">
        <CardTitle>
          Processus {data && <span className="tabular-nums">({data.length})</span>}
        </CardTitle>
        <div className="relative w-64">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Nom, PID ou chemin…"
            className="pl-8"
            aria-label="Filtrer les processus"
          />
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
                <th key={c.key} className={cn("px-3 py-2 font-medium", c.className)}>
                  <button
                    type="button"
                    onClick={() => toggleSort(c.key)}
                    className="inline-flex items-center gap-1 hover:text-foreground"
                  >
                    {c.label}
                    {sort.key === c.key && (sort.desc ? <ArrowDown className="size-3" /> : <ArrowUp className="size-3" />)}
                  </button>
                </th>
              ))}
              <th className="w-12" aria-label="Actions" />
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
            {rows.slice(0, MAX_ROWS).map((p) => (
              <tr
                key={`${p.pid}-${p.startTime}`}
                className="border-t hover:bg-accent/40"
                onContextMenu={contextMenu(() => [
                  { heading: `${p.name} · ${p.pid}` },
                  {
                    label: p.protected ? "Processus protégé" : "Arrêter…",
                    icon: p.protected ? Lock : Square,
                    danger: !p.protected,
                    disabled: p.protected,
                    onSelect: () => {
                      setMessage(null);
                      setTarget(p);
                    },
                  },
                  { separator: true },
                  { label: "Copier le nom", icon: Copy, onSelect: () => copyText(p.name) },
                  { label: "Copier le PID", icon: Hash, onSelect: () => copyText(String(p.pid)) },
                  !!p.exe && { label: "Copier le chemin", icon: FileText, onSelect: () => copyText(p.exe!) },
                ])}
              >
                <td className="max-w-0 px-3 py-1.5">
                  <div className="truncate" title={p.exe ?? p.name}>
                    {p.name}
                  </div>
                  {p.runTime > 0 && (
                    <div className="text-xs text-muted-foreground">depuis {formatDuration(p.runTime)}</div>
                  )}
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">{p.pid}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{p.cpuUsage.toFixed(1)} %</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{formatBytes(p.memory)}</td>
                <td className="px-2 py-1.5 text-right">
                  {p.protected ? (
                    <span className="inline-flex size-8 items-center justify-center text-muted-foreground" title="Processus protégé">
                      <Lock className="size-3.5" />
                    </span>
                  ) : (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-8 text-muted-foreground hover:text-destructive"
                      onClick={() => {
                        setMessage(null);
                        setTarget(p);
                      }}
                      aria-label={`Arrêter ${p.name}`}
                      title="Arrêter"
                    >
                      <Square />
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > MAX_ROWS && (
        <p className="text-xs text-muted-foreground">
          {MAX_ROWS} premiers affichés sur {rows.length}. Affinez la recherche pour voir les autres.
        </p>
      )}

      <KillDialog target={target} onClose={() => setTarget(null)} onDone={(text, err) => setMessage({ text, error: err })} />
    </Card>
  );
}
