import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, ChevronRight, Copy, FileMinus, FilePen, FilePlus, FileSymlink, FileX, GitBranch, Loader2, RefreshCw, Tag, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn, formatRelative } from "@/lib/utils";
import { api } from "@/services/tauri";
import type { CommitDetails, FileChange, GitLog, GraphCommit } from "@/types";

/** Couleurs des branches (même ordre que la page mobile). */
export const BRANCH_COLORS = ["#22d3ee", "#a78bfa", "#34d399", "#fbbf24", "#f472b6", "#60a5fa", "#fb923c", "#a3e635"];

const ROW = 34;
const LANE = 14;
const PAD = 10;

const laneX = (col: number) => PAD + col * LANE;

/**
 * Caches de la session : un projet déjà ouvert s'affiche aussitôt (le graphe est revalidé en
 * arrière-plan, quasi gratuit grâce au cache Rust) ; un commit ne change jamais.
 */
const logCache = new Map<number, GitLog>();
const commitCache = new Map<string, CommitDetails>();
const MAX_COMMITS = 200;

/** Graphe SVG : un trait par segment entre deux lignes, un point par commit. */
function Graph({ log }: { log: GitLog }) {
  const width = PAD * 2 + Math.max(0, log.width - 1) * LANE;
  const height = log.commits.length * ROW;
  return (
    <svg width={width} height={height} className="pointer-events-none absolute top-0 left-0" aria-hidden>
      {log.commits.map((c, r) =>
        c.edges.map((e, i) => {
          const x1 = laneX(e.from);
          const y1 = r * ROW + ROW / 2;
          const x2 = laneX(e.to);
          const y2 = y1 + ROW;
          const d = x1 === x2 ? `M${x1} ${y1}V${y2}` : `M${x1} ${y1}C${x1} ${y1 + ROW * 0.6},${x2} ${y2 - ROW * 0.6},${x2} ${y2}`;
          return <path key={`${r}-${i}`} d={d} fill="none" stroke={BRANCH_COLORS[e.color]} strokeWidth={1.6} strokeOpacity={0.9} />;
        }),
      )}
      {log.commits.map((c, r) => {
        const merge = c.parents.length > 1;
        return (
          <circle
            key={c.hash}
            cx={laneX(c.column)}
            cy={r * ROW + ROW / 2}
            r={merge ? 3.2 : 4}
            fill={merge ? "#000" : BRANCH_COLORS[c.color]}
            stroke={BRANCH_COLORS[c.color]}
            strokeWidth={merge ? 2 : 0}
          />
        );
      })}
    </svg>
  );
}

function RefBadge({ name }: { name: string }) {
  const head = name.startsWith("HEAD -> ");
  const tag = name.startsWith("tag: ");
  const label = name.replace(/^HEAD -> /, "").replace(/^tag: /, "");
  const remote = !head && !tag && label.includes("/");
  return (
    <span
      className={cn(
        "inline-flex max-w-40 shrink-0 items-center gap-1 truncate rounded px-1.5 py-px font-mono text-[10.5px]",
        head ? "bg-primary text-primary-foreground" : tag ? "bg-warning/15 text-warning" : remote ? "bg-secondary text-muted-foreground" : "bg-primary/12 text-primary",
      )}
      title={name}
    >
      {tag ? <Tag className="size-2.5 shrink-0" /> : <GitBranch className="size-2.5 shrink-0" />}
      <span className="truncate">{label}</span>
    </span>
  );
}

