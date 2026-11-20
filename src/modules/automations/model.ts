import {
  AppWindow,
  Bell,
  Code2,
  FolderOpen,
  GitBranch,
  Globe,
  Hourglass,
  Layers,
  Network,
  Play,
  PlugZap,
  Send,
  Square,
  SquareChevronRight,
  SquareStop,
  Unplug,
  type LucideIcon,
} from "lucide-react";

import type { AutomationCondition, AutomationInput, AutomationStep, AutomationTrigger } from "@/types";

export const DAYS = ["Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"];

const refName = (items: { id: number; name: string }[] | undefined, id: number | null) =>
  id === null ? null : (items?.find((i) => i.id === id)?.name ?? `#${id}`);

/** Jeton de webhook : 256 bits aléatoires en hexadécimal. */
export function newWebhookToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Déclencheurs sur événement (pas d'horaire : réagissent à ce qui se passe). */
export const EVENT_TRIGGERS: AutomationTrigger["kind"][] = ["scriptFailed", "serverDown", "serverUp", "containerStopped", "gitChange", "webhook"];

export interface StepVar {
  name: string;
  description: string;
}

/** Variables `{{nom}}` présentes dans toutes les exécutions (voir `automations/vars.rs`). */
const BASE_VARS: StepVar[] = [
  { name: "automation", description: "nom de l'automatisation" },
  { name: "context", description: "résumé de l'événement (comme dans l'historique)" },
  { name: "date", description: "date du jour (JJ/MM/AAAA)" },
  { name: "time", description: "heure (HH:MM)" },
  { name: "datetime", description: "date et heure ISO 8601" },
  { name: "origin", description: "manual, schedule, startup, event ou webhook" },
];

const EVENT_VARS: Partial<Record<AutomationTrigger["kind"], StepVar[]>> = {
  gitChange: [
    { name: "project", description: "nom du projet" },
    { name: "branch", description: "branche courante" },
    { name: "previous_branch", description: "branche avant le changement" },
    { name: "commit", description: "hash court (7 caractères)" },
    { name: "commit_full", description: "hash complet" },
    { name: "message", description: "titre du commit" },
  ],
  scriptFailed: [
    { name: "project", description: "nom du projet" },
    { name: "script", description: "nom du script" },
    { name: "code", description: "code de sortie" },
  ],
  serverDown: [
    { name: "server", description: "nom du serveur" },
    { name: "state", description: "« injoignable »" },
    { name: "error", description: "raison de l'échec" },
  ],
  serverUp: [
    { name: "server", description: "nom du serveur" },
    { name: "state", description: "« joignable »" },
    { name: "latency", description: "latence en ms" },
  ],
  containerStopped: [
    { name: "server", description: "nom du serveur" },
    { name: "container", description: "nom du conteneur" },
    { name: "state", description: "nouvel état (exited, supprimé…)" },
  ],
  webhook: [
    { name: "caller", description: "adresse IP de l'appelant" },
    { name: "body", description: "corps de la requête reçue" },
  ],
};

/** Variables utilisables dans les étapes avec ce déclencheur : celles de l'événement d'abord. */
export function stepVars(kind: AutomationTrigger["kind"]): StepVar[] {
  return [...(EVENT_VARS[kind] ?? []), ...BASE_VARS];
}

export function triggerLabel(t: AutomationTrigger, refs?: Refs): string {
  switch (t.kind) {
    case "scriptFailed": {
      const p = refName(refs?.projects, t.projectId);
      const target = [p, t.script.trim() || null].filter(Boolean).join(" › ");
      return target ? `Quand ${target} plante` : "Quand un script plante";
    }
    case "serverDown":
    case "serverUp": {
      const s = refName(refs?.servers, t.serverId) ?? "un serveur";
      return t.kind === "serverDown" ? `Quand ${s} devient injoignable` : `Quand ${s} redevient joignable`;
    }
    case "containerStopped": {
      const s = refName(refs?.servers, t.serverId);
      return `Quand ${t.container.trim() ? `le conteneur ${t.container.trim()}` : "un conteneur"} s'arrête${s ? ` (${s})` : ""}`;
    }
    case "gitChange": {
      const what = t.onCommit && t.onBranch ? "Commit ou branche" : t.onCommit ? "Nouveau commit" : "Changement de branche";
      const p = refName(refs?.projects, t.projectId);
      return p ? `${what} · ${p}` : `${what} (tous les projets)`;
    }
    case "webhook":
      return "Webhook local";
    case "manual":
      return "Manuel";
    case "interval":
      return t.minutes % 60 === 0 ? `Toutes les ${t.minutes / 60} h` : `Toutes les ${t.minutes} min`;
    case "daily": {
      const days =
        t.days.length === 0 || t.days.length === 7
          ? "tous les jours"
          : t.days.length === 5 && [0, 1, 2, 3, 4].every((d) => t.days.includes(d))
            ? "en semaine"
            : [...t.days].sort().map((d) => DAYS[d]).join(", ");
      return `${t.time}, ${days}`;
    }
    case "appStart":
      return "Au démarrage de DevCenter";
  }
}

export const STEP_KINDS: { kind: AutomationStep["kind"]; label: string; icon: LucideIcon; group: string }[] = [
  { kind: "startWorkspace", label: "Démarrer un workspace", icon: Layers, group: "Workspaces" },
  { kind: "stopWorkspace", label: "Arrêter un workspace", icon: SquareStop, group: "Workspaces" },
  { kind: "runScript", label: "Lancer un script", icon: Play, group: "Projets" },
  { kind: "stopScript", label: "Arrêter un script", icon: Square, group: "Projets" },
  { kind: "openEditor", label: "Ouvrir dans l'éditeur", icon: Code2, group: "Projets" },
  { kind: "openFolder", label: "Ouvrir un dossier", icon: FolderOpen, group: "Projets" },
  { kind: "launchApp", label: "Lancer une application", icon: AppWindow, group: "Ouvrir" },
  { kind: "openUrl", label: "Ouvrir une URL", icon: Globe, group: "Ouvrir" },
  { kind: "httpRequest", label: "Requête HTTP", icon: Send, group: "Ouvrir" },
  { kind: "sshCommand", label: "Commande SSH", icon: SquareChevronRight, group: "Serveurs" },
  { kind: "openTunnel", label: "Ouvrir un tunnel", icon: Network, group: "Serveurs" },
  { kind: "closeTunnel", label: "Fermer un tunnel", icon: Unplug, group: "Serveurs" },
  { kind: "notify", label: "Notifier", icon: Bell, group: "Contrôle" },
  { kind: "wait", label: "Attendre", icon: Hourglass, group: "Contrôle" },
  { kind: "waitForPort", label: "Attendre un port", icon: PlugZap, group: "Contrôle" },
  { kind: "condition", label: "Continuer seulement si…", icon: GitBranch, group: "Contrôle" },
];

export const stepIcon = (kind: AutomationStep["kind"]) => STEP_KINDS.find((k) => k.kind === kind)!.icon;

export const CONDITION_KINDS: { kind: AutomationCondition["kind"]; label: string; negLabel: string }[] = [
  { kind: "processRunning", label: "le processus est lancé", negLabel: "le processus n'est pas lancé" },
  { kind: "serverReachable", label: "le serveur est joignable", negLabel: "le serveur est injoignable" },
  { kind: "workspaceActive", label: "le workspace est actif", negLabel: "le workspace n'est pas actif" },
  { kind: "portOpen", label: "le port est ouvert", negLabel: "le port est fermé" },
  { kind: "cpuAbove", label: "le CPU dépasse", negLabel: "le CPU ne dépasse pas" },
  { kind: "memoryAbove", label: "la RAM dépasse", negLabel: "la RAM ne dépasse pas" },
  { kind: "timeBetween", label: "l'heure est entre", negLabel: "l'heure n'est pas entre" },
];

export interface Refs {
  projects: { id: number; name: string }[];
  apps: { id: number; name: string }[];
  workspaces: { id: number; name: string }[];
  servers: { id: number; name: string }[];
  /** Commandes serveur enregistrées (`serverId` null = tous les serveurs). */
  snippets: { id: number; name: string; serverId: number | null }[];
  /** Tunnels SSH, nommés « tunnel (serveur) ». */
  tunnels: { id: number; name: string }[];
}

/** Commandes enregistrées utilisables sur un serveur. */
export const snippetsFor = (refs: Refs, serverId: number) => refs.snippets.filter((s) => s.serverId === null || s.serverId === serverId);

export function defaultCondition(kind: AutomationCondition["kind"], refs: Refs): AutomationCondition {
  switch (kind) {
    case "processRunning":
      return { kind, name: "Docker Desktop.exe", negate: false };
    case "serverReachable":
      return { kind, serverId: refs.servers[0]?.id ?? 0, negate: true };
    case "workspaceActive":
      return { kind, workspaceId: refs.workspaces[0]?.id ?? 0, negate: false };
    case "portOpen":
      return { kind, host: "localhost", port: 3000, negate: false };
    case "cpuAbove":
      return { kind, percent: 90, negate: false };
    case "memoryAbove":
      return { kind, percent: 90, negate: false };
    case "timeBetween":
      return { kind, start: "09:00", end: "19:00", negate: false };
  }
}

export function defaultStep(kind: AutomationStep["kind"], refs: Refs): AutomationStep {
  const projectId = refs.projects[0]?.id ?? 0;
  const workspaceId = refs.workspaces[0]?.id ?? 0;
  switch (kind) {
    case "startWorkspace":
    case "stopWorkspace":
      return { kind, workspaceId };
    case "runScript":
      return { kind, projectId, script: "dev", openBrowser: false };
    case "stopScript":
      return { kind, projectId, script: "dev" };
    case "openEditor":
    case "openFolder":
      return { kind, projectId };
    case "launchApp":
      return { kind, appId: refs.apps[0]?.id ?? 0 };
    case "openUrl":
      return { kind, url: "http://localhost:3000" };
    case "openTunnel":
    case "closeTunnel":
      return { kind, tunnelId: refs.tunnels[0]?.id ?? 0 };
    case "httpRequest":
      return { kind, method: "GET", url: "http://localhost:3000/health", headers: "", body: "", expectStatus: "", timeoutSecs: 30 };
    case "sshCommand": {
      const serverId = refs.servers[0]?.id ?? 0;
      const snippet = snippetsFor(refs, serverId)[0];
      return { kind, serverId, snippetId: snippet?.id ?? null, command: snippet ? "" : "uptime", sudo: false, failOnError: true, timeoutSecs: 120 };
    }
    case "notify":
      return { kind, title: "DevCenter", body: "" };
    case "wait":
      return { kind, seconds: 10 };
    case "waitForPort":
      return { kind, host: "localhost", port: 3000, timeoutSecs: 120 };
    case "condition":
      return { kind, condition: defaultCondition("processRunning", refs) };
  }
}

/** Bibliothèque de workflows prêts à l'emploi (complétés avec les premiers éléments disponibles). */
export function templates(refs: Refs): { id: string; title: string; description: string; input: AutomationInput }[] {
  const ws = refs.workspaces[0]?.id ?? 0;
  const server = refs.servers[0]?.id ?? 0;
  const project = refs.projects[0]?.id ?? 0;
  const base = { id: null, enabled: true, onError: "continue" as const, timeoutMinutes: 30 };
  return [
    {
      id: "morning",
      title: "Démarrer la journée",
      description: "En semaine à 9 h : démarre votre workspace et vous prévient.",
      input: {
        ...base,
        name: "Démarrer la journée",
        description: "",
        trigger: { kind: "daily", time: "09:00", days: [0, 1, 2, 3, 4] },
        steps: [
          { kind: "startWorkspace", workspaceId: ws },
          { kind: "notify", title: "Bonne journée", body: "Votre environnement de travail est prêt." },
        ],
      },
    },
    {
      id: "evening",
      title: "Fin de journée",
      description: "À 19 h : arrête le workspace s'il tourne encore.",
      input: {
        ...base,
        name: "Fin de journée",
        description: "",
        trigger: { kind: "daily", time: "19:00", days: [] },
        steps: [
          { kind: "condition", condition: { kind: "workspaceActive", workspaceId: ws, negate: false } },
          { kind: "stopWorkspace", workspaceId: ws },
          { kind: "notify", title: "Session arrêtée", body: "Les serveurs de développement ont été coupés." },
        ],
      },
    },
    {
      id: "server-watch",
      title: "Surveiller un serveur",
      description: "Toutes les 10 min : notification si le serveur ne répond plus.",
      input: {
        ...base,
        name: "Surveiller le serveur",
        description: "",
        trigger: { kind: "interval", minutes: 10 },
        steps: [
          { kind: "condition", condition: { kind: "serverReachable", serverId: server, negate: true } },
          { kind: "notify", title: "Serveur injoignable", body: "Le serveur ne répond plus en SSH." },
        ],
      },
    },
    {
      id: "dev-restart",
      title: "Relancer le serveur de dev",
      description: "Toutes les 5 min en journée : relance `dev` si le port 3000 est fermé.",
      input: {
        ...base,
        name: "Garder le serveur de dev en vie",
        description: "",
        trigger: { kind: "interval", minutes: 5 },
        steps: [
          { kind: "condition", condition: { kind: "timeBetween", start: "09:00", end: "19:00", negate: false } },
          { kind: "condition", condition: { kind: "portOpen", host: "localhost", port: 3000, negate: true } },
          { kind: "runScript", projectId: project, script: "dev", openBrowser: false },
          { kind: "waitForPort", host: "localhost", port: 3000, timeoutSecs: 120 },
          { kind: "notify", title: "Serveur de dev relancé", body: "localhost:3000 répond de nouveau." },
        ],
      },
    },
    {
      id: "docker-first",
      title: "Docker puis workspace",
      description: "Lance Docker Desktop si besoin, attend qu'il soit prêt, puis démarre le workspace.",
      input: {
        ...base,
        onError: "stop",
        name: "Docker puis workspace",
        description: "",
        trigger: { kind: "manual" },
        steps: [
          ...(refs.apps[0] ? [{ kind: "launchApp" as const, appId: refs.apps[0].id }] : []),
          { kind: "wait", seconds: 20 },
          { kind: "startWorkspace", workspaceId: ws },
        ],
      },
    },
    {
      id: "script-crash",
      title: "Relancer un script qui plante",
      description: "Quand `dev` s'arrête avec une erreur : notification, puis relance 5 s plus tard.",
      input: {
        ...base,
        name: "Relancer le serveur de dev",
        description: "",
        trigger: { kind: "scriptFailed", projectId: refs.projects[0] ? project : null, script: "dev" },
        steps: [
          { kind: "notify", title: "Script planté", body: "Le serveur de dev s'est arrêté, relance en cours." },
          { kind: "wait", seconds: 5 },
          { kind: "runScript", projectId: project, script: "dev", openBrowser: false },
        ],
      },
    },
    {
      id: "server-down-event",
      title: "Alerte serveur en panne",
      description: "Notification dès qu'un serveur enregistré ne répond plus (vérifié chaque minute).",
      input: {
        ...base,
        name: "Serveur en panne",
        description: "",
        trigger: { kind: "serverDown", serverId: null },
        steps: [{ kind: "notify", title: "{{server}} injoignable", body: "{{error}}" }],
      },
    },
    {
      id: "discord-commit",
      title: "Discord à chaque commit",
      description: "Poste projet, branche, hash et message du commit sur un webhook Discord (URL à coller).",
      input: {
        ...base,
        // Désactivée tant que l'URL du webhook n'est pas collée.
        enabled: false,
        name: "Commit → Discord",
        description: "",
        trigger: { kind: "gitChange", projectId: null, onCommit: true, onBranch: false },
        steps: [
          {
            kind: "httpRequest",
            method: "POST",
            url: "https://discord.com/api/webhooks/…",
            headers: "Content-Type: application/json",
            body: '{"content": "**{{project}}** · `{{branch}}` · `{{commit}}` — {{message}}"}',
            expectStatus: "",
            timeoutSecs: 30,
          },
        ],
      },
    },
    {
      id: "webhook-deploy",
      title: "Webhook de déploiement",
      description: "Une URL locale à appeler (CI, script, téléphone) : relance le workspace et prévient.",
      input: {
        ...base,
        onError: "stop",
        name: "Webhook de déploiement",
        description: "",
        trigger: { kind: "webhook", token: newWebhookToken() },
        steps: [
          { kind: "stopWorkspace", workspaceId: ws },
          { kind: "startWorkspace", workspaceId: ws },
          { kind: "notify", title: "Déploiement local", body: "Workspace relancé par le webhook." },
        ],
      },
    },
    {
      id: "cpu-alert",
      title: "Alerte CPU",
      description: "Toutes les 5 min : notification si le processeur dépasse 90 %.",
      input: {
        ...base,
        name: "Alerte CPU",
        description: "",
        trigger: { kind: "interval", minutes: 5 },
        steps: [
          { kind: "condition", condition: { kind: "cpuAbove", percent: 90, negate: false } },
          { kind: "notify", title: "Processeur saturé", body: "Le CPU dépasse 90 %." },
        ],
      },
    },
  ];
}
