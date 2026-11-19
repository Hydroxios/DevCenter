// Types partagés — miroir des structures Rust sérialisées (camelCase).

export type Theme = "light" | "dark" | "system";

export interface Settings {
  theme: Theme;
  closeToTray: boolean;
  /** null = détection automatique (Cursor, puis VS Code). */
  editorPath: string | null;
  remoteEnabled: boolean;
  remotePort: number;
  /** Dossier où cloner les projets importés depuis le téléphone (null = déduit). */
  projectsRoot: string | null;
}

export interface SystemInfo {
  hostName: string | null;
  osName: string | null;
  osVersion: string | null;
  kernelVersion: string | null;
  cpuBrand: string;
  cpuCores: number;
}

export interface DiskSnapshot {
  name: string;
  mountPoint: string;
  fileSystem: string;
  totalBytes: number;
  availableBytes: number;
  removable: boolean;
}

export interface SystemSnapshot {
  cpuUsage: number;
  cpuPerCore: number[];
  memoryTotal: number;
  memoryUsed: number;
  swapTotal: number;
  swapUsed: number;
  disks: DiskSnapshot[];
  uptimeSecs: number;
}

export interface GpuSnapshot {
  vendor: string | null;
  model: string | null;
  usage: number | null;
  memoryTotal: number | null;
  memoryUsed: number | null;
}

export interface SensorSnapshot {
  label: string;
  temperature: number | null;
  critical: number | null;
}

export interface HardwareSnapshot {
  gpus: GpuSnapshot[];
  sensors: SensorSnapshot[];
}

export interface ProcessInfo {
  pid: number;
  parentPid: number | null;
  name: string;
  exe: string | null;
  cpuUsage: number;
  memory: number;
  status: string;
  startTime: number;
  runTime: number;
  protected: boolean;
}

export interface KillOutcome {
  pid: number;
  name: string;
  killed: boolean;
}

export interface AppShortcut {
  id: number;
  name: string;
  path: string;
  exists: boolean;
}

export interface Project {
  id: number;
  name: string;
  path: string;
  exists: boolean;
}

export interface ProjectScript {
  name: string;
  command: string;
  /** Groupe de la tâche Gradle (« Build », « Verification », groupes du projet…). */
  group?: string;
}

export interface ProjectMeta {
  languages: string[];
  frameworks: string[];
  packageManager: string | null;
  scripts: ProjectScript[];
  hasGit: boolean;
  /** Faux tant que les tâches Gradle réelles n'ont pas été lues. */
  tasksLoaded: boolean;
}

export interface GitStatus {
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  staged: number;
  modified: number;
  untracked: number;
  conflicts: number;
  lastCommit: { hash: string; subject: string; timestamp: number } | null;
}

export interface GitBranch {
  /** `main`, ou `origin/main` pour une branche distante. */
  name: string;
  remote: boolean;
  current: boolean;
  upstream: string | null;
  timestamp: number;
  subject: string;
}

/** Fichier modifié, tel que préparé pour un commit. */
export interface ChangedFile {
  path: string;
  origPath: string | null;
  /** État dans l'index (`M`, `A`, `D`, `R`…), ou null si rien n'est indexé. */
  staged: string | null;
  /** État dans l'arbre de travail (`M`, `D`, `?` pour un fichier non suivi…), ou null. */
  unstaged: string | null;
  conflict: boolean;
}

export interface ProjectDetails {
  id: number;
  meta: ProjectMeta;
  git: GitStatus | null;
}

export interface ScanCandidate {
  path: string;
  name: string;
  languages: string[];
  frameworks: string[];
}

export type RunStatus = "running" | "exited" | "failed" | "stopped";

export interface RunInfo {
  id: number;
  projectId: number;
  script: string;
  command: string;
  pid: number;
  status: RunStatus;
  exitCode: number | null;
  url: string | null;
  startedAt: number;
}

export type WorkspaceStep =
  | { kind: "editor"; projectId: number }
  | { kind: "folder"; projectId: number }
  | { kind: "script"; projectId: number; script: string; openBrowser: boolean }
  | { kind: "app"; appId: number; closeOnStop: boolean }
  | { kind: "url"; url: string };

export interface StepResult {
  label: string;
  ok: boolean;
  message: string | null;
}

export interface ActiveSession {
  sessionId: number;
  startedAt: number;
  runIds: number[];
  results: StepResult[];
}

