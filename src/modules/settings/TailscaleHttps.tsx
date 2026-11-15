import { useCallback, useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ExternalLink, Loader2, Lock } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { api } from "@/services/tauri";
import type { TailscaleStatus } from "@/types";

const ADMIN_DNS = "https://login.tailscale.com/admin/dns";

/**
 * HTTPS via Tailscale (`tailscale serve`) : nécessaire sur iPhone pour installer l'appli et
 * recevoir les notifications ; donne aussi l'accès hors du Wi-Fi, sur le réseau Tailscale uniquement.
 */
export function TailscaleHttps({ running }: { running: boolean }) {
  const [st, setSt] = useState<TailscaleStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    api.tailscale.status().then(setSt).catch((e) => setError(String(e)));
  }, []);
  useEffect(() => refresh(), [refresh]);

  const toggle = async (enabled: boolean) => {
    setBusy(true);
    setError(null);
    try {
      setSt(await api.tailscale.serve(enabled));
    } catch (e) {
      setError(String(e));
      refresh();
    } finally {
      setBusy(false);
    }
  };

  if (!st) return null;

  return (
    <div className="grid gap-3 rounded-lg border p-3 text-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-center gap-2 font-medium">
            <Lock className="size-4 text-primary" /> HTTPS via Tailscale
            {st.serveUrl ? <Badge variant="success">Actif</Badge> : <Badge variant="outline">Inactif</Badge>}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Requis sur iPhone pour installer l'appli et recevoir les notifications. Accessible partout, mais uniquement depuis vos appareils Tailscale.
          </p>
        </div>
        {st.installed && st.httpsEnabled && running && (
          st.serveUrl ? (
            <Button variant="outline" size="sm" disabled={busy} onClick={() => toggle(false)}>
              {busy && <Loader2 className="animate-spin" />} Désactiver
            </Button>
          ) : (
            <Button size="sm" disabled={busy} onClick={() => toggle(true)}>
              {busy && <Loader2 className="animate-spin" />} Activer
            </Button>
          )
        )}
      </div>

      {!st.installed && <p className="text-xs text-muted-foreground">Tailscale n'est pas installé sur ce PC.</p>}
      {st.installed && !st.online && <p className="text-xs text-warning">Tailscale est déconnecté sur ce PC.</p>}
      {st.installed && st.online && !st.httpsEnabled && (
        <div className="grid gap-2 text-xs text-muted-foreground">
          <p>
            Une étape côté Tailscale, une seule fois : dans la console, page <b className="text-foreground">DNS</b>, activez{" "}
            <b className="text-foreground">HTTPS Certificates</b> (MagicDNS doit être activé).
          </p>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => openUrl(ADMIN_DNS)}>
              Ouvrir la console <ExternalLink />
            </Button>
            <Button variant="ghost" size="sm" onClick={refresh}>Vérifier</Button>
          </div>
        </div>
      )}
      {st.httpsEnabled && !running && <p className="text-xs text-muted-foreground">Activez d'abord l'accès à distance ci-dessus.</p>}
      {st.serveUrl && (
        <p className="text-xs text-muted-foreground">
          Sur l'iPhone (app Tailscale connectée), ouvrez <span className="font-mono text-foreground select-text">{st.serveUrl}</span> dans Safari, puis
          Partager › Sur l'écran d'accueil.
        </p>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
