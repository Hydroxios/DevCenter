import { ArrowUpCircle, CircleCheck, FileText, Loader2, RefreshCw, Sparkles } from "lucide-react";

import { LogoMark } from "@/components/layout/Logo";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { formatBytes, formatRelative } from "@/lib/utils";
import { api } from "@/services/tauri";
import { useOnboarding } from "@/stores/onboarding";
import { useUpdates } from "@/stores/updates";

/** Version installée, mises à jour et journal. */
export function AboutSettings() {
  const { version, status, update, progress, error, checkedAt, check, install } = useUpdates();
  const showOnboarding = useOnboarding((s) => s.show);
  const pct = progress?.total ? (progress.downloaded / progress.total) * 100 : undefined;

  return (
    <>
      <Card>
        <div className="flex items-center gap-4">
          <div className="flex size-12 shrink-0 items-center justify-center rounded-xl border bg-black">
            <LogoMark className="size-7" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="font-mono text-base">
              Dev<span className="text-primary">Center</span>
            </p>
            <p className="meta">version {version ?? "…"} · bêta</p>
          </div>
        </div>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Mises à jour</CardTitle>
          {checkedAt && status !== "checking" && <span className="meta">vérifié {formatRelative(Math.floor(checkedAt / 1000))}</span>}
        </CardHeader>

        {status === "available" && update ? (
          <div className="grid gap-3">
            <p className="flex items-center gap-2 text-sm">
              <ArrowUpCircle className="size-4 text-primary" />
              <span>
                Version <b className="font-mono">{update.version}</b> disponible
                {update.date && <span className="text-muted-foreground"> · publiée {formatRelative(update.date)}</span>}
              </span>
            </p>
            {update.notes && (
              <pre className="max-h-48 overflow-auto rounded-lg border bg-black/40 p-3 font-sans text-sm whitespace-pre-wrap text-muted-foreground select-text">
                {update.notes}
              </pre>
            )}
            <div className="flex items-center gap-3">
              <Button onClick={install}>
                <ArrowUpCircle /> Installer et relancer
              </Button>
              <span className="text-xs text-muted-foreground">Les scripts en cours seront arrêtés.</span>
            </div>
          </div>
        ) : status === "installing" ? (
          <div className="grid gap-2">
            <p className="flex items-center gap-2 text-sm">
              <Loader2 className="size-4 animate-spin text-primary" />
              {pct !== undefined && pct >= 100 ? "Installation… DevCenter va redémarrer." : "Téléchargement de la mise à jour…"}
            </p>
            {pct !== undefined && <Progress value={pct} />}
            {progress && (
              <p className="meta">
                {formatBytes(progress.downloaded)}
                {progress.total ? ` / ${formatBytes(progress.total)}` : ""}
              </p>
            )}
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              {status === "upToDate" && (
                <>
                  <CircleCheck className="size-4 text-success" /> DevCenter est à jour.
                </>
              )}
              {status === "checking" && (
                <>
                  <Loader2 className="size-4 animate-spin" /> Recherche…
                </>
              )}
              {status === "idle" && "Les mises à jour sont vérifiées au démarrage puis toutes les 6 heures."}
              {status === "error" && <span className="text-destructive">{error}</span>}
            </p>
            <Button variant="outline" size="sm" onClick={() => check()} disabled={status === "checking"}>
              <RefreshCw className={status === "checking" ? "animate-spin" : undefined} /> Rechercher
            </Button>
          </div>
        )}
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Assistant de démarrage</CardTitle>
        </CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="max-w-xl text-sm text-muted-foreground">
            Dossier de projets, éditeur, premier workspace, GitHub et accès mobile : reprenez la configuration guidée du premier lancement.
          </p>
          <Button variant="outline" size="sm" onClick={showOnboarding}>
            <Sparkles /> Relancer l'assistant
          </Button>
        </div>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Journal</CardTitle>
        </CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="max-w-xl text-sm text-muted-foreground">
            Erreurs et événements importants sont écrits dans <code className="font-mono text-xs">devcenter.log</code>. Joignez ce fichier à un rapport de bug.
          </p>
          <Button variant="outline" size="sm" onClick={() => api.logs.openFolder().catch(() => {})}>
            <FileText /> Ouvrir le dossier
          </Button>
        </div>
      </Card>
    </>
  );
}
