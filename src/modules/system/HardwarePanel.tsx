import { Gpu, Thermometer } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { usePolling } from "@/hooks/usePolling";
import { cn, formatBytes } from "@/lib/utils";
import { api } from "@/services/tauri";

export function HardwarePanel() {
  const { data, error } = usePolling(api.system.hardware, 3000);
  const gpus = data?.gpus ?? [];
  const sensors = (data?.sensors ?? []).filter((s) => s.temperature !== null);

  return (
    <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Carte graphique</CardTitle>
          <Gpu className="size-4 text-muted-foreground" />
        </CardHeader>
        <CardContent className="gap-4">
          {error && <p className="text-sm text-destructive">{error}</p>}
          {data && gpus.length === 0 && <p className="text-sm text-muted-foreground">Aucun GPU détecté.</p>}
          {!data && !error && <p className="text-sm text-muted-foreground">Chargement…</p>}
          {gpus.map((g, i) => {
            // Sous Windows, la VRAM utilisée n'est souvent pas exposée (renvoyée à 0) : on n'affiche alors que le total.
            const vramUsedKnown = !!g.memoryTotal && !!g.memoryUsed;
            return (
              <div key={i} className="grid gap-2">
                <div className="flex items-baseline justify-between gap-2 text-sm">
                  <span className="truncate font-medium">{g.model ?? g.vendor ?? `GPU ${i}`}</span>
                  <span className="shrink-0 tabular-nums text-muted-foreground">
                    {g.usage !== null ? `${g.usage.toFixed(0)} %` : "usage n/d"}
                  </span>
                </div>
                {g.usage !== null && <Progress value={g.usage} />}
                {g.memoryTotal ? (
                  <p className="text-xs text-muted-foreground tabular-nums">
                    VRAM {vramUsedKnown ? `${formatBytes(g.memoryUsed!)} / ` : ""}
                    {formatBytes(g.memoryTotal)}
                  </p>
                ) : null}
              </div>
            );
          })}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Températures</CardTitle>
          <Thermometer className="size-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          {data && sensors.length === 0 && (
            <p className="text-sm text-muted-foreground">
              Aucun capteur lisible. Sous Windows, les températures nécessitent souvent de lancer DevCenter en
              administrateur.
            </p>
          )}
          <ul className="grid gap-1.5 text-sm">
            {sensors.map((s, i) => {
              const hot = s.critical !== null && s.temperature! >= s.critical - 10;
              return (
                <li key={`${s.label}-${i}`} className="flex justify-between gap-2">
                  <span className="truncate">{s.label}</span>
                  <span className={cn("tabular-nums", hot ? "text-destructive" : "text-muted-foreground")}>
                    {s.temperature!.toFixed(0)} °C
                  </span>
                </li>
              );
            })}
          </ul>
        </CardContent>
      </Card>
    </section>
  );
}
