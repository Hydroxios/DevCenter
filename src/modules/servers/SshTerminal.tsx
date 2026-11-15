import { useEffect, useId, useRef } from "react";
import "@xterm/xterm/css/xterm.css";
import { Plug, PlugZap, RotateCcw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { api } from "@/services/tauri";
import type { Server } from "@/types";
import { terminals, useTerminalsVersion, type TermState } from "./terminalManager";

export const sshKey = (serverId: number) => `ssh:${serverId}`;

/**
 * Terminal xterm.js relié à un pseudo-terminal Rust.
 * - `persistKey` : la session survit au démontage (changement de page ou de serveur).
 * - sans `persistKey` : terminal éphémère, fermé avec le composant (ex. ssh-add).
 */
export function PtyTerminal({
  open,
  intro,
  persistKey,
  autoStart = false,
  onExit,
  className,
  renderControls,
}: {
  open: (cols: number, rows: number) => Promise<number>;
  intro?: string;
  persistKey?: string;
  autoStart?: boolean;
  onExit?: () => void;
  className?: string;
  renderControls?: (ctx: { state: TermState; connect: () => void; disconnect: () => void }) => React.ReactNode;
}) {
  const ephemeralKey = `pty:${useId()}`;
  const key = persistKey ?? ephemeralKey;
  const container = useRef<HTMLDivElement>(null);
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;
  const openRef = useRef(open);
  openRef.current = open;
  useTerminalsVersion();
  const { state, error } = terminals.info(key);

  const connect = () => terminals.connect(key, (c, r) => openRef.current(c, r), intro);
  const disconnect = () => terminals.disconnect(key);

  useEffect(() => {
    terminals.attach(key, container.current!, () => onExitRef.current?.());
    if (autoStart && terminals.info(key).state === "idle") connect();
    else terminals.focus(key);
    return () => {
      if (persistKey) terminals.detach(key);
      else terminals.dispose(key);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return (
    <div className="grid gap-3">
      {renderControls?.({ state, connect, disconnect })}
      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className={cn("overflow-hidden rounded-lg border bg-black p-2", className ?? "h-[460px]")}>
        <div ref={container} className="h-full w-full" />
      </div>
    </div>
  );
}

/** Terminal SSH interactif sur un serveur enregistré ; la session reste ouverte en arrière-plan. */
export function SshTerminal({ server, className }: { server: Server; className?: string }) {
  return (
    <PtyTerminal
      className={className}
      persistKey={sshKey(server.id)}
      open={(cols, rows) => api.terminal.open(server.id, cols, rows)}
      intro={`Connexion à ${server.user ? `${server.user}@` : ""}${server.host}:${server.port}…`}
      renderControls={({ state, connect, disconnect }) => (
        <div className="flex items-center gap-2">
          {state === "open" ? (
            <Button variant="outline" size="sm" onClick={disconnect}>
              <PlugZap /> Déconnecter
            </Button>
          ) : (
            <Button size="sm" onClick={connect} disabled={state === "connecting"}>
              {state === "closed" ? <RotateCcw /> : <Plug />}
              {state === "closed" ? "Reconnecter" : "Se connecter"}
            </Button>
          )}
          <span className="text-xs text-muted-foreground">
            {state === "open"
              ? "La session reste ouverte si vous changez de page ou de serveur."
              : "Session interactive : la phrase de passe de la clé peut être saisie ici si besoin."}
          </span>
        </div>
      )}
    />
  );
}
