import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { FolderSearch, Loader2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { api } from "@/services/tauri";
import type { Project, ScanCandidate } from "@/types";

export function ScanDialog({ onImported, compact = false }: { onImported: (projects: Project[]) => void; compact?: boolean }) {
  const [isOpen, setIsOpen] = useState(false);
  const [root, setRoot] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [candidates, setCandidates] = useState<ScanCandidate[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setRoot(null);
    setCandidates(null);
    setSelected(new Set());
    setError(null);
  };

  const pickAndScan = async () => {
    const dir = await open({ directory: true, multiple: false, title: "Dossier à analyser" });
    if (typeof dir !== "string") return;
    setRoot(dir);
    setScanning(true);
    setError(null);
    try {
      const found = await api.projects.scan(dir);
      setCandidates(found);
      setSelected(new Set(found.map((c) => c.path)));
    } catch (e) {
      setError(String(e));
    } finally {
      setScanning(false);
    }
  };

  const toggle = (path: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const importSelected = async () => {
    try {
      onImported(await api.projects.add([...selected]));
      setIsOpen(false);
      reset();
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(o) => {
        setIsOpen(o);
        if (!o) reset();
      }}
    >
      {compact ? (
        <Button variant="ghost" size="icon" className="size-8" onClick={() => setIsOpen(true)} aria-label="Détecter des projets" title="Détecter des projets">
          <FolderSearch />
        </Button>
      ) : (
        <Button variant="outline" onClick={() => setIsOpen(true)}>
          <FolderSearch /> Détecter
        </Button>
      )}
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Détecter des projets</DialogTitle>
          <DialogDescription>
            Analyse un dossier (4 niveaux maximum) et repère les projets Git, Node, Rust, Python, Go et PHP.
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-2">
          <Button variant="secondary" onClick={pickAndScan} disabled={scanning}>
            {scanning ? <Loader2 className="animate-spin" /> : <FolderSearch />}
            {root ? "Changer de dossier" : "Choisir un dossier"}
          </Button>
          {root && <span className="truncate text-sm text-muted-foreground" title={root}>{root}</span>}
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}

        {candidates && (
          candidates.length === 0 ? (
            <p className="text-sm text-muted-foreground">Aucun nouveau projet trouvé dans ce dossier.</p>
          ) : (
            <ul className="max-h-80 divide-y overflow-y-auto rounded-lg border">
              {candidates.map((c) => (
                <li key={c.path}>
                  <label className="flex cursor-pointer items-start gap-3 px-3 py-2 hover:bg-accent/40">
                    <input
                      type="checkbox"
                      className="mt-1 accent-[var(--primary)]"
                      checked={selected.has(c.path)}
                      onChange={() => toggle(c.path)}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-1.5">
                        <span className="text-sm font-medium">{c.name}</span>
                        {[...c.frameworks, ...c.languages].slice(0, 4).map((t) => (
                          <Badge key={t} variant="outline">{t}</Badge>
                        ))}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground" title={c.path}>{c.path}</span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => setIsOpen(false)}>
            Annuler
          </Button>
          <Button onClick={importSelected} disabled={selected.size === 0}>
            Importer {selected.size > 0 && `(${selected.size})`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
