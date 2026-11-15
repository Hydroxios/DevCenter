import { api } from "@/services/tauri";
import { PtyTerminal } from "@/modules/servers/SshTerminal";

/** Terminal `gh auth login` (chargé à la demande : embarque xterm.js). */
export default function GithubLogin({ onExit }: { onExit: () => void }) {
  return (
    <PtyTerminal
      autoStart
      className="h-72"
      intro="Connexion à GitHub : copiez le code affiché, puis validez dans le navigateur qui s'ouvre."
      open={(cols, rows) => api.github.loginTerminal(cols, rows)}
      onExit={onExit}
    />
  );
}