export interface Workspace {
  id: number;
  name: string;
  description: string;
  favorite: boolean;
  steps: WorkspaceStep[];
  active: ActiveSession | null;
  lastStartedAt: number | null;
}

export interface WorkspaceInput {
  id: number | null;
  name: string;
  description: string;
  favorite: boolean;
  steps: WorkspaceStep[];
}

export type SessionStatus = "running" | "completed" | "partial" | "stopped" | "interrupted";

export interface SessionRecord {
  id: number;
  workspaceId: number | null;
  workspaceName: string;
  startedAt: number;
  endedAt: number | null;
  status: SessionStatus;
  results: StepResult[];
}

export interface Server {
  id: number;
  name: string;
  host: string;
  port: number;
  user: string | null;
  keyPath: string | null;
}

export interface ServerInput {
  id: number | null;
  name: string;
  host: string;
  port: number | null;
  user: string | null;
  keyPath: string | null;
}

export interface RemoteMetrics {
  hostname: string;
  os: string;
  kernel: string;
  uptimeSecs: number;
  load: [number, number, number];
  cpuCores: number;
  cpuUsage: number;
  memoryTotal: number;
  memoryUsed: number;
  swapTotal: number;
  swapUsed: number;
  disks: { mount: string; totalBytes: number; usedBytes: number }[];
  docker: boolean;
  systemd: boolean;
  latencyMs: number;
}

export interface RemoteService {
  name: string;
  load: string;
  active: string;
  sub: string;
  description: string;
}

export interface Container {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  ports: string;
}

export type RemoteAction = "start" | "stop" | "restart";

export interface KeyStatus {
  agent: "running" | "unavailable";
  loaded: string[];
  keyPath: string | null;
  encrypted: boolean;
  keyLoaded: boolean;
}

export type AutomationTrigger =
  | { kind: "manual" }
  | { kind: "interval"; minutes: number }
  | { kind: "daily"; time: string; days: number[] }
  | { kind: "appStart" };

export type AutomationCondition =
  | { kind: "processRunning"; name: string; negate: boolean }
  | { kind: "serverReachable"; serverId: number; negate: boolean }
  | { kind: "workspaceActive"; workspaceId: number; negate: boolean }
  | { kind: "portOpen"; host: string; port: number; negate: boolean }
  | { kind: "cpuAbove"; percent: number; negate: boolean }
  | { kind: "memoryAbove"; percent: number; negate: boolean }
  | { kind: "timeBetween"; start: string; end: string; negate: boolean };

export type AutomationStep =
  | { kind: "startWorkspace"; workspaceId: number }
  | { kind: "stopWorkspace"; workspaceId: number }
  | { kind: "runScript"; projectId: number; script: string; openBrowser: boolean }
  | { kind: "stopScript"; projectId: number; script: string }
  | { kind: "openEditor"; projectId: number }
  | { kind: "openFolder"; projectId: number }
  | { kind: "launchApp"; appId: number }
  | { kind: "openUrl"; url: string }
  | { kind: "notify"; title: string; body: string }
  | { kind: "wait"; seconds: number }
  | { kind: "waitForPort"; host: string; port: number; timeoutSecs: number }
  | {
      kind: "httpRequest";
      method: HttpMethod;
      url: string;
      /** Un en-tête par ligne : `Nom: valeur`. */
      headers: string;
      body: string;
      /** Codes acceptés (« 2xx », « 200-299 », « 200,204 ») ; vide = 2xx. */
      expectStatus: string;
      timeoutSecs: number;
    }
  | { kind: "condition"; condition: AutomationCondition };

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";

export type OnError = "stop" | "continue";

export interface StepLog {
  label: string;
  outcome: "ok" | "failed" | "skipped";
  message: string | null;
  durationMs: number;
}

export type AutomationRunStatus = "running" | "success" | "failed" | "stopped" | "timeout";

export interface AutomationRun {
  id: number;
  automationId: number | null;
  automationName: string;
  origin: "manual" | "schedule" | "startup";
  startedAt: number;
  endedAt: number | null;
  status: AutomationRunStatus;
  log: StepLog[];
}

export interface Automation {
  id: number;
  name: string;
  description: string;
  enabled: boolean;
  trigger: AutomationTrigger;
  steps: AutomationStep[];
  onError: OnError;
  timeoutMinutes: number;
  running: boolean;
  lastRun: AutomationRun | null;
}

