import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { KeyRound } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { api } from "@/services/tauri";
import type { Server } from "@/types";

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="grid gap-1.5">
      <span className="text-sm font-medium">{label}</span>
      {children}
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </label>
  );
}

const AUTO_KEY = "__auto__";
const OTHER_KEY = "__other__";

export function ServerDialog({
  server,
  open: isOpen,
  onOpenChange,
  onSaved,
}: {
  server: Server | null;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onSaved: (list: Server[], name: string) => void;
}) {
  const [name, setName] = useState("");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("22");
  const [user, setUser] = useState("");
  const [keyPath, setKeyPath] = useState<string | null>(null);
  const [keys, setKeys] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setName(server?.name ?? "");
    setHost(server?.host ?? "");
    setPort(String(server?.port ?? 22));
    setUser(server?.user ?? "");
    setKeyPath(server?.keyPath ?? null);
    setError(null);
    api.servers.findKeys().then(setKeys).catch(() => setKeys([]));
  }, [isOpen, server]);

  const browseKey = async () => {
    const file = await open({ multiple: false, directory: false, title: "Clé privée SSH" });
    if (typeof file === "string") setKeyPath(file);
  };

  const submit = async () => {
    try {
      const list = await api.servers.save({
        id: server?.id ?? null,
        name,
        host,
        port: Number(port) || 22,
        user: user || null,
        keyPath,
      });
      onSaved(list, name.trim());
      onOpenChange(false);
    } catch (e) {
      setError(String(e));
    }
  };

  const keyOptions = keyPath && !keys.includes(keyPath) ? [...keys, keyPath] : keys;

  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{server ? "Modifier le serveur" : "Ajouter un serveur"}</DialogTitle>
          <DialogDescription>
            Connexion par clé SSH via OpenSSH. Aucun mot de passe n'est enregistré ; vos alias de <code>~/.ssh/config</code> fonctionnent aussi.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <Field label="Nom">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="VPS production" maxLength={80} />
          </Field>
          <div className="grid grid-cols-[1fr_96px] gap-3">
            <Field label="Hôte" hint="Nom de domaine, IP ou alias ~/.ssh/config">
              <Input value={host} onChange={(e) => setHost(e.target.value)} placeholder="exemple.com" />
            </Field>
            <Field label="Port">
              <Input value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, ""))} inputMode="numeric" maxLength={5} />
            </Field>
          </div>
          <Field label="Utilisateur" hint="Laisser vide pour utiliser celui de ~/.ssh/config">
            <Input value={user} onChange={(e) => setUser(e.target.value)} placeholder="deploy" />
          </Field>
          <Field label="Clé privée">
            <div className="flex gap-2">
              <Select
                className="min-w-0 flex-1"
                value={keyPath ?? AUTO_KEY}
                onChange={(e) => {
                  if (e.target.value === OTHER_KEY) browseKey();
                  else setKeyPath(e.target.value === AUTO_KEY ? null : e.target.value);
                }}
              >
                <option value={AUTO_KEY}>Automatique (agent, clés par défaut, ~/.ssh/config)</option>
                {keyOptions.map((k) => (
                  <option key={k} value={k}>{k}</option>
                ))}
                <option value={OTHER_KEY}>Autre fichier…</option>
              </Select>
              <Button variant="outline" size="icon" onClick={browseKey} aria-label="Choisir une clé" title="Choisir une clé">
                <KeyRound />
              </Button>
            </div>
          </Field>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Annuler</Button>
          <Button onClick={submit} disabled={!name.trim() || !host.trim()}>Enregistrer</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
