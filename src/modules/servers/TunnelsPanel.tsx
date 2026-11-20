import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Copy, Loader2, Network, Pencil, Play, Plus, Square, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { confirmAction } from "@/components/ui/confirm";
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
import { cn } from "@/lib/utils";
import { api } from "@/services/tauri";
import type { Server, Tunnel, TunnelKind, TunnelState, TunnelStatus } from "@/types";

const KIND_LABEL: Record<TunnelKind, string> = {
  local: "Local (-L)",
  remote: "Distant (-R)",
  dynamic: "SOCKS (-D)",
};

const STATE: Record<TunnelState, { label: string; dot: string; badge: "success" | "warning" | "destructive" | "outline" }> = {
  running: { label: "actif", dot: "bg-success", badge: "success" },
  starting: { label: "connexion…", dot: "animate-pulse bg-primary", badge: "outline" },
  retrying: { label: "reconnexion…", dot: "animate-pulse bg-warning", badge: "warning" },
  error: { label: "erreur", dot: "bg-destructive", badge: "destructive" },
  stopped: { label: "arrêté", dot: "bg-muted-foreground/40", badge: "outline" },
};

const isActive = (s: TunnelStatus) => s.state === "running" || s.state === "starting" || s.state === "retrying";

/** Résumé lisible : « 127.0.0.1:5433 → localhost:5432 (serveur) ». */
export function tunnelRoute(t: Tunnel): string {
  const local = `${t.bindAddress}:${t.localPort}`;
  const remote = `${t.remoteHost ?? "localhost"}:${t.remotePort ?? "?"}`;
  switch (t.kind) {
    case "local":
      return `${local} → ${remote} (via le serveur)`;
    case "remote":
      return `serveur ${remote} → ${local} (ce PC)`;
    case "dynamic":
      return `SOCKS5 ${local}`;
  }
}

function Field({ label, hint, children, className }: { label: string; hint?: string; children: React.ReactNode; className?: string }) {
  return (
    <label className={cn("grid gap-1.5", className)}>
      <span className="text-sm font-medium">{label}</span>
      {children}
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </label>
  );
}

const digits = (v: string) => v.replace(/\D/g, "").slice(0, 5);