export interface AutomationInput {
  id: number | null;
  name: string;
  description: string;
  enabled: boolean;
  trigger: AutomationTrigger;
  steps: AutomationStep[];
  onError: OnError;
  timeoutMinutes: number;
}

export interface RemoteDevice {
  id: number;
  name: string;
  createdAt: number;
  lastSeen: number | null;
  notifications: boolean;
}

export interface TailscaleStatus {
  installed: boolean;
  online: boolean;
  dnsName: string | null;
  httpsEnabled: boolean;
  serveUrl: string | null;
}

export interface RemoteStatus {
  running: boolean;
  port: number | null;
  urls: string[];
  error: string | null;
  devices: RemoteDevice[];
}

export interface ImportSummary {
  added: Record<string, number>;
  skipped: Record<string, number>;
}

export interface GithubStatus {
  installed: boolean;
  login: string | null;
  scopes: string | null;
}

export interface GithubRepo {
  fullName: string;
  name: string;
  owner: string;
  private: boolean;
  fork: boolean;
  archived: boolean;
  description: string | null;
  language: string | null;
  pushedAt: string | null;
  cloneUrl: string;
  /** Projet DevCenter déjà lié à ce dépôt. */
  projectId: number | null;
}

export interface CloneJob {
  id: number;
  url: string;
  name: string;
  path: string;
  status: "running" | "done" | "failed";
  error: string | null;
  projectId: number | null;
  startedAt: number;
}

export interface GraphEdge {
  from: number;
  to: number;
  color: number;
}

export interface GraphCommit {
  hash: string;
  short: string;
  parents: string[];
  author: string;
  timestamp: number;
  subject: string;
  refs: string[];
  column: number;
  color: number;
  edges: GraphEdge[];
}

export interface GitLog {
  commits: GraphCommit[];
  width: number;
  truncated: boolean;
}

export interface FileChange {
  path: string;
  oldPath: string | null;
  status: "added" | "deleted" | "modified" | "renamed" | "binary";
  additions: number;
  deletions: number;
  patch: string;
  truncated: boolean;
}

export interface CommitDetails {
  hash: string;
  parents: string[];
  author: string;
  authorEmail: string;
  authoredAt: number;
  committer: string;
  committedAt: number;
  refs: string[];
  subject: string;
  body: string;
  files: FileChange[];
  additions: number;
  deletions: number;
  diffTruncated: boolean;
}

export interface UpdateInfo {
  version: string;
  currentVersion: string;
  /** Notes de version (corps de la Release GitHub). */
  notes: string | null;
  /** Date de publication (horodatage Unix). */
  date: number | null;
}

/* ------------------------------------------------------------------ */
/* Activité (widgets du tableau de bord)                               */
/* ------------------------------------------------------------------ */

export interface CommitActivity {
  /** Jours ayant au moins un commit (`AAAA-MM-JJ`, heure locale). */
  days: { date: string; count: number }[];
  total: number;
  repos: number;
}

/** Un commit de l'utilisateur, pour le détail d'un jour de la grille. */
export interface DayCommit {
  projectId: number;
  projectName: string;
  hash: string;
  subject: string;
  /** Horodatage Unix. */
  time: number;
}

/** Une journée du rapport `ccusage daily --json`. */
export interface CcusageDay {
  period: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  totalCost: number;
  modelsUsed: string[];
  modelBreakdowns?: {
    modelName: string;
    cost: number;
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
  }[];
}

/** Coût et tokens Claude Code depuis le premier usage relevé. */
export interface CcusageTotal {
  cost: number;
  tokens: number;
  /** Premier jour relevé (`AAAA-MM-JJ`). */
  since: string | null;
  activeDays: number;
}

/** Détail Claude Code d'un jour : coût par projet et fenêtres de facturation de 5 h. */
export interface CcusageDayDetail {
  projects: {
    key: string;
    name: string;
    projectId: number | null;
    path: string | null;
    cost: number;
    totalTokens: number;
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
    models: string[];
  }[];
  blocks: {
    start: string;
    end: string | null;
    active: boolean;
    cost: number;
    totalTokens: number;
    entries: number;
    models: string[];
  }[];
}

export interface CcusageReport {
  daily: CcusageDay[];
}
