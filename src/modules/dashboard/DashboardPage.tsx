import { useEffect, useState } from "react";
import { Link } from "react-router";
import { Clock, Cpu, HardDrive, MemoryStick, Star } from "lucide-react";

import { Page, PageBar, PageBody, PageMain, PageNotice } from "@/components/layout/Page";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { usePolling } from "@/hooks/usePolling";
import { formatBytes, formatDuration } from "@/lib/utils";
import { api, isTauri } from "@/services/tauri";
import { useWorkspaces } from "@/stores/workspaces";
import type { SystemInfo } from "@/types";
import { WorkspaceToggle } from "@/modules/workspaces/WorkspacesPage";

const REFRESH_MS = 2000;

function Metric({
  title,
  icon: Icon,
  value,
  detail,
  percent,
}: {
  title: string;
  icon: typeof Cpu;
  value: string;
  detail?: string;
  percent?: number;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <Icon className="size-4 text-muted-foreground" />
      </CardHeader>
      <CardContent>
        <p className="text-2xl font-semibold tabular-nums">{value}</p>
        {percent !== undefined && <Progress value={percent} />}
        {detail && <p className="text-xs text-muted-foreground tabular-nums">{detail}</p>}
      </CardContent>
    </Card>
  );
}

/** Démarrage rapide des workspaces favoris (et de ceux en cours). */
function FavoriteWorkspaces() {
  const workspaces = useWorkspaces((s) => s.workspaces);
  const error = useWorkspaces((s) => s.error);
  const shown = (workspaces ?? []).filter((w) => w.favorite || w.active);
  if (shown.length === 0) return null;
  return (
    <section>
      <Card className="gap-3">
        <CardHeader>
          <CardTitle>Workspaces favoris</CardTitle>
          <Link to="/workspaces" className="text-xs text-primary hover:underline">Tout voir</Link>
        </CardHeader>
        <ul className="grid grid-cols-1 gap-2 md:grid-cols-2 2xl:grid-cols-4">
          {shown.map((w) => (
            <li key={w.id} className="flex items-center gap-3 rounded-lg border px-3 py-2">
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
        {error && <p className="text-sm text-destructive">{error}</p>}
      </Card>
    </section>
  );
}

export function DashboardPage() {
  const tauri = isTauri();
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const { data: snap, error } = usePolling(api.system.snapshot, REFRESH_MS, tauri);

  useEffect(() => {
    if (tauri) api.system.info().then(setInfo).catch(() => {});
  }, [tauri]);

  const memPct = snap && snap.memoryTotal ? (snap.memoryUsed / snap.memoryTotal) * 100 : 0;
  const disks = (snap?.disks ?? []).filter((d) => d.totalBytes > 0);

  return (
    <Page>
      <PageMain>
      <PageBar
        title="Dashboard"
        meta={info ? `${info.hostName ?? "Machine locale"} · ${info.osVersion ?? info.osName ?? ""}` : "Vue d'ensemble de votre machine"}
      />
      {!tauri && (
        <PageNotice tone="warning">Les métriques système ne sont disponibles que dans l'application (pnpm tauri dev).</PageNotice>
      )}
      {error && <PageNotice>{error}</PageNotice>}

      <PageBody>
      <FavoriteWorkspaces />

      <section className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <Metric
          title="Processeur"
          icon={Cpu}
          value={snap ? `${snap.cpuUsage.toFixed(0)} %` : "—"}
          percent={snap?.cpuUsage}
          detail={info ? `${info.cpuBrand} · ${info.cpuCores} threads` : undefined}
        />
        <Metric
          title="Mémoire"
          icon={MemoryStick}
          value={snap ? `${memPct.toFixed(0)} %` : "—"}
          percent={snap ? memPct : undefined}
          detail={snap ? `${formatBytes(snap.memoryUsed)} / ${formatBytes(snap.memoryTotal)}` : undefined}
        />
        <Metric
          title="Temps de fonctionnement"
          icon={Clock}
          value={snap ? formatDuration(snap.uptimeSecs) : "—"}
          detail={info?.kernelVersion ? `Build ${info.kernelVersion}` : undefined}
        />
      </section>

      {/* Grand écran : stockage et charge par cœur côte à côte, à la même hauteur. */}
      <section className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Stockage</CardTitle>
            <HardDrive className="size-4 text-muted-foreground" />
          </CardHeader>
          <CardContent className="gap-4">
            {disks.length === 0 && <p className="text-sm text-muted-foreground">Aucun disque détecté.</p>}
            {disks.map((d) => {
              const used = d.totalBytes - d.availableBytes;
              return (
                <div key={d.mountPoint} className="grid gap-1.5">
                  <div className="flex items-baseline justify-between text-sm">
                    <span className="font-medium">
                      {d.mountPoint}
                      {d.name && <span className="ml-2 font-normal text-muted-foreground">{d.name}</span>}
                    </span>
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {formatBytes(d.availableBytes)} libres sur {formatBytes(d.totalBytes)}
                    </span>
                  </div>
                  <Progress value={(used / d.totalBytes) * 100} />
                </div>
              );
            })}
          </CardContent>
        </Card>

      {snap && snap.cpuPerCore.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle>Charge par cœur logique</CardTitle>
              <span className="meta">{snap.cpuPerCore.length} cœurs</span>
            </CardHeader>
            {/* Barres pleine hauteur réduites par `scaleY` (animé par le GPU) ; la transition dure
                tout l'intervalle de rafraîchissement : les barres glissent en continu, sans à-coups. */}
            <div className="flex min-h-24 flex-1 items-stretch gap-1" aria-label="Charge CPU par cœur">
              {snap.cpuPerCore.map((v, i) => (
                <div key={i} title={`Cœur ${i} : ${v.toFixed(0)} %`} className="relative flex-1 overflow-hidden rounded-sm bg-primary/8">
                  <div
                    className="absolute inset-0 origin-bottom rounded-sm bg-linear-to-t from-primary/70 to-primary will-change-transform"
                    style={{
                      transform: `scaleY(${Math.max(3, Math.min(100, v)) / 100})`,
                      transition: `transform ${REFRESH_MS}ms cubic-bezier(0.33, 0, 0.25, 1)`,
                    }}
                  />
                </div>
              ))}
            </div>
          </Card>
      )}
      </section>
      </PageBody>
      </PageMain>
    </Page>
  );
}