function TunnelDialog({
  server,
  tunnel,
  open,
  onOpenChange,
  onSaved,
}: {
  server: Server;
  tunnel: Tunnel | null;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onSaved: (list: Tunnel[]) => void;
}) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<TunnelKind>("local");
  const [bind, setBind] = useState("127.0.0.1");
  const [localPort, setLocalPort] = useState("");
  const [remoteHost, setRemoteHost] = useState("localhost");
  const [remotePort, setRemotePort] = useState("");
  const [autoStart, setAutoStart] = useState(false);
  const [autoRestart, setAutoRestart] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setName(tunnel?.name ?? "");
    setKind(tunnel?.kind ?? "local");
    setBind(tunnel?.bindAddress ?? "127.0.0.1");
    setLocalPort(tunnel ? String(tunnel.localPort) : "");
    setRemoteHost(tunnel?.remoteHost ?? "localhost");
    setRemotePort(tunnel?.remotePort ? String(tunnel.remotePort) : "");
    setAutoStart(tunnel?.autoStart ?? false);
    setAutoRestart(tunnel?.autoRestart ?? true);
  }, [open, tunnel]);

  const submit = async () => {
    setSaving(true);
    try {
      const list = await api.tunnels.save({
        id: tunnel?.id ?? null,
        serverId: server.id,
        name,
        kind,
        bindAddress: bind.trim() || null,
        localPort: Number(localPort) || 0,
        remoteHost: kind === "dynamic" ? null : remoteHost.trim() || null,
        remotePort: kind === "dynamic" ? null : Number(remotePort) || null,
        autoStart,
        autoRestart,
      });
      onSaved(list);
      onOpenChange(false);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const valid = name.trim() && Number(localPort) > 0 && (kind === "dynamic" || Number(remotePort) > 0);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{tunnel ? "Modifier le tunnel" : "Nouveau tunnel"}</DialogTitle>
          <DialogDescription>
            Redirection de port via <code>ssh -N</code> vers {server.name}, avec la même clé que le terminal. Aucun mot de passe n'est utilisé.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="grid grid-cols-[1fr_150px] gap-3">
            <Field label="Nom">
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="PostgreSQL prod" maxLength={80} />
            </Field>
            <Field label="Type">
              <Select value={kind} onChange={(e) => setKind(e.target.value as TunnelKind)}>
                {(Object.keys(KIND_LABEL) as TunnelKind[]).map((k) => (
                  <option key={k} value={k}>{KIND_LABEL[k]}</option>
                ))}
              </Select>
            </Field>
          </div>

          <p className="text-xs text-muted-foreground">
            {kind === "local" && "Un port de ce PC mène à une adresse vue depuis le serveur (ex. une base de données qui n'écoute qu'en local)."}
            {kind === "remote" && "Un port du serveur mène à un service de ce PC (ex. exposer un serveur de dev au serveur)."}
            {kind === "dynamic" && "Proxy SOCKS5 sur ce PC : le trafic des applications qui l'utilisent sort par le serveur."}
          </p>

          <div className="grid grid-cols-[1fr_96px] gap-3">
            <Field label={kind === "remote" ? "Destination sur ce PC" : "Adresse d'écoute (ce PC)"} hint={kind === "remote" ? undefined : "127.0.0.1 : accessible uniquement depuis ce PC"}>
              <Input value={bind} onChange={(e) => setBind(e.target.value)} placeholder="127.0.0.1" className="font-mono" />
            </Field>
            <Field label="Port local">
              <Input value={localPort} onChange={(e) => setLocalPort(digits(e.target.value))} inputMode="numeric" placeholder="5433" className="font-mono" />
            </Field>
          </div>

          {kind !== "dynamic" && (
            <div className="grid grid-cols-[1fr_96px] gap-3">
              <Field
                label={kind === "local" ? "Hôte de destination (vu du serveur)" : "Adresse d'écoute sur le serveur"}
                hint={kind === "local" ? "localhost = le serveur lui-même" : "localhost par défaut ; une autre adresse demande GatewayPorts côté sshd"}
              >
                <Input value={remoteHost} onChange={(e) => setRemoteHost(e.target.value)} placeholder="localhost" className="font-mono" />
              </Field>
              <Field label={kind === "local" ? "Port distant" : "Port serveur"}>
                <Input value={remotePort} onChange={(e) => setRemotePort(digits(e.target.value))} inputMode="numeric" placeholder="5432" className="font-mono" />
              </Field>
            </div>
          )}

          <div className="grid gap-2">
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              <input type="checkbox" className="accent-[var(--primary)]" checked={autoStart} onChange={(e) => setAutoStart(e.target.checked)} />
              Ouvrir au démarrage de DevCenter
            </label>
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              <input type="checkbox" className="accent-[var(--primary)]" checked={autoRestart} onChange={(e) => setAutoRestart(e.target.checked)} />
              Reconnecter automatiquement en cas de coupure (délai croissant jusqu'à 60 s)
            </label>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Annuler</Button>
          <Button onClick={submit} disabled={!valid || saving}>Enregistrer</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function TunnelsPanel({ server }: { server: Server }) {
  const [tunnels, setTunnels] = useState<Tunnel[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [dialog, setDialog] = useState<{ open: boolean; tunnel: Tunnel | null }>({ open: false, tunnel: null });

  const refresh = useCallback(() => {
    api.tunnels
      .list(server.id)
      .then((list) => {
        setTunnels(list);
        setError(null);
      })
      .catch((e) => setError(String(e)));
  }, [server.id]);

  useEffect(() => {
    refresh();
    // Statuts en direct (actif, erreur, reconnexion) poussés par le fil de surveillance Rust.
    const unlisten = listen<{ id: number; status: TunnelStatus }>("tunnel://status", (e) =>
      setTunnels((list) => list?.map((t) => (t.id === e.payload.id ? { ...t, status: e.payload.status } : t)) ?? list),
    );
    return () => {
      unlisten.then((f) => f());
    };
  }, [refresh]);

  const run = async (id: number, fn: () => Promise<unknown>) => {
    setBusy(id);
    try {
      await fn();
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };
  const start = (t: Tunnel) => run(t.id, () => api.tunnels.start(t.id));
  const stop = (t: Tunnel) => run(t.id, () => api.tunnels.stop(t.id));
  const remove = async (t: Tunnel) => {
    const ok = await confirmAction({ title: `Supprimer le tunnel ${t.name} ?`, description: "Le tunnel est fermé puis retiré de DevCenter.", confirmLabel: "Supprimer" });
    if (ok) await run(t.id, async () => setTunnels(await api.tunnels.remove(t.id)));
  };

  const menu = (t: Tunnel) =>
    contextMenu(() => [
      { heading: t.name },
      isActive(t.status)
        ? { label: "Fermer", icon: Square, danger: true, onSelect: () => stop(t) }
        : { label: "Ouvrir", icon: Play, onSelect: () => start(t) },
      { label: "Modifier…", icon: Pencil, onSelect: () => setDialog({ open: true, tunnel: t }) },
      { separator: true },
      t.kind !== "remote" && { label: "Copier l'adresse locale", icon: Copy, hint: `${t.bindAddress}:${t.localPort}`, onSelect: () => copyText(`${t.bindAddress}:${t.localPort}`) },
      { separator: true },
      { label: "Supprimer", icon: Trash2, danger: true, onSelect: () => remove(t) },
    ]);

  return (
    <div className="grid gap-3">
      <div className="flex items-center gap-2">
        <p className="text-sm text-muted-foreground">
          Redirections de ports via OpenSSH (<code>ssh -N</code>, authentification par clé). Les tunnels sont fermés à la fermeture de DevCenter.
        </p>
        <Button size="sm" className="ml-auto shrink-0" onClick={() => setDialog({ open: true, tunnel: null })}>
          <Plus /> Nouveau tunnel
        </Button>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      {!tunnels && !error && <p className="text-sm text-muted-foreground">Chargement…</p>}
      {tunnels && tunnels.length === 0 && (
        <div className="grid justify-items-center gap-2 rounded-lg border border-dashed px-3 py-8 text-center text-sm text-muted-foreground">
          <Network className="size-5" />
          Aucun tunnel. Exemple : accéder à PostgreSQL du serveur sur <code>localhost:5433</code>.
        </div>
      )}
      {tunnels && tunnels.length > 0 && (
        <ul className="divide-y rounded-lg border">
          {tunnels.map((t) => {
            const st = STATE[t.status.state];
            const active = isActive(t.status);
            return (
              <li key={t.id} className="flex items-center gap-3 px-3 py-2" onContextMenu={menu(t)}>
                <span className={cn("size-2 shrink-0 rounded-full", st.dot)} title={st.label} />
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-2 text-sm">
                    <span className="truncate font-medium">{t.name}</span>
                    <Badge variant="outline">{KIND_LABEL[t.kind]}</Badge>
                    <Badge variant={st.badge}>{st.label}</Badge>
                    {t.autoStart && <Badge variant="primary">auto</Badge>}
                  </p>
                  <p className="truncate font-mono text-xs text-muted-foreground">{tunnelRoute(t)}</p>
                  {t.status.message && (t.status.state === "error" || t.status.state === "retrying") && (
                    <p className={cn("text-xs", t.status.state === "error" ? "text-destructive" : "text-warning")}>{t.status.message}</p>
                  )}
                </div>
                <div className="flex shrink-0 items-center">
                  {busy === t.id ? (
                    <Loader2 className="mx-2 size-4 animate-spin text-muted-foreground" />
                  ) : active ? (
                    <Button variant="ghost" size="icon" className="size-8 hover:text-destructive" onClick={() => stop(t)} aria-label="Fermer le tunnel" title="Fermer">
                      <Square />
                    </Button>
                  ) : (
                    <Button variant="ghost" size="icon" className="size-8" onClick={() => start(t)} aria-label="Ouvrir le tunnel" title="Ouvrir">
                      <Play />
                    </Button>
                  )}
                  <Button variant="ghost" size="icon" className="size-8" onClick={() => setDialog({ open: true, tunnel: t })} aria-label="Modifier" title="Modifier">
                    <Pencil />
                  </Button>
                  <Button variant="ghost" size="icon" className="size-8 hover:text-destructive" onClick={() => remove(t)} aria-label="Supprimer" title="Supprimer">
                    <Trash2 />
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <TunnelDialog
        server={server}
        tunnel={dialog.tunnel}
        open={dialog.open}
        onOpenChange={(open) => setDialog((d) => ({ ...d, open }))}
        onSaved={setTunnels}
      />
    </div>
  );
}
