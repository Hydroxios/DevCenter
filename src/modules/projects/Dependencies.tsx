import { useEffect } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ExternalLink, Loader2, PackageCheck, ShieldAlert, ShieldCheck } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { cn, formatRelative } from "@/lib/utils";
import { useDependencies } from "@/stores/dependencies";
import type { DependencySummary, OutdatedPackage, VulnCounts, VulnSeverity } from "@/types";

const SEVERITIES: VulnSeverity[] = ["critical", "high", "moderate", "low", "info", "unknown"];

const SEVERITY_LABEL: Record<VulnSeverity, [string, string]> = {
  critical: ["critique", "critiques"],
  high: ["haute", "hautes"],
  moderate: ["moyenne", "moyennes"],
  low: ["faible", "faibles"],
  info: ["info", "info"],
  unknown: ["inconnue", "inconnues"],
};

const SEVERITY_VARIANT = {
  critical: "destructive",
  high: "destructive",
  moderate: "warning",
  low: "outline",
  info: "outline",
  unknown: "outline",
} as const;

const plural = (n: number, one: string, many: string) => (n > 1 ? many : one);

function totalVulns(c: VulnCounts) {
  return SEVERITIES.reduce((sum, s) => sum + (c[s] ?? 0), 0);
}

function highest(c: VulnCounts): VulnSeverity | null {
  return SEVERITIES.find((s) => (c[s] ?? 0) > 0) ?? null;
}

/** « 1 vuln haute », « 4 vulns dont 1 critique ». */
function vulnText(c: VulnCounts): string | null {
  const total = totalVulns(c);
  const top = highest(c);
  if (!top) return null;
  const n = c[top];
  const label = SEVERITY_LABEL[top][n > 1 ? 1 : 0];
  return n === total ? `${total} ${plural(total, "vuln", "vulns")} ${label}` : `${total} vulns dont ${n} ${label}`;
}

function summaryTitle(s: DependencySummary): string {
  const parts = [
    s.outdated > 0
      ? `${s.outdated} ${plural(s.outdated, "mise à jour disponible", "mises à jour disponibles")}${s.major > 0 ? `, dont ${s.major} ${plural(s.major, "majeure", "majeures")}` : ""}`
      : "Dépendances à jour",
    ...SEVERITIES.filter((sev) => s.vulnCounts[sev] > 0).map((sev) => `${s.vulnCounts[sev]} ${plural(s.vulnCounts[sev], "vulnérabilité", "vulnérabilités")} ${SEVERITY_LABEL[sev][s.vulnCounts[sev] > 1 ? 1 : 0]}`),
  ];
  return `${parts.join("\n")}\nVérifié ${formatRelative(s.checkedAt)}`;
}

/** Pastille de la liste des projets : rien tant que le projet n'a pas été vérifié ou s'il est sain. */
export function DependencyBadge({ projectId }: { projectId: number }) {
  const summary = useDependencies((s) => s.summaries[projectId]);
  const checking = useDependencies((s) => s.checking[projectId]);
  if (checking) return <Loader2 className="size-3 shrink-0 animate-spin text-muted-foreground" aria-label="Vérification des dépendances" />;
  if (!summary) return null;
  const vulns = vulnText(summary.vulnCounts);
  const top = highest(summary.vulnCounts);
  if (summary.outdated === 0 && !vulns) return null;
  return (
    <span className="flex shrink-0 items-center gap-1 text-xs tabular-nums" title={summaryTitle(summary)}>
      {summary.outdated > 0 && <span className={summary.major > 0 ? "text-warning" : "text-muted-foreground"}>{summary.outdated} maj</span>}
      {summary.outdated > 0 && vulns && <span className="text-muted-foreground">·</span>}
      {vulns && (
        <span className={top === "critical" || top === "high" ? "text-destructive" : top === "moderate" ? "text-warning" : "text-muted-foreground"}>
          {vulns}
        </span>
      )}
    </span>
  );
}

/** Nombre de vulnérabilités graves (critique + haute) : compteur de l'onglet. */
export function useSevereVulns(projectId: number): number {
  const c = useDependencies((s) => s.summaries[projectId]?.vulnCounts);
  return c ? c.critical + c.high : 0;
}

function Version({ value, className }: { value: string | null; className?: string }) {
  return <span className={cn("font-mono text-xs", !value && "text-muted-foreground", className)}>{value ?? "—"}</span>;
}

function OutdatedRow({ p }: { p: OutdatedPackage }) {
  return (
    <tr className="border-t">
      <td className="px-3 py-1.5">
        <span className="flex items-center gap-2">
          <span className="font-mono text-sm">{p.name}</span>
          {p.major && <Badge variant="warning">majeure</Badge>}
          {p.ecosystem === "cargo" && <Badge variant="outline">cargo</Badge>}
        </span>
      </td>
      <td className="px-3 py-1.5"><Version value={p.current} /></td>
      <td className="px-3 py-1.5"><Version value={p.wanted} /></td>
      <td className="px-3 py-1.5"><Version value={p.latest} className={p.major ? "text-warning" : "text-primary"} /></td>
      <td className="px-3 py-1.5 text-xs text-muted-foreground">{p.kind ?? ""}</td>
    </tr>
  );
}

