import { invoke } from "@tauri-apps/api/core";

import type {
  AppShortcut,
  HardwareSnapshot,
  KillOutcome,
  ProcessInfo,
  Project,
  ProjectDetails,
  RunInfo,
  ScanCandidate,
  Server,
  ServerInput,
  RemoteMetrics,
  RemoteService,
  Container,
  RemoteAction,
  KeyStatus,
  Automation,
  AutomationInput,
  AutomationRun,
  RemoteStatus,
  ImportSummary,
  TailscaleStatus,
  GithubStatus,
  GithubRepo,
  CloneJob,
  CommitActivity,
  DayCommit,
  CcusageReport,
  CcusageDayDetail,
  CcusageTotal,
  GitLog,
  CommitDetails,
  ChangedFile,
  GitBranch,
  PullMode,
  StashEntry,
  SessionRecord,
  ActiveSession,
  Workspace,
  WorkspaceInput,
  Settings,
  SystemInfo,
  SystemSnapshot,
  UpdateInfo,
} from "@/types";

/**
 * Point d'entrée unique vers les commandes Rust.
 * Les composants n'appellent jamais `invoke` directement : tout passe par ici (typage + traçabilité).
 */
export const api = {
  settings: {
    get: () => invoke<Settings>("get_settings"),
    set: <K extends keyof Settings>(key: K, value: Settings[K]) =>
      invoke<Settings>("set_setting", { key, value }),
  },
  system: {
    info: () => invoke<SystemInfo>("get_system_info"),
    snapshot: () => invoke<SystemSnapshot>("get_system_snapshot"),
    /** Ouvre le disque dans l'explorateur (point de montage issu du snapshot). */
    openDisk: (mountPoint: string) => invoke<void>("open_disk", { mountPoint }),
    hardware: () => invoke<HardwareSnapshot>("get_hardware"),
  },
  processes: {
    /** Sans argument : tous les processus. Avec `sort`/`limit` : seulement le haut du classement (trié côté Rust). */
    list: (sort?: "cpu" | "memory", limit?: number) => invoke<ProcessInfo[]>("list_processes", { sort, limit }),
    /** `startTime` garantit qu'on arrête bien le processus affiché (PID non réattribué). */
    kill: (pid: number, startTime: number) => invoke<KillOutcome>("kill_process", { pid, startTime }),
  },
  apps: {
    list: () => invoke<AppShortcut[]>("list_apps"),
    add: (name: string, path: string) => invoke<AppShortcut[]>("add_app", { name, path }),
    remove: (id: number) => invoke<AppShortcut[]>("remove_app", { id }),
    launch: (id: number) => invoke<void>("launch_app", { id }),
  },
  projects: {
    list: () => invoke<Project[]>("list_projects"),
    add: (paths: string[]) => invoke<Project[]>("add_projects", { paths }),
    remove: (id: number) => invoke<Project[]>("remove_project", { id }),
    rename: (id: number, name: string) => invoke<Project[]>("rename_project", { id, name }),
    /** Statut Git en cache côté Rust ; `force` relit le dépôt. */
    details: (id: number, force = false) => invoke<ProjectDetails>("project_details", { id, force }),
    scan: (root: string) => invoke<ScanCandidate[]>("scan_projects", { root }),
    openInEditor: (id: number) => invoke<void>("open_in_editor", { id }),
    openFolder: (id: number) => invoke<void>("open_project_folder", { id }),
    openTerminal: (id: number) => invoke<void>("open_project_terminal", { id }),
    /** Lit les vraies tâches Gradle (`gradlew tasks --all`) ; plusieurs secondes la première fois. */
    gradleTasks: (id: number) => invoke<ProjectDetails>("gradle_tasks", { id }),
    detectEditor: () => invoke<string | null>("detect_editor"),
  },
  runner: {
    list: () => invoke<RunInfo[]>("list_runs"),
    logs: (runId: number) => invoke<string[]>("run_logs", { runId }),
    /** Seuls les scripts déclarés dans le package.json du projet sont acceptés par Rust. */
    run: (projectId: number, script: string) => invoke<RunInfo>("run_script", { projectId, script }),
    stop: (runId: number) => invoke<void>("stop_run", { runId }),
    dismiss: (runId: number) => invoke<void>("dismiss_run", { runId }),
  },
  workspaces: {
    list: () => invoke<Workspace[]>("list_workspaces"),
    save: (input: WorkspaceInput) => invoke<Workspace[]>("save_workspace", { input }),
    remove: (id: number) => invoke<Workspace[]>("delete_workspace", { id }),
    setFavorite: (id: number, favorite: boolean) => invoke<Workspace[]>("set_workspace_favorite", { id, favorite }),
    start: (id: number) => invoke<ActiveSession>("start_workspace", { id }),
    stop: (id: number) => invoke<void>("stop_workspace", { id }),
    history: (limit = 50) => invoke<SessionRecord[]>("workspace_history", { limit }),
  },
  servers: {
    list: () => invoke<Server[]>("list_servers"),
    save: (input: ServerInput) => invoke<Server[]>("save_server", { input }),
    remove: (id: number) => invoke<Server[]>("delete_server", { id }),
    findKeys: () => invoke<string[]>("find_ssh_keys"),
    keyStatus: (id: number) => invoke<KeyStatus>("server_key_status", { id }),
    ping: (id: number) => invoke<number>("ping_server", { id }),
    metrics: (id: number) => invoke<RemoteMetrics>("server_metrics", { id }),
    services: (id: number) => invoke<RemoteService[]>("server_services", { id }),
    serviceAction: (id: number, name: string, action: RemoteAction) => invoke<void>("server_service_action", { id, name, action }),
    serviceLogs: (id: number, name: string, lines = 300) => invoke<string>("server_service_logs", { id, name, lines }),
    containers: (id: number) => invoke<Container[]>("server_containers", { id }),
    containerAction: (id: number, container: string, action: RemoteAction) =>
      invoke<void>("server_container_action", { id, container, action }),
    containerLogs: (id: number, container: string, lines = 300) => invoke<string>("server_container_logs", { id, container, lines }),
  },
  automations: {
    list: () => invoke<Automation[]>("list_automations"),
    save: (input: AutomationInput) => invoke<Automation[]>("save_automation", { input }),
    remove: (id: number) => invoke<Automation[]>("delete_automation", { id }),
    setEnabled: (id: number, enabled: boolean) => invoke<Automation[]>("set_automation_enabled", { id, enabled }),
    run: (id: number) => invoke<number>("run_automation", { id }),
    /** Du plus récent au plus ancien ; `beforeId` charge la page suivante (exécutions plus anciennes). */
    history: (automationId: number | null = null, limit = 50, beforeId: number | null = null) =>
      invoke<AutomationRun[]>("automation_history", { automationId, limit, beforeId }),
  },
  remote: {
    status: () => invoke<RemoteStatus>("remote_status"),
    configure: (enabled: boolean, port: number) => invoke<RemoteStatus>("remote_configure", { enabled, port }),
    pairingCode: () => invoke<{ code: string; expiresInSecs: number }>("remote_pairing_code"),
    revoke: (id: number) => invoke<RemoteStatus>("remote_revoke", { id }),
  },
  tailscale: {
    status: () => invoke<TailscaleStatus>("tailscale_status"),
    serve: (enabled: boolean) => invoke<TailscaleStatus>("tailscale_serve", { enabled }),
  },
  github: {
    status: () => invoke<GithubStatus>("github_status"),
    repos: (refresh = false) => invoke<GithubRepo[]>("github_repos", { refresh }),
    /** Terminal interactif `gh auth login`. */
    loginTerminal: (cols: number, rows: number) => invoke<number>("github_login_terminal", { cols, rows }),
    clone: (url: string, name?: string) => invoke<CloneJob>("clone_repo", { url, name: name ?? null }),
    cloneJobs: () => invoke<CloneJob[]>("list_clone_jobs"),
  },
  activity: {
    commits: (days = 371) => invoke<CommitActivity>("commit_activity", { days }),
    commitsOn: (date: string) => invoke<DayCommit[]>("commits_on_day", { date }),
    ccusageTotal: (force = false) => invoke<CcusageTotal>("ccusage_total", { force }),
    ccusageDay: (date: string) => invoke<CcusageDayDetail>("ccusage_day", { date }),
    ccusage: (days = 30, force = false) => invoke<CcusageReport>("ccusage_daily", { days, force }),
  },
  git: {
    log: (projectId: number, limit = 300) => invoke<GitLog>("git_log", { projectId, limit }),
    commit: (projectId: number, hash: string) => invoke<CommitDetails>("git_commit", { projectId, hash }),
    branches: (projectId: number) => invoke<GitBranch[]>("git_branches", { projectId }),
    /** Bascule sur une branche ; une branche distante crée (ou reprend) la branche locale qui la suit. */
    checkout: (projectId: number, name: string, remote: boolean) =>
      invoke<ProjectDetails>("git_checkout", { projectId, name, remote }),
    createBranch: (projectId: number, name: string, from: string | null, switchTo: boolean) =>
      invoke<ProjectDetails>("git_create_branch", { projectId, name, from, switch: switchTo }),
    changes: (projectId: number) => invoke<ChangedFile[]>("git_changes", { projectId }),
    /** Indexe (`staged`) ou désindexe les fichiers ; renvoie la liste à jour. */
    stage: (projectId: number, paths: string[], staged: boolean) =>
      invoke<ChangedFile[]>("git_stage", { projectId, paths, staged }),
    fileDiff: (projectId: number, path: string, staged: boolean) => invoke<string>("git_file_diff", { projectId, path, staged }),
    /** Commit de l'index ; `all` indexe d'abord toutes les modifications. */
    createCommit: (projectId: number, message: string, all: boolean) =>
      invoke<ProjectDetails>("git_create_commit", { projectId, message, all }),
    /** Pousse la branche courante (la publie sur `origin` si elle n'a pas de branche suivie). */
    push: (projectId: number) => invoke<ProjectDetails>("git_push", { projectId }),
    /** `git fetch --prune` ; renvoie les détails à jour (compteurs ↑/↓). */
    fetch: (projectId: number) => invoke<ProjectDetails>("git_fetch", { projectId }),
    /** `git pull` de la branche suivie ; avance rapide uniquement par défaut. */
    pull: (projectId: number, mode: PullMode = "ffOnly") => invoke<ProjectDetails>("git_pull", { projectId, mode }),
    stashList: (projectId: number) => invoke<StashEntry[]>("git_stash_list", { projectId }),
    stashPush: (projectId: number, message: string | null, includeUntracked: boolean) =>
      invoke<ProjectDetails>("git_stash_push", { projectId, message, includeUntracked }),
    stashApply: (projectId: number, hash: string) => invoke<ProjectDetails>("git_stash_apply", { projectId, hash }),
    stashPop: (projectId: number, hash: string) => invoke<ProjectDetails>("git_stash_pop", { projectId, hash }),
    /** Supprime une remise ; renvoie la pile à jour. */
    stashDrop: (projectId: number, hash: string) => invoke<StashEntry[]>("git_stash_drop", { projectId, hash }),
  },
  push: {
    /** Notification de test vers tous les téléphones abonnés ; retourne le nombre d'envois réussis. */
    test: () => invoke<number>("push_test"),
  },
  updates: {
    version: () => invoke<string>("app_version"),
    /** `null` si DevCenter est à jour. */
    check: () => invoke<UpdateInfo | null>("update_check"),
    /** Télécharge, vérifie la signature, installe puis relance l'application. */
    install: () => invoke<void>("update_install"),
  },
  logs: {
    openFolder: () => invoke<void>("open_log_folder"),
  },
  backup: {
    export: (path: string) => invoke<void>("export_config", { path }),
    import: (path: string) => invoke<ImportSummary>("import_config", { path }),
  },
  terminal: {
    open: (serverId: number, cols: number, rows: number) => invoke<number>("terminal_open", { serverId, cols, rows }),
    write: (id: number, data: string) => invoke<void>("terminal_write", { id, data }),
    resize: (id: number, cols: number, rows: number) => invoke<void>("terminal_resize", { id, cols, rows }),
    close: (id: number) => invoke<void>("terminal_close", { id }),
    /** ssh-add interactif pour la clé du serveur. */
    openSshAdd: (serverId: number, cols: number, rows: number) => invoke<number>("terminal_open_ssh_add", { serverId, cols, rows }),
  },
};

/** Vrai quand l'app tourne dans Tauri (faux dans un simple navigateur via `pnpm dev`). */
export const isTauri = () => "__TAURI_INTERNALS__" in window;
