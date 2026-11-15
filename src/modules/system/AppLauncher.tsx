import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { AppWindow, FolderOpen, Play, Plus, Trash2, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api } from "@/services/tauri";
import type { AppShortcut } from "@/types";

function baseName(path: string) {
  return (path.split(/[\\/]/).pop() ?? path).replace(/\.(exe|lnk|appref-ms)$/i, "");
}

function AddAppDialog({ onAdded }: { onAdded: (apps: AppShortcut[]) => void }) {
  const [openState, setOpenState] = useState(false);
  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setPath("");
    setName("");
    setError(null);
  };

  const browse = async () => {
    const selected = await open({
      multiple: false,
      directory: false,
      title: "Choisir une application",
      filters: [{ name: "Applications", extensions: ["exe", "lnk", "appref-ms"] }],
    });
    if (typeof selected === "string") {
      setPath(selected);
      if (!name) setName(baseName(selected));
      setError(null);
    }
  };

  const save = async () => {
    try {
      onAdded(await api.apps.add(name, path));
      setOpenState(false);
      reset();
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <Dialog
      open={openState}
      onOpenChange={(o) => {
        setOpenState(o);
        if (!o) reset();
      }}
    >
      <Button variant="outline" size="sm" onClick={() => setOpenState(true)}>
        <Plus /> Ajouter
      </Button>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Ajouter une application</DialogTitle>
          <DialogDescription>Un exécutable (.exe) ou un raccourci (.lnk) à lancer depuis DevCenter.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="flex gap-2">
            <Input readOnly value={path} placeholder="Aucun fichier choisi" aria-label="Chemin" />
            <Button variant="outline" onClick={browse}>
              <FolderOpen /> Parcourir
            </Button>
          </div>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nom" aria-label="Nom" maxLength={100} />
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpenState(false)}>
            Annuler
          </Button>
          <Button onClick={save} disabled={!path || !name.trim()}>
            Enregistrer
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function AppLauncher() {
  const [apps, setApps] = useState<AppShortcut[]>([]);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);

  useEffect(() => {
    api.apps.list().then(setApps).catch((e) => setMessage({ text: String(e), error: true }));
  }, []);

  const launch = async (app: AppShortcut) => {
    try {
      await api.apps.launch(app.id);
      setMessage({ text: `${app.name} lancé.`, error: false });
    } catch (e) {
      setMessage({ text: String(e), error: true });
    }
  };

  const remove = async (app: AppShortcut) => {
    try {
      setApps(await api.apps.remove(app.id));
    } catch (e) {
      setMessage({ text: String(e), error: true });
    }
  };

  return (
    <Card>
      <CardHeader className="items-center">
        <CardTitle>Applications</CardTitle>
        <AddAppDialog onAdded={setApps} />
      </CardHeader>

      {apps.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Ajoutez vos applications (Cursor, Docker Desktop, navigateur…) pour les lancer en un clic.
        </p>
      ) : (
        <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {apps.map((app) => (
            <li key={app.id} className="group flex items-center gap-3 rounded-lg border px-3 py-2">
              {app.exists ? (
                <AppWindow className="size-4 shrink-0 text-muted-foreground" />
              ) : (
                <TriangleAlert className="size-4 shrink-0 text-warning" aria-label="Fichier introuvable" />
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{app.name}</p>
                <p className="truncate text-xs text-muted-foreground" title={app.path}>
                  {app.exists ? app.path : "Fichier introuvable"}
                </p>
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="size-8 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                onClick={() => remove(app)}
                aria-label={`Retirer ${app.name}`}
              >
                <Trash2 />
              </Button>
              <Button size="icon" className="size-8" onClick={() => launch(app)} disabled={!app.exists} aria-label={`Lancer ${app.name}`}>
                <Play />
              </Button>
            </li>
          ))}
        </ul>
      )}

      {message && (
        <p className={message.error ? "text-sm text-destructive" : "text-sm text-success"} role="status">
          {message.text}
        </p>
      )}
    </Card>
  );
}
