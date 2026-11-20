import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import {
  ArrowDownToLine,
  ArrowUp,
  ArrowUpFromLine,
  Check,
  ChevronRight,
  Copy,
  Eye,
  EyeOff,
  File,
  FileSymlink,
  Folder,
  FolderOpen,
  FolderPlus,
  Home,
  Loader2,
  Pencil,
  RefreshCw,
  Trash2,
  Upload,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { confirmAction } from "@/components/ui/confirm";
import { contextMenu, copyText } from "@/components/ui/context-menu";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn, formatBytes } from "@/lib/utils";
import { api } from "@/services/tauri";
import { useTransfers } from "@/stores/transfers";
import type { FileTransfer, RemoteEntry, RemoteListing, Server } from "@/types";

/** Dernier dossier ouvert par serveur (le temps de la session de l'app). */
const lastPath = new Map<number, string>();
const DOWNLOAD_DIR_KEY = "devcenter.servers.downloadDir";
const HIDDEN_KEY = "devcenter.servers.showHidden";

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeStorage(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* stockage indisponible */
  }
}

const parentOf = (path: string) => {
  const trimmed = path.replace(/\/+$/, "");
  const i = trimmed.lastIndexOf("/");
  return i <= 0 ? "/" : trimmed.slice(0, i);
};
const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

const dateFmt = new Intl.DateTimeFormat("fr", { dateStyle: "short", timeStyle: "short" });

function EntryIcon({ entry }: { entry: RemoteEntry }) {
  if (entry.kind === "link") return <FileSymlink className={cn("size-4 shrink-0", entry.isDir ? "text-primary" : "text-muted-foreground")} />;
  if (entry.isDir) return <Folder className="size-4 shrink-0 text-primary" />;
  return <File className="size-4 shrink-0 text-muted-foreground" />;
}

function Breadcrumb({ path, onNavigate }: { path: string; onNavigate: (p: string) => void }) {
  const parts = path.split("/").filter(Boolean);
  return (
    <nav className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto font-mono text-xs" aria-label="Chemin">
      <button type="button" className="shrink-0 rounded px-1.5 py-1 text-muted-foreground hover:bg-secondary hover:text-foreground" onClick={() => onNavigate("/")}>
        /
      </button>
      {parts.map((part, i) => {
        const target = `/${parts.slice(0, i + 1).join("/")}`;
        const last = i === parts.length - 1;
        return (
          <span key={target} className="flex shrink-0 items-center gap-0.5">
            {i > 0 && <ChevronRight className="size-3 text-muted-foreground/60" />}
            <button
              type="button"
              className={cn("rounded px-1.5 py-1 hover:bg-secondary", last ? "text-foreground" : "text-muted-foreground hover:text-foreground")}
              onClick={() => onNavigate(target)}
            >
              {part}
            </button>
          </span>
        );
      })}
    </nav>
  );
}

