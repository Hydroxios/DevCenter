import { invoke } from "@tauri-apps/api/core";

import { isTauri } from "@/services/tauri";

type Level = "error" | "warn" | "info";

/** Écrit une ligne dans le journal de DevCenter (fichier dans le dossier des logs de l'app). */
export function log(level: Level, message: string) {
  if (!isTauri()) {
    console[level](message);
    return;
  }
  invoke("client_log", { level, message: message.slice(0, 8000) }).catch(() => {
    /* le journal ne doit jamais faire planter l'interface */
  });
}

/** Erreur avec sa pile, pour le journal. */
export function reportError(context: string, error: unknown, extra?: string) {
  const e = error instanceof Error ? error : new Error(String(error));
  log("error", [`${context} : ${e.name}: ${e.message}`, e.stack, extra].filter(Boolean).join("\n"));
}

let installed = false;

/** Capture les erreurs non gérées (exceptions et promesses rejetées) dans le journal. */
export function installGlobalErrorLogging() {
  if (installed) return;
  installed = true;
  window.addEventListener("error", (e) => reportError("Erreur non gérée", e.error ?? e.message));
  window.addEventListener("unhandledrejection", (e) => reportError("Promesse rejetée non gérée", e.reason));
}