export function GitHistory({
  projectId,
  focusHash = null,
  onFocused,
}: {
  projectId: number;
  /** Commit (hash complet ou abrégé) à sélectionner une fois l'historique chargé. */
  focusHash?: string | null;
  onFocused?: () => void;
}) {
  const [log, setLog] = useState<GitLog | null>(() => logCache.get(projectId) ?? null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<GraphCommit | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const fresh = await api.git.log(projectId);
      logCache.set(projectId, fresh);
      setLog(fresh);
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    setLog(logCache.get(projectId) ?? null);
    setSelected(null);
    load();
  }, [load, projectId]);

  useEffect(() => {
    if (!log || !focusHash) return;
    const target = log.commits.find((c) => c.hash.startsWith(focusHash) || c.short === focusHash);
    if (target) {
      setSelected(target);
      requestAnimationFrame(() => document.getElementById(`commit-${target.hash}`)?.scrollIntoView({ block: "center" }));
    }
    onFocused?.();
  }, [log, focusHash, onFocused]);

  // Navigation au clavier dans la liste (↑ ↓, Échap pour fermer le détail).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!log || (e.target as HTMLElement)?.tagName === "INPUT") return;
      if (e.key === "Escape") setSelected(null);
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      e.preventDefault();
      const i = selected ? log.commits.findIndex((c) => c.hash === selected.hash) : -1;
      const next = log.commits[Math.max(0, Math.min(log.commits.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))];
      if (next) {
        setSelected(next);
        document.getElementById(`commit-${next.hash}`)?.scrollIntoView({ block: "nearest" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [log, selected]);

  const graphWidth = log ? PAD * 2 + Math.max(0, log.width - 1) * LANE : 0;

  return (
    <div className="flex min-h-0 flex-1">
      {/* Liste des commits */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-b px-4">
          <span className="eyebrow">
            {log ? `${log.commits.length}${log.truncated ? "+" : ""} commits · toutes les branches` : "historique"}
          </span>
          <Button variant="ghost" size="icon" className="size-7" onClick={load} disabled={loading} aria-label="Actualiser l'historique" title="Actualiser">
            <RefreshCw className={cn(loading && "animate-spin")} />
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          {error && <p className="p-4 text-sm text-destructive">{error}</p>}
          {!log && !error && (
            <p className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Lecture de l'historique…
            </p>
          )}
          {log && log.commits.length === 0 && <p className="p-4 text-sm text-muted-foreground">Aucun commit.</p>}
          {log && log.commits.length > 0 && (
            <div className="relative">
              <Graph log={log} />
              <ul>
                {log.commits.map((c) => {
                  const active = selected?.hash === c.hash;
                  return (
                    <li key={c.hash}>
                      <button
                        id={`commit-${c.hash}`}
                        type="button"
                        onClick={() => setSelected(active ? null : c)}
                        className={cn(
                          "flex w-full min-w-0 items-center gap-2 pr-4 text-left text-sm transition-colors",
                          active ? "bg-primary/10" : "hover:bg-foreground/[0.04]",
                        )}
                        style={{ height: ROW, paddingLeft: graphWidth + 4 }}
                      >
                        {c.refs.slice(0, 3).map((r) => (
                          <RefBadge key={r} name={r} />
                        ))}
                        <span className={cn("min-w-0 flex-1 truncate", c.parents.length > 1 && "text-muted-foreground")}>{c.subject}</span>
                        {!selected && <span className="hidden w-32 shrink-0 truncate text-right text-xs text-muted-foreground xl:block">{c.author}</span>}
                        <span className="w-24 shrink-0 text-right text-xs text-muted-foreground">{formatRelative(c.timestamp)}</span>
                        <span className="meta w-14 shrink-0 text-right">{c.short}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
              {log.truncated && <p className="border-t px-4 py-2 text-xs text-muted-foreground">Seuls les {log.commits.length} commits les plus récents sont affichés.</p>}
            </div>
          )}
        </div>
      </div>

      {/* Détail du commit sélectionné */}
      {selected && <CommitPanel key={selected.hash} projectId={projectId} commit={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

// ------------------------------------------------------------------ Détail d'un commit

const FILE_ICON = { added: FilePlus, deleted: FileX, modified: FilePen, renamed: FileSymlink, binary: FileMinus } as const;
const FILE_COLOR = { added: "text-success", deleted: "text-destructive", modified: "text-warning", renamed: "text-primary", binary: "text-muted-foreground" } as const;

export function DiffView({ patch }: { patch: string }) {
  const lines = useMemo(() => patch.split("\n"), [patch]);
  return (
    <pre className="overflow-x-auto bg-black py-2 font-mono text-[12px] leading-[1.55] select-text">
      {lines.map((l, i) => (
        <div
          key={i}
          className={cn(
            "px-3 whitespace-pre",
            l.startsWith("@@") && "bg-primary/8 text-primary/80",
            l.startsWith("+") && "bg-success/10 text-[#86efac]",
            l.startsWith("-") && "bg-destructive/10 text-[#fca5a5]",
            !/^[-+@]/.test(l) && "text-[#a1a1aa]",
          )}
        >
          {l || " "}
        </div>
      ))}
    </pre>
  );
}

function FileRow({ file, defaultOpen }: { file: FileChange; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const Icon = FILE_ICON[file.status];
  return (
    <li className="border-b last:border-b-0">
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-foreground/[0.04]">
        <ChevronRight className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
        <Icon className={cn("size-4 shrink-0", FILE_COLOR[file.status])} />
        <span className="min-w-0 flex-1 truncate font-mono text-xs" title={file.path}>
          {file.oldPath && <span className="text-muted-foreground">{file.oldPath} → </span>}
          {file.path}
        </span>
        <span className="meta shrink-0">
          <span className="text-success">+{file.additions}</span> <span className="text-destructive">−{file.deletions}</span>
        </span>
      </button>
      {open &&
        (file.patch ? (
          <>
            <DiffView patch={file.patch} />
            {file.truncated && <p className="px-3 py-1.5 text-xs text-muted-foreground">Diff tronqué (fichier trop long).</p>}
          </>
        ) : (
          <p className="px-3 pb-2 text-xs text-muted-foreground">{file.status === "binary" ? "Fichier binaire." : "Pas de différence textuelle à afficher."}</p>
        ))}
    </li>
  );
}

/** Panneau de détail d'un commit (fichiers et diff). Aussi utilisé par la vue Activité du tableau de bord. */
export function CommitPanel({
  projectId,
  commit,
  onClose,
  className,
}: {
  projectId: number;
  commit: Pick<GraphCommit, "hash" | "short" | "subject" | "refs">;
  onClose: () => void;
  className?: string;
}) {
  const cacheKey = `${projectId}:${commit.hash}`;
  const [details, setDetails] = useState<CommitDetails | null>(() => commitCache.get(cacheKey) ?? null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (commitCache.has(cacheKey)) return;
    api.git
      .commit(projectId, commit.hash)
      .then((d) => {
        if (commitCache.size >= MAX_COMMITS) commitCache.clear();
        commitCache.set(cacheKey, d);
        setDetails(d);
      })
      .catch((e) => setError(String(e)));
  }, [projectId, commit.hash, cacheKey]);

  return (
    <aside className={cn("flex w-[min(640px,52%)] shrink-0 flex-col border-l bg-card", className)}>
      <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-b px-4">
        <span className="eyebrow">commit {commit.short}</span>
        <Button variant="ghost" size="icon" className="size-7" onClick={onClose} aria-label="Fermer le détail" title="Fermer (Échap)">
          <X />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="grid gap-3 border-b p-4">
          {commit.refs.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {commit.refs.map((r) => (
                <RefBadge key={r} name={r} />
              ))}
            </div>
          )}
          <h3 className="text-base font-semibold leading-snug select-text">{commit.subject}</h3>
          {details?.body && <pre className="font-sans text-sm whitespace-pre-wrap text-muted-foreground select-text">{details.body}</pre>}
          {details ? (
            <div className="grid gap-1.5 text-xs text-muted-foreground">
              <p>
                <b className="text-foreground">{details.author}</b> · {new Date(details.authoredAt * 1000).toLocaleString("fr-FR")}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className="inline-flex items-center gap-1 font-mono hover:text-primary"
                  onClick={async () => {
                    await navigator.clipboard.writeText(details.hash);
                    setCopied(true);
                    window.setTimeout(() => setCopied(false), 1500);
                  }}
                  title="Copier le hash complet"
                >
                  {details.hash.slice(0, 12)} {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
                </button>
                {details.parents.length > 1 && <Badge variant="outline">fusion · {details.parents.length} parents</Badge>}
                <span className="meta">
                  {details.files.length} fichier{details.files.length > 1 ? "s" : ""} · <span className="text-success">+{details.additions}</span>{" "}
                  <span className="text-destructive">−{details.deletions}</span>
                </span>
              </div>
            </div>
          ) : (
            !error && (
              <p className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" /> Chargement…
              </p>
            )
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        {details && (
          <ul>
            {details.files.map((f) => (
              <FileRow key={f.path} file={f} defaultOpen={details.files.length <= 3} />
            ))}
            {details.files.length === 0 && <li className="px-4 py-6 text-center text-sm text-muted-foreground">Aucun fichier modifié.</li>}
          </ul>
        )}
        {details?.diffTruncated && <p className="px-4 py-3 text-xs text-muted-foreground">Diff très volumineux : certains fichiers ne sont pas détaillés.</p>}
      </div>
    </aside>
  );
}
