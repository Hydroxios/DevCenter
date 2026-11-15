import { useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { Download, HardDriveDownload, Upload } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { api } from "@/services/tauri";
import { useSettings } from "@/stores/settings";
import { useWorkspaces } from "@/stores/workspaces";

export function BackupSettings() {
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const loadSettings = useSettings((s) => s.load);
  const refreshWorkspaces = useWorkspaces((s) => s.refresh);
  const refreshRefs = useWorkspaces((s) => s.refreshRefs);

  const exportConfig = async () => {
    const date = new Date().toISOString().slice(0, 10);
    const path = await save({ title: "Exporter la configuration", defaultPath: `devcenter-${date}.json`, filters: [{ name: "JSON", extensions: ["json"] }] });
    if (!path) return;
    try {
      await api.backup.export(path);
      setMessage({ text: `Configuration exportée dans ${path}`, error: false });
    } catch (e) {
      setMessage({ text: String(e), error: true });
    }
  };

  const importConfig = async () => {
    const path = await open({ title: "Importer une configuration", multiple: false, directory: false, filters: [{ name: "JSON", extensions: ["json"] }] });
    if (typeof path !== "string") return;
    try {
      const s = await api.backup.import(path);
      const fmt = (m: Record<string, number>) =>
        Object.entries(m)
          .map(([k, v]) => `${v} ${k}`)
          .join(", ");
      const added = fmt(s.added);
      const skipped = fmt(s.skipped);
      setMessage({
        text: `${added ? `Ajouté : ${added}.` : "Rien de nouveau à ajouter."}${skipped ? ` Déjà présent ou ignoré : ${skipped}.` : ""} Les automatisations importées sont désactivées : vérifiez-les avant de les activer.`,
        error: false,
      });
      await Promise.all([loadSettings(), refreshWorkspaces(), refreshRefs()]);
    } catch (e) {
      setMessage({ text: String(e), error: true });
    }
  };

  return (
    <Card>
      <CardHeader>
        <div>
          <h3 className="font-semibold">Sauvegarde et synchronisation</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Exportez projets, applications, workspaces, serveurs et automatisations dans un fichier JSON (sans aucun secret). Placez-le dans OneDrive
            ou Dropbox pour retrouver votre configuration sur un autre PC ; l'import fusionne sans créer de doublons.
          </p>
        </div>
        <HardDriveDownload className="size-4 text-muted-foreground" />
      </CardHeader>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" onClick={exportConfig}><Download /> Exporter…</Button>
        <Button variant="outline" onClick={importConfig}><Upload /> Importer…</Button>
      </div>
      {message && <p className={message.error ? "text-sm text-destructive" : "text-sm text-success"}>{message.text}</p>}
    </Card>
  );
}
