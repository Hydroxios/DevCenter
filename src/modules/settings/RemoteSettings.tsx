import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Bell, BellOff, Copy, Check, Smartphone, Trash2, Wifi } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { cn, formatRelative } from "@/lib/utils";
import { api } from "@/services/tauri";
import { useSettings } from "@/stores/settings";
import type { RemoteStatus } from "@/types";
import { TailscaleHttps } from "./TailscaleHttps";

function CopyText({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      }}
      className="inline-flex items-center gap-1.5 rounded-md bg-secondary px-2 py-1 font-mono text-sm hover:bg-accent"
      title="Copier"
    >
      {text} {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
    </button>
  );
}

export function RemoteSettings() {
  const { settings, load } = useSettings();
  const [status, setStatus] = useState<RemoteStatus | null>(null);
  const [port, setPort] = useState(String(settings.remotePort));
  const [code, setCode] = useState<{ code: string; until: number } | null>(null);
  const [now, setNow] = useState(Date.now());
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(() => {
    api.remote.status().then(setStatus).catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    refresh();
    const unlisten = listen("remote://changed", () => {
      refresh();
      setCode(null); // un appareil vient d'être appairé : le code est consommé
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, [refresh]);

  useEffect(() => setPort(String(settings.remotePort)), [settings.remotePort]);

  useEffect(() => {
    if (!code) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [code]);

  const configure = async (enabled: boolean) => {
    setError(null);
    try {
      setStatus(await api.remote.configure(enabled, Number(port) || 47820));
      await load();
      if (!enabled) setCode(null);
    } catch (e) {
      setError(String(e));
      refresh();
    }
  };

  const remaining = code ? Math.max(0, Math.round((code.until - now) / 1000)) : 0;

  return (
    <Card>
      <CardHeader>
        <div>
          <h3 className="font-semibold">Accès à distance</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Tableau de bord mobile sur votre réseau local : métriques, workspaces et automatisations depuis un téléphone.
          </p>
        </div>
        <Wifi className="size-4 text-muted-foreground" />
      </CardHeader>

      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm">
          Port
          <Input className="w-24" value={port} inputMode="numeric" maxLength={5} disabled={status?.running} onChange={(e) => setPort(e.target.value.replace(/\D/g, ""))} />
        </label>
        {status?.running ? (
          <Button variant="outline" onClick={() => configure(false)}>Désactiver</Button>
        ) : (
          <Button onClick={() => configure(true)}>Activer</Button>
        )}
        <Badge variant={status?.running ? "success" : "outline"}>{status?.running ? "Actif" : "Désactivé"}</Badge>
      </div>

      {(error || status?.error) && <p className="text-sm text-destructive">{error ?? status?.error}</p>}

      {status?.running && (
        <div className="grid gap-3 rounded-lg bg-secondary/60 p-3 text-sm">
          <p className="flex flex-wrap items-center gap-2">
            Ouvrez sur votre téléphone (même Wi-Fi) :
            {status.urls.slice(0, 1).map((u) => <CopyText key={u} text={u} />)}
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <Button
              size="sm"
              onClick={async () => {
                try {
                  const c = await api.remote.pairingCode();
                  setCode({ code: c.code, until: Date.now() + c.expiresInSecs * 1000 });
                  setNow(Date.now());
                } catch (e) {
                  setError(String(e));
                }
              }}
            >
              <Smartphone /> Appairer un appareil
            </Button>
            {code && remaining > 0 && (
              <span className="flex items-center gap-3">
                <span className="font-mono text-2xl font-semibold tracking-[0.25em] tabular-nums select-text">{code.code}</span>
                <span className="text-xs text-muted-foreground">expire dans {Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, "0")}</span>
              </span>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            Windows peut demander d'autoriser DevCenter dans le pare-feu : choisissez <b>réseaux privés</b> uniquement. Sur le Wi-Fi, la connexion est en
            HTTP non chiffré : pour l'iPhone (appli et notifications) et l'accès hors de chez vous, utilisez HTTPS via Tailscale ci-dessous.
          </p>
        </div>
      )}

      {status && <TailscaleHttps running={status.running} />}

      {status && status.devices.length > 0 && (
        <div className="grid gap-2">
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-medium">Appareils appairés</p>
            {status.devices.some((d) => d.notifications) && (
              <Button
                variant="ghost"
                size="sm"
                onClick={async () => {
                  setError(null);
                  try {
                    const n = await api.push.test();
                    setNotice(n > 0 ? `Notification de test envoyée à ${n} appareil(s).` : "Aucun appareil n'a reçu la notification.");
                  } catch (e) {
                    setError(String(e));
                  }
                }}
              >
                <Bell /> Tester les notifications
              </Button>
            )}
          </div>
          {notice && <p className="text-xs text-success">{notice}</p>}
          <ul className="divide-y rounded-lg border">
            {status.devices.map((d) => (
              <li key={d.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                <Smartphone className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">{d.name}</span>
                {d.notifications ? (
                  <Bell className="size-3.5 shrink-0 text-primary" aria-label="Notifications activées" />
                ) : (
                  <BellOff className="size-3.5 shrink-0 text-muted-foreground/60" aria-label="Notifications désactivées" />
                )}
                <span className={cn("text-xs text-muted-foreground")}>
                  {d.lastSeen ? `vu ${formatRelative(d.lastSeen)}` : `appairé ${formatRelative(d.createdAt)}`}
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8 hover:text-destructive"
                  onClick={() => api.remote.revoke(d.id).then(setStatus).catch((e) => setError(String(e)))}
                  aria-label={`Révoquer ${d.name}`}
                  title="Révoquer"
                >
                  <Trash2 />
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}
