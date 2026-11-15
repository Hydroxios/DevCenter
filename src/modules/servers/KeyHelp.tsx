import { useCallback, useEffect, useState } from "react";
import { Check, Copy, KeyRound, ShieldAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api } from "@/services/tauri";
import type { KeyStatus, Server } from "@/types";
import { PtyTerminal } from "./SshTerminal";

const ENABLE_AGENT = "Set-Service ssh-agent -StartupType Automatic; Start-Service ssh-agent";

function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2 rounded-md bg-black border px-3 py-2">
      <code className="min-w-0 flex-1 overflow-x-auto font-mono text-xs whitespace-nowrap text-[#d4d4d8] select-text">{command}</code>
      <Button
        variant="ghost"
        size="icon"
        className="size-7 shrink-0 text-[#d4d4d8] hover:bg-white/10 hover:text-primary"
        onClick={async () => {
          await navigator.clipboard.writeText(command);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        }}
        aria-label="Copier la commande"
      >
        {copied ? <Check /> : <Copy />}
      </Button>
    </div>
  );
}

/**
 * Aide affichée quand la connexion échoue parce que la clé est protégée par une phrase de passe :
 * active l'agent SSH (commande administrateur à lancer soi-même) puis déverrouille la clé via ssh-add.
 */
export function KeyHelp({ server, onFixed }: { server: Server; onFixed: () => void }) {
  const [status, setStatus] = useState<KeyStatus | null>(null);
  const [unlocking, setUnlocking] = useState(false);

  const check = useCallback(() => {
    api.servers.keyStatus(server.id).then(setStatus).catch(() => setStatus(null));
  }, [server.id]);

  useEffect(() => {
    check();
  }, [check]);

  if (!status || !status.encrypted || status.keyLoaded) return null;

  return (
    <Card className="gap-3 border-warning/40 bg-warning/8">
      <div className="flex items-start gap-3">
        <ShieldAlert className="mt-0.5 size-5 shrink-0 text-warning" />
        <div className="grid gap-1 text-sm">
          <p className="font-medium">Votre clé est protégée par une phrase de passe</p>
          <p className="text-muted-foreground">
            Le terminal peut vous la demander, mais pas le monitoring ni les actions en arrière-plan. Confiez-la une fois à
            l'agent SSH de Windows : DevCenter ne voit jamais la phrase de passe.
          </p>
        </div>
      </div>

      {status.agent === "unavailable" ? (
        <div className="grid gap-2 text-sm">
          <p>
            <b>1.</b> L'agent SSH est désactivé (réglage par défaut de Windows). Ouvrez PowerShell <b>en administrateur</b> et lancez :
          </p>
          <CopyCommand command={ENABLE_AGENT} />
          <p>
            <b>2.</b> Revenez ici et cliquez sur « Vérifier », puis déverrouillez la clé.
          </p>
          <div>
            <Button variant="outline" size="sm" onClick={check}>Vérifier</Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={() => setUnlocking(true)}>
            <KeyRound /> Déverrouiller la clé
          </Button>
          <span className="text-xs text-muted-foreground">L'agent de Windows la conserve, même après un redémarrage.</span>
        </div>
      )}

      <Dialog open={unlocking} onOpenChange={setUnlocking}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Déverrouiller la clé</DialogTitle>
            <DialogDescription>
              Saisissez la phrase de passe de <code>{status.keyPath ?? "vos clés par défaut"}</code>. Elle est transmise directement à <code>ssh-add</code>.
            </DialogDescription>
          </DialogHeader>
          {unlocking && (
            <PtyTerminal
              autoStart
              className="h-56"
              open={(cols, rows) => api.terminal.openSshAdd(server.id, cols, rows)}
              onExit={() => {
                window.setTimeout(() => {
                  setUnlocking(false);
                  check();
                  onFixed();
                }, 900);
              }}
            />
          )}
        </DialogContent>
      </Dialog>
    </Card>
  );
}
