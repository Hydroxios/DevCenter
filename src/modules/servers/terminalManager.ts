import { useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";

import { api } from "@/services/tauri";

/**
 * Terminaux persistants : le terminal xterm et sa session restent vivants en dehors de React.
 * Changer de page ou de serveur détache simplement l'élément du DOM ; revenir le rattache,
 * avec tout l'historique affiché. Seul « Déconnecter » (ou la suppression du serveur) ferme la session.
 */

export type TermState = "idle" | "connecting" | "open" | "closed";

interface Entry {
  term: Terminal;
  fit: FitAddon;
  host: HTMLDivElement;
  opened: boolean;
  session: number | null;
  state: TermState;
  error: string | null;
  onExit?: () => void;
  observer?: ResizeObserver;
}

const entries = new Map<string, Entry>();
const subscribers = new Set<() => void>();
let version = 0;
let listening = false;

function notify() {
  version++;
  subscribers.forEach((cb) => cb());
}

function bySession(id: number) {
  for (const e of entries.values()) if (e.session === id) return e;
  return undefined;
}

function ensureListeners() {
  if (listening) return;
  listening = true;
  listen<{ id: number; data: string }>("terminal://data", ({ payload }) => {
    bySession(payload.id)?.term.write(payload.data);
  });
  listen<number>("terminal://exit", ({ payload }) => {
    const e = bySession(payload);
    if (!e) return;
    e.session = null;
    e.state = "closed";
    e.term.write("\r\n\x1b[90m— session terminée —\x1b[0m\r\n");
    e.onExit?.();
    notify();
  });
}

function create(): Entry {
  ensureListeners();
  const term = new Terminal({
    cursorBlink: true,
    fontFamily: '"Geist Mono Variable", "Cascadia Mono", Consolas, monospace',
    fontSize: 13,
    scrollback: 5000,
    theme: {
      background: "#000000",
      foreground: "#d4d4d8",
      cursor: "#22d3ee",
      cursorAccent: "#000000",
      selectionBackground: "#22d3ee55",
      cyan: "#22d3ee",
      brightCyan: "#67e8f9",
    },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  const host = document.createElement("div");
  host.style.width = "100%";
  host.style.height = "100%";
  const entry: Entry = { term, fit, host, opened: false, session: null, state: "idle", error: null };
  term.onData((data) => {
    if (entry.session !== null) api.terminal.write(entry.session, data).catch(() => {});
  });
  term.onResize(({ cols, rows }) => {
    if (entry.session !== null) api.terminal.resize(entry.session, cols, rows).catch(() => {});
  });
  return entry;
}

function get(key: string): Entry {
  let e = entries.get(key);
  if (!e) {
    e = create();
    entries.set(key, e);
  }
  return e;
}

export const terminals = {
  /** Affiche le terminal dans `container` (le crée au premier affichage). */
  attach(key: string, container: HTMLElement, onExit?: () => void) {
    const e = get(key);
    e.onExit = onExit;
    container.appendChild(e.host);
    if (!e.opened) {
      e.term.open(e.host);
      e.opened = true;
    }
    e.observer?.disconnect();
    e.observer = new ResizeObserver(() => {
      if (e.host.isConnected && e.host.offsetParent) e.fit.fit();
    });
    e.observer.observe(container);
    requestAnimationFrame(() => e.fit.fit());
  },

  /** Retire le terminal de l'écran sans couper la session. */
  detach(key: string) {
    const e = entries.get(key);
    if (!e) return;
    e.observer?.disconnect();
    e.observer = undefined;
    e.onExit = undefined;
    e.host.remove();
  },

  async connect(key: string, open: (cols: number, rows: number) => Promise<number>, intro?: string) {
    const e = get(key);
    if (e.state === "open" || e.state === "connecting") return;
    e.state = "connecting";
    e.error = null;
    notify();
    e.term.reset();
    if (intro) e.term.write(`\x1b[90m${intro}\x1b[0m\r\n`);
    try {
      e.session = await open(e.term.cols, e.term.rows);
      e.state = "open";
      e.term.focus();
    } catch (err) {
      e.error = String(err);
      e.state = "closed";
    }
    notify();
  },

  disconnect(key: string) {
    const e = entries.get(key);
    if (e?.session != null) api.terminal.close(e.session).catch(() => {});
  },

  /** Ferme la session et libère le terminal. */
  dispose(key: string) {
    const e = entries.get(key);
    if (!e) return;
    if (e.session !== null) api.terminal.close(e.session).catch(() => {});
    e.observer?.disconnect();
    e.host.remove();
    e.term.dispose();
    entries.delete(key);
    notify();
  },

  focus(key: string) {
    entries.get(key)?.term.focus();
  },

  info(key: string): { state: TermState; error: string | null } {
    const e = entries.get(key);
    return { state: e?.state ?? "idle", error: e?.error ?? null };
  },

  /** Clés des terminaux dont la session est ouverte. */
  openKeys(): string[] {
    return [...entries].filter(([, e]) => e.state === "open").map(([k]) => k);
  },
};

function subscribe(cb: () => void) {
  subscribers.add(cb);
  return () => subscribers.delete(cb);
}

/** Re-render du composant à chaque changement d'état d'un terminal. */
export function useTerminalsVersion() {
  return useSyncExternalStore(subscribe, () => version);
}