/** Boîte de saisie d'un nom (nouveau dossier, renommage). */
function NameDialog({
  title,
  initial,
  confirmLabel,
  onSubmit,
  onClose,
}: {
  title: string | null;
  initial: string;
  confirmLabel: string;
  onSubmit: (name: string) => Promise<void>;
  onClose: () => void;
}) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (title) {
      setValue(initial);
      setError(null);
    }
  }, [title, initial]);

  const submit = async () => {
    const name = value.trim();
    if (!name) return;
    if (name.includes("/") || name === "." || name === "..") {
      setError("Nom invalide : un seul élément, sans « / ».");
      return;
    }
    setBusy(true);
    try {
      await onSubmit(name);
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={title !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <form
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <Input value={value} onChange={(e) => setValue(e.target.value)} autoFocus spellCheck={false} className="font-mono" aria-label="Nom" />
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Annuler
            </Button>
            <Button type="submit" disabled={busy || !value.trim()}>
              {busy && <Loader2 className="animate-spin" />} {confirmLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function TransferRow({ t }: { t: FileTransfer }) {
  const cancel = useTransfers((s) => s.cancel);
  const dismiss = useTransfers((s) => s.dismiss);
  const pct = t.total > 0 ? Math.min(100, (t.transferred / t.total) * 100) : null;
  const Icon = t.direction === "upload" ? ArrowUpFromLine : ArrowDownToLine;
  return (
    <li className="flex items-center gap-3 px-3 py-2">
      <Icon className={cn("size-4 shrink-0", t.status === "error" ? "text-destructive" : t.status === "done" ? "text-success" : "text-primary")} />
      <div className="grid min-w-0 flex-1 gap-1">
        <p className="flex items-baseline gap-2 text-sm">
          <span className="truncate font-medium" title={t.direction === "upload" ? t.localPath : t.remotePath}>
            {t.name}
          </span>
          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
            {t.status === "running" &&
              (pct !== null ? `${pct.toFixed(0)} % · ${formatBytes(t.transferred)} / ${formatBytes(t.total)}` : formatBytes(t.transferred))}
            {t.status === "done" && (t.direction === "upload" ? "Envoyé" : "Téléchargé")}
            {t.status === "cancelled" && "Annulé"}
            {t.status === "error" && "Échec"}
          </span>
        </p>
        {t.status === "running" && (
          <div className="h-1 w-full overflow-hidden rounded-full bg-secondary" role="progressbar" aria-valuenow={pct ?? undefined}>
            <div
              className={cn("h-full rounded-full bg-primary transition-[width] duration-200", pct === null && "w-1/3 animate-pulse")}
              style={pct !== null ? { width: `${pct}%` } : undefined}
            />
          </div>
        )}
        {t.status === "error" && t.error && <p className="truncate text-xs text-destructive" title={t.error}>{t.error}</p>}
        {t.status === "done" && t.direction === "download" && (
          <p className="truncate font-mono text-xs text-muted-foreground" title={t.localPath}>
            {t.localPath}
          </p>
        )}
      </div>
      {t.status === "running" ? (
        <Button variant="ghost" size="icon" className="size-8 hover:text-destructive" onClick={() => cancel(t.id)} aria-label="Annuler" title="Annuler">
          <X />
        </Button>
      ) : (
        <Button variant="ghost" size="icon" className="size-8" onClick={() => dismiss(t.id)} aria-label="Retirer" title="Retirer de la liste">
          {t.status === "done" ? <Check /> : <X />}
        </Button>
      )}
    </li>
  );
}

export function FilesPanel({ server }: { server: Server }) {
  const [listing, setListing] = useState<RemoteListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [showHidden, setShowHidden] = useState(() => readStorage(HIDDEN_KEY) === "1");
  const [selected, setSelected] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [nameDialog, setNameDialog] = useState<{ title: string; initial: string; confirm: string; submit: (n: string) => Promise<void> } | null>(null);
  const dropRef = useRef<HTMLDivElement>(null);
  const requestId = useRef(0);

  const init = useTransfers((s) => s.init);
  const upsert = useTransfers((s) => s.upsert);
  const dismissFinished = useTransfers((s) => s.dismissFinished);
  const allTransfers = useTransfers((s) => s.transfers);
  const transfers = useMemo(
    () => Object.values(allTransfers).filter((t) => t.serverId === server.id).sort((a, b) => b.id - a.id),
    [allTransfers, server.id],
  );

  useEffect(() => {
    init();
  }, [init]);

  const load = useCallback(
    async (path: string | null) => {
      const req = ++requestId.current;
      setLoading(true);
      try {
        const next = await api.servers.listDir(server.id, path);
        if (req !== requestId.current) return;
        lastPath.set(server.id, next.path);
        setListing(next);
        setError(null);
        setSelected(null);
      } catch (e) {
        if (req === requestId.current) setError(String(e));
      } finally {
        if (req === requestId.current) setLoading(false);
      }
    },
    [server.id],
  );

  useEffect(() => {
    load(lastPath.get(server.id) ?? null);
  }, [load, server.id]);

  const cwd = listing?.path ?? null;
  const refresh = useCallback(() => load(cwd), [load, cwd]);

  // Un envoi terminé dans le dossier affiché : on rafraîchit la liste.
  const seenDone = useRef(new Set<number>());
  useEffect(() => {
    let changed = false;
    for (const t of transfers) {
      if (t.direction !== "upload" || t.status !== "done" || seenDone.current.has(t.id)) continue;
      seenDone.current.add(t.id);
      if (cwd && parentOf(t.remotePath) === cwd) changed = true;
    }
    if (changed) refresh();
  }, [transfers, cwd, refresh]);

  const entries = useMemo(() => (listing?.entries ?? []).filter((e) => showHidden || !e.name.startsWith(".")), [listing, showHidden]);

  const upload = useCallback(
    async (paths: string[]) => {
      if (!cwd || paths.length === 0) return;
      const existing = new Set(listing?.entries.map((e) => e.name));
      const conflicts = paths.map(baseName).filter((n) => existing.has(n));
      if (conflicts.length > 0) {
        const ok = await confirmAction({
          title: conflicts.length === 1 ? `Remplacer « ${conflicts[0]} » ?` : `Remplacer ${conflicts.length} fichiers ?`,
          description: `Ces fichiers existent déjà dans ${cwd} et seront écrasés : ${conflicts.slice(0, 5).join(", ")}${conflicts.length > 5 ? "…" : ""}`,
          confirmLabel: "Remplacer",
        });
        if (!ok) return;
      }
      try {
        upsert(await api.servers.upload(server.id, paths, cwd));
      } catch (e) {
        setError(String(e));
      }
    },
    [cwd, listing, server.id, upsert],
  );

  // Glisser-déposer de fichiers Windows sur la liste (événement natif Tauri).
  const uploadRef = useRef(upload);
  uploadRef.current = upload;
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    const inside = (pos: { x: number; y: number }) => {
      const el = dropRef.current;
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const x = pos.x / window.devicePixelRatio;
      const y = pos.y / window.devicePixelRatio;
      return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    };
    getCurrentWebview()
      .onDragDropEvent(({ payload }) => {
        if (payload.type === "enter" || payload.type === "over") setDragOver(inside(payload.position));
        else if (payload.type === "leave") setDragOver(false);
        else if (payload.type === "drop") {
          setDragOver(false);
          if (inside(payload.position)) uploadRef.current(payload.paths);
        }
      })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const pickUpload = async () => {
    const picked = await open({ multiple: true, directory: false, title: "Fichiers à envoyer" });
    if (!picked) return;
    upload(Array.isArray(picked) ? picked : [picked]);
  };

  const download = async (entry: RemoteEntry) => {
    const dir = await open({ directory: true, multiple: false, title: `Enregistrer « ${entry.name} » dans…`, defaultPath: readStorage(DOWNLOAD_DIR_KEY) ?? undefined });
    if (typeof dir !== "string") return;
    writeStorage(DOWNLOAD_DIR_KEY, dir);
    try {
      upsert([await api.servers.download(server.id, entry.path, entry.size, dir)]);
    } catch (e) {
      setError(String(e));
    }
  };

  const remove = async (entry: RemoteEntry) => {
    const dir = entry.kind === "dir";
    const ok = await confirmAction({
      title: `Supprimer « ${entry.name} » ?`,
      description: dir
        ? `Le dossier ${entry.path} et tout son contenu seront définitivement supprimés du serveur.`
        : `${entry.path} sera définitivement supprimé du serveur.`,
      confirmLabel: "Supprimer",
    });
    if (!ok) return;
    try {
      await api.servers.deletePath(server.id, entry.path, dir);
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  };

  const rename = (entry: RemoteEntry) =>
    setNameDialog({
      title: `Renommer « ${entry.name} »`,
      initial: entry.name,
      confirm: "Renommer",
      submit: async (name) => {
        await api.servers.renamePath(server.id, entry.path, name);
        await refresh();
      },
    });

  const newFolder = () =>
    cwd &&
    setNameDialog({
      title: "Nouveau dossier",
      initial: "",
      confirm: "Créer",
      submit: async (name) => {
        await api.servers.makeDir(server.id, cwd, name);
        await refresh();
      },
    });

  const openEntry = (entry: RemoteEntry) => (entry.isDir ? load(entry.path) : download(entry));

  const entryMenu = (entry: RemoteEntry) =>
    contextMenu(() => [
      { heading: entry.name },
      entry.isDir
        ? { label: "Ouvrir", icon: FolderOpen, onSelect: () => load(entry.path) }
        : { label: "Télécharger…", icon: ArrowDownToLine, onSelect: () => download(entry) },
      { label: "Renommer…", icon: Pencil, onSelect: () => rename(entry) },
      { separator: true },
      { label: "Copier le chemin", icon: Copy, hint: entry.path.length > 32 ? undefined : entry.path, onSelect: () => copyText(entry.path) },
      { separator: true },
      { label: "Supprimer", icon: Trash2, danger: true, onSelect: () => remove(entry) },
    ]);

  const finished = transfers.filter((t) => t.status !== "running").length;

  return (
    <div className="grid gap-3">
      <div className="flex items-center gap-1">
        <Button variant="ghost" size="icon" className="size-8" onClick={() => cwd && load(parentOf(cwd))} disabled={!cwd || cwd === "/"} aria-label="Dossier parent" title="Dossier parent">
          <ArrowUp />
        </Button>
        <Button variant="ghost" size="icon" className="size-8" onClick={() => load(null)} aria-label="Dossier personnel" title="Dossier personnel">
          <Home />
        </Button>
        {cwd ? <Breadcrumb path={cwd} onNavigate={load} /> : <span className="flex-1" />}
        <Button
          variant="ghost"
          size="icon"
          className="size-8"
          onClick={() => {
            writeStorage(HIDDEN_KEY, showHidden ? "0" : "1");
            setShowHidden(!showHidden);
          }}
          aria-label={showHidden ? "Masquer les fichiers cachés" : "Afficher les fichiers cachés"}
          title={showHidden ? "Masquer les fichiers cachés" : "Afficher les fichiers cachés"}
        >
          {showHidden ? <Eye /> : <EyeOff />}
        </Button>
        <Button variant="ghost" size="icon" className="size-8" onClick={newFolder} disabled={!cwd} aria-label="Nouveau dossier" title="Nouveau dossier">
          <FolderPlus />
        </Button>
        <Button variant="outline" size="sm" onClick={pickUpload} disabled={!cwd}>
          <Upload /> Envoyer
        </Button>
        <Button variant="ghost" size="icon" className="size-8" onClick={refresh} disabled={loading} aria-label="Actualiser" title="Actualiser">
          <RefreshCw className={cn(loading && "animate-spin")} />
        </Button>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <div
        ref={dropRef}
        className={cn("relative overflow-hidden rounded-lg border transition-colors", dragOver && "border-primary bg-primary/5")}
      >
        {!listing && !error && (
          <p className="flex items-center gap-2 px-3 py-6 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Lecture du dossier…
          </p>
        )}
        {listing && (
          <div className="max-h-[max(280px,calc(100vh-420px))] overflow-y-auto">
            <table className="w-full table-fixed text-sm">
              <thead className="sticky top-0 bg-background text-left text-xs text-muted-foreground">
                <tr className="border-b">
                  <th className="px-3 py-2 font-medium">Nom</th>
                  <th className="w-24 px-3 py-2 text-right font-medium">Taille</th>
                  <th className="w-36 px-3 py-2 font-medium">Modifié</th>
                  <th className="hidden w-28 px-3 py-2 font-medium lg:table-cell">Droits</th>
                  <th className="w-20 px-2 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y">
                {entries.map((e) => (
                  <tr
                    key={e.path}
                    className={cn("group cursor-default hover:bg-secondary/60", selected === e.path && "bg-secondary")}
                    onClick={() => setSelected(e.path)}
                    onDoubleClick={() => openEntry(e)}
                    onContextMenu={entryMenu(e)}
                  >
                    <td className="px-3 py-1.5">
                      <span className="flex min-w-0 items-center gap-2">
                        <EntryIcon entry={e} />
                        <span className={cn("truncate", e.name.startsWith(".") && "text-muted-foreground")} title={e.name}>
                          {e.name}
                        </span>
                      </span>
                    </td>
                    <td className="px-3 py-1.5 text-right text-xs text-muted-foreground tabular-nums">{e.isDir ? "—" : formatBytes(e.size)}</td>
                    <td className="px-3 py-1.5 text-xs text-muted-foreground tabular-nums">{e.modified ? dateFmt.format(e.modified * 1000) : "—"}</td>
                    <td className="hidden px-3 py-1.5 font-mono text-xs text-muted-foreground lg:table-cell">{e.mode}</td>
                    <td className="px-2 py-1">
                      <span className="flex justify-end opacity-0 group-hover:opacity-100 focus-within:opacity-100">
                        {!e.isDir && (
                          <Button variant="ghost" size="icon" className="size-7" onClick={() => download(e)} aria-label="Télécharger" title="Télécharger">
                            <ArrowDownToLine />
                          </Button>
                        )}
                        <Button variant="ghost" size="icon" className="size-7 hover:text-destructive" onClick={() => remove(e)} aria-label="Supprimer" title="Supprimer">
                          <Trash2 />
                        </Button>
                      </span>
                    </td>
                  </tr>
                ))}
                {entries.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-3 py-6 text-center text-sm text-muted-foreground">
                      Dossier vide.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
        {dragOver && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-background/70">
            <p className="flex items-center gap-2 text-sm font-medium text-primary">
              <Upload className="size-4" /> Déposer pour envoyer dans {cwd}
            </p>
          </div>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        Double-cliquez pour ouvrir un dossier ou télécharger un fichier. Glissez des fichiers depuis l'Explorateur sur la liste pour les envoyer.
      </p>

      {transfers.length > 0 && (
        <div className="grid gap-2">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium">Transferts</p>
            {finished > 0 && (
              <Button variant="ghost" size="sm" onClick={() => dismissFinished(server.id)}>
                Effacer les terminés
              </Button>
            )}
          </div>
          <ul className="divide-y rounded-lg border">
            {transfers.map((t) => (
              <TransferRow key={t.id} t={t} />
            ))}
          </ul>
        </div>
      )}

      <NameDialog
        title={nameDialog?.title ?? null}
        initial={nameDialog?.initial ?? ""}
        confirmLabel={nameDialog?.confirm ?? "OK"}
        onSubmit={(n) => nameDialog?.submit(n) ?? Promise.resolve()}
        onClose={() => setNameDialog(null)}
      />
    </div>
  );
}