export function DependenciesPanel({ projectId, packageManager }: { projectId: number; packageManager: string | null | undefined }) {
  const report = useDependencies((s) => s.reports[projectId]);
  const loaded = useDependencies((s) => projectId in s.reports);
  const checking = useDependencies((s) => !!s.checking[projectId]);
  const error = useDependencies((s) => s.errors[projectId]);
  const loadReport = useDependencies((s) => s.loadReport);
  const check = useDependencies((s) => s.check);

  useEffect(() => {
    loadReport(projectId);
  }, [projectId, loadReport]);

  const vulns = report?.vulnerabilities ?? [];
  const outdated = report?.outdated ?? [];
  const majors = outdated.filter((p) => p.major).length;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="grid gap-4 p-6">
        <div className="flex flex-wrap items-center gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-sm">
              {report ? (
                <>Dernière vérification <span className="text-foreground">{formatRelative(report.checkedAt)}</span></>
              ) : loaded ? (
                "Jamais vérifié."
              ) : (
                "…"
              )}
            </p>
            <p className="meta mt-0.5">
              {report && report.tools.length > 0
                ? report.tools.join(" · ")
                : `Paquets obsolètes et vulnérabilités connues${packageManager ? ` (${packageManager})` : ""}. Le projet n'est pas modifié.`}
            </p>
          </div>
          <Button size="sm" onClick={() => check(projectId)} disabled={checking} title="Lancer outdated et audit (sans rien modifier)">
            {checking ? <Loader2 className="animate-spin" /> : <PackageCheck />}
            {checking ? "Vérification…" : "Vérifier"}
          </Button>
        </div>
        {checking && <p className="text-xs text-muted-foreground">Interrogation des registres : cela peut prendre jusqu'à quelques minutes.</p>}
        {error && <p className="text-sm text-destructive">{error}</p>}

        {report && (
          <>
            <Card>
              <CardHeader>
                <CardTitle>Vulnérabilités</CardTitle>
                <span className="flex flex-wrap gap-1.5">
                  {SEVERITIES.filter((s) => report.vulnCounts[s] > 0).map((s) => (
                    <Badge key={s} variant={SEVERITY_VARIANT[s]}>
                      {report.vulnCounts[s]} {SEVERITY_LABEL[s][report.vulnCounts[s] > 1 ? 1 : 0]}
                    </Badge>
                  ))}
                </span>
              </CardHeader>
              {vulns.length === 0 ? (
                <p className="flex items-center gap-2 text-sm text-muted-foreground">
                  <ShieldCheck className="size-4 text-success" /> Aucune vulnérabilité connue.
                </p>
              ) : (
                <ul className="divide-y rounded-lg border">
                  {vulns.map((v) => (
                    <li key={`${v.ecosystem}:${v.name}:${v.title}`} className="flex items-start gap-3 px-3 py-2">
                      <Badge variant={SEVERITY_VARIANT[v.severity]} className="mt-0.5 w-20 justify-center">
                        {SEVERITY_LABEL[v.severity][0]}
                      </Badge>
                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="font-mono text-sm font-medium">{v.name}</span>
                          {v.range && <span className="truncate font-mono text-xs text-muted-foreground">{v.range}</span>}
                        </div>
                        {v.url ? (
                          <button
                            type="button"
                            onClick={() => openUrl(v.url!).catch(() => {})}
                            className="inline-flex max-w-full items-center gap-1 text-left text-sm text-foreground/85 hover:text-primary"
                            title={v.url}
                          >
                            <span className="truncate">{v.title}</span> <ExternalLink className="size-3 shrink-0" />
                          </button>
                        ) : (
                          <p className="truncate text-sm text-foreground/85">{v.title}</p>
                        )}
                      </div>
                      {v.fix && <span className="shrink-0 font-mono text-xs text-success" title="Correctif">→ {v.fix}</span>}
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Paquets obsolètes</CardTitle>
                {outdated.length > 0 && (
                  <span className="text-xs text-muted-foreground">
                    {outdated.length} {plural(outdated.length, "paquet", "paquets")}
                    {majors > 0 && <span className="text-warning"> · {majors} {plural(majors, "majeure", "majeures")}</span>}
                  </span>
                )}
              </CardHeader>
              {outdated.length === 0 ? (
                <p className="text-sm text-muted-foreground">Toutes les dépendances vérifiées sont à jour.</p>
              ) : (
                <div className="overflow-x-auto rounded-lg border">
                  <table className="w-full text-left">
                    <thead className="eyebrow bg-foreground/[0.02]">
                      <tr>
                        <th className="px-3 py-1.5 font-normal">Paquet</th>
                        <th className="px-3 py-1.5 font-normal">Actuelle</th>
                        <th className="px-3 py-1.5 font-normal">Compatible</th>
                        <th className="px-3 py-1.5 font-normal">Dernière</th>
                        <th className="px-3 py-1.5 font-normal">Type</th>
                      </tr>
                    </thead>
                    <tbody>
                      {outdated.map((p) => <OutdatedRow key={`${p.ecosystem}:${p.name}:${p.current}`} p={p} />)}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>

            {report.notes.length > 0 && (
              <div className="grid gap-1">
                {report.notes.map((n) => (
                  <p key={n} className="flex items-start gap-2 text-xs text-muted-foreground">
                    <ShieldAlert className="mt-px size-3.5 shrink-0" /> {n}
                  </p>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
