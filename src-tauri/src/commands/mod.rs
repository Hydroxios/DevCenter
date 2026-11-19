//! Commandes IPC exposées au frontend. Chaque commande est une fine couche
//! au-dessus d'un service de `modules/` : aucune logique métier ici.

use tauri::{AppHandle, Emitter, Manager, State};

use crate::error::{AppError, AppResult};
use crate::modules::automations::{self, Automation, AutomationInput, RunSummary};
use crate::modules::backup::{self, ImportSummary};
use crate::modules::editor;
use crate::modules::github::{self, GithubStatus, Repo};
use crate::modules::projects::branches::{self, Branch};
use crate::modules::projects::history::{CommitDetails, GitLog};
use crate::modules::projects::import::CloneJob;
use crate::modules::push;
use crate::modules::shell;
use crate::modules::tailscale::{self, TailscaleStatus};
use crate::modules::remote::{self as remote_access, PairingCode, RemoteStatus};
use crate::modules::projects::{self, Project, ProjectDetails, ScanCandidate};
use crate::modules::runner::RunInfo;
use crate::modules::servers::remote::{self, Container, RemoteMetrics, RemoteService};
use crate::modules::servers::agent::KeyStatus;
use crate::modules::servers::{self, Server, ServerInput};
use crate::modules::workspaces::{self, ActiveInfo, SessionRecord, Workspace, WorkspaceInput};
use crate::modules::settings::{Settings, SettingsService};
use crate::modules::apps::{self, AppShortcut};
use crate::modules::system::{HardwareSnapshot, KillOutcome, ProcessInfo, ProcessSort, SystemInfo, SystemSnapshot};
use crate::state::AppState;

// ---------------------------------------------------------------- Journal

/// Ligne de journal envoyée par l'interface (erreurs d'affichage, exceptions non gérées).
#[tauri::command]
pub fn client_log(level: String, message: String) {
    let message: String = message.chars().take(8000).collect();
    match level.as_str() {
        "error" => log::error!(target: "interface", "{message}"),
        "warn" => log::warn!(target: "interface", "{message}"),
        _ => log::info!(target: "interface", "{message}"),
    }
}

// ---------------------------------------------------------------- Mises à jour

#[tauri::command]
pub fn app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

#[tauri::command]
pub async fn update_check(app: AppHandle) -> AppResult<Option<crate::modules::updates::UpdateInfo>> {
    crate::modules::updates::check(&app).await
}

#[tauri::command]
pub async fn update_install(app: AppHandle) -> AppResult<()> {
    crate::modules::updates::install(&app).await
}

/// Ouvre le dossier des journaux (pour joindre `devcenter.log` à un rapport de bug).
#[tauri::command]
pub fn open_log_folder(app: AppHandle) -> AppResult<()> {
    let dir = app.path().app_log_dir()?;
    std::fs::create_dir_all(&dir)?;
    tauri_plugin_opener::open_path(&dir, None::<&str>).map_err(|e| AppError::InvalidInput(format!("impossible d'ouvrir {} : {e}", dir.display())))
}

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> AppResult<Settings> {
    SettingsService::load(&state.db)
}

#[tauri::command]
pub fn set_setting(
    state: State<'_, AppState>,
    key: String,
    value: serde_json::Value,
) -> AppResult<Settings> {
    state.settings.set(&state.db, &key, value)
}

#[tauri::command]
pub fn get_system_info(state: State<'_, AppState>) -> AppResult<SystemInfo> {
    state.system.info()
}

#[tauri::command]
pub async fn get_system_snapshot(app: AppHandle) -> AppResult<SystemSnapshot> {
    blocking(move || app.state::<AppState>().system.snapshot()).await
}

#[tauri::command]
pub async fn get_hardware(app: AppHandle) -> AppResult<HardwareSnapshot> {
    blocking(move || app.state::<AppState>().system.hardware()).await
}

/// `sort` (`cpu` | `memory`) et `limit` : tri et coupe côté Rust (le widget n'affiche que le haut du classement).
#[tauri::command]
pub async fn list_processes(app: AppHandle, sort: Option<ProcessSort>, limit: Option<usize>) -> AppResult<Vec<ProcessInfo>> {
    blocking(move || app.state::<AppState>().system.processes(sort, limit)).await
}

#[tauri::command]
pub async fn kill_process(app: AppHandle, pid: u32, start_time: u64) -> AppResult<KillOutcome> {
    blocking(move || app.state::<AppState>().system.kill_process(pid, start_time)).await
}

#[tauri::command]
pub fn list_apps(state: State<'_, AppState>) -> AppResult<Vec<AppShortcut>> {
    apps::list(&state.db)
}

#[tauri::command]
pub fn add_app(state: State<'_, AppState>, name: String, path: String) -> AppResult<Vec<AppShortcut>> {
    apps::add(&state.db, &name, &path)
}

#[tauri::command]
pub fn remove_app(state: State<'_, AppState>, id: i64) -> AppResult<Vec<AppShortcut>> {
    apps::remove(&state.db, id)
}

/// Lance un raccourci enregistré via le shell Windows (gère .exe et .lnk).
#[tauri::command]
pub async fn launch_app(app: AppHandle, id: i64) -> AppResult<()> {
    blocking(move || {
        let path = apps::resolve(&app.state::<AppState>().db, id)?;
        apps::launch(&path).map(|_| ())
    })
    .await
}

// ---------------------------------------------------------------- Projets

#[tauri::command]
pub fn list_projects(state: State<'_, AppState>) -> AppResult<Vec<Project>> {
    projects::list(&state.db)
}

#[tauri::command]
pub fn add_projects(state: State<'_, AppState>, paths: Vec<String>) -> AppResult<Vec<Project>> {
    let list = projects::add(&state.db, &paths)?;
    state.git_watcher.sync(&state.db);
    Ok(list)
}

#[tauri::command]
pub fn remove_project(state: State<'_, AppState>, id: i64) -> AppResult<Vec<Project>> {
    let list = projects::remove(&state.db, id)?;
    state.git_watcher.sync(&state.db);
    Ok(list)
}

#[tauri::command]
pub fn rename_project(state: State<'_, AppState>, id: i64, name: String) -> AppResult<Vec<Project>> {
    projects::rename(&state.db, id, &name)
}

/// Git + lecture de fichiers : exécuté hors du thread principal.
#[tauri::command]
pub async fn project_details(state: State<'_, AppState>, id: i64, force: Option<bool>) -> AppResult<ProjectDetails> {
    let path = projects::path_of(&state.db, id)?;
    blocking(move || Ok(if force.unwrap_or(false) { projects::details_fresh(id, &path) } else { projects::details(id, &path) })).await
}

/// Lit les tâches Gradle réelles du projet (plusieurs secondes la première fois, puis en cache).
#[tauri::command]
pub async fn gradle_tasks(state: State<'_, AppState>, id: i64) -> AppResult<ProjectDetails> {
    let path = projects::path_of(&state.db, id)?;
    blocking(move || {
        projects::gradle::load(&path)?;
        Ok(projects::details(id, &path))
    })
    .await
}

#[tauri::command]
pub async fn scan_projects(app: AppHandle, root: String) -> AppResult<Vec<ScanCandidate>> {
    blocking(move || projects::scan(&app.state::<AppState>().db, &root)).await
}

#[tauri::command]
pub async fn open_in_editor(app: AppHandle, id: i64) -> AppResult<()> {
    blocking(move || {
        let state = app.state::<AppState>();
        let path = projects::path_of(&state.db, id)?;
        let settings = SettingsService::load(&state.db)?;
        editor::open(settings.editor_path.as_deref(), &path)
    })
    .await
}

#[tauri::command]
pub async fn open_project_folder(app: AppHandle, id: i64) -> AppResult<()> {
    blocking(move || {
        let path = projects::path_of(&app.state::<AppState>().db, id)?;
        tauri_plugin_opener::open_path(&path, None::<&str>)
            .map_err(|e| AppError::InvalidInput(format!("impossible d'ouvrir {} : {e}", path.display())))
    })
    .await
}

#[tauri::command]
pub async fn open_project_terminal(app: AppHandle, id: i64) -> AppResult<()> {
    blocking(move || {
        let path = projects::path_of(&app.state::<AppState>().db, id)?;
        shell::open_terminal(&path).map_err(|e| AppError::InvalidInput(format!("impossible d'ouvrir un terminal : {e}")))
    })
    .await
}

#[tauri::command]
pub async fn detect_editor() -> Option<String> {
    blocking(|| Ok(editor::detect().map(|p| p.display().to_string()))).await.ok().flatten()
}

// ---------------------------------------------------------------- Scripts

#[tauri::command]
pub fn list_runs(state: State<'_, AppState>) -> AppResult<Vec<RunInfo>> {
    state.runner.list()
}

#[tauri::command]
pub fn run_logs(state: State<'_, AppState>, run_id: u64) -> AppResult<Vec<String>> {
    state.runner.logs(run_id)
}

/// Lance un script déclaré dans le package.json du projet. Le nom est vérifié : aucune
/// commande arbitraire ne peut être exécutée depuis le frontend.
#[tauri::command]
pub async fn run_script(app: AppHandle, project_id: i64, script: String) -> AppResult<RunInfo> {
    blocking(move || projects::run_script(&app, project_id, &script)).await
}

#[tauri::command]
pub fn stop_run(state: State<'_, AppState>, run_id: u64) -> AppResult<()> {
    state.runner.stop(run_id)
}

#[tauri::command]
pub fn dismiss_run(state: State<'_, AppState>, run_id: u64) -> AppResult<()> {
    state.runner.dismiss(run_id)
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> AppResult<T> + Send + 'static) -> AppResult<T> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|_| AppError::Unavailable("tâche de fond"))?
}

// ---------------------------------------------------------------- Workspaces

#[tauri::command]
pub fn list_workspaces(state: State<'_, AppState>) -> AppResult<Vec<Workspace>> {
    workspaces::list(&state.db, &state.workspaces)
}

#[tauri::command]
pub fn save_workspace(state: State<'_, AppState>, input: WorkspaceInput) -> AppResult<Vec<Workspace>> {
    workspaces::save(&state.db, &input)?;
    workspaces::list(&state.db, &state.workspaces)
}

#[tauri::command]
pub fn delete_workspace(state: State<'_, AppState>, id: i64) -> AppResult<Vec<Workspace>> {
    workspaces::delete(&state.db, &state.workspaces, id)?;
    workspaces::list(&state.db, &state.workspaces)
}

#[tauri::command]
pub fn set_workspace_favorite(state: State<'_, AppState>, id: i64, favorite: bool) -> AppResult<Vec<Workspace>> {
    workspaces::set_favorite(&state.db, id, favorite)?;
    workspaces::list(&state.db, &state.workspaces)
}

/// Lance applications, éditeur et scripts : hors du thread principal.
#[tauri::command]
pub async fn start_workspace(app: AppHandle, id: i64) -> AppResult<ActiveInfo> {
    blocking(move || workspaces::start(&app, &app.state::<AppState>(), id)).await
}

#[tauri::command]
pub async fn stop_workspace(app: AppHandle, id: i64) -> AppResult<()> {
    blocking(move || workspaces::stop(&app, &app.state::<AppState>(), id)).await
}

#[tauri::command]
pub fn workspace_history(state: State<'_, AppState>, limit: Option<u32>) -> AppResult<Vec<SessionRecord>> {
    workspaces::history(&state.db, limit.unwrap_or(50))
}

// ---------------------------------------------------------------- Serveurs
// Toutes les commandes réseau sont asynchrones : un serveur lent ne gèle pas l'interface.

#[tauri::command]
pub fn list_servers(state: State<'_, AppState>) -> AppResult<Vec<Server>> {
    servers::list(&state.db)
}

#[tauri::command]
pub fn save_server(state: State<'_, AppState>, input: ServerInput) -> AppResult<Vec<Server>> {
    servers::save(&state.db, &input)
}

#[tauri::command]
pub fn delete_server(state: State<'_, AppState>, id: i64) -> AppResult<Vec<Server>> {
    servers::delete(&state.db, id)
}

#[tauri::command]
pub async fn find_ssh_keys() -> Vec<String> {
    blocking(|| Ok(servers::find_keys())).await.unwrap_or_default()
}

fn server_of(app: &AppHandle, id: i64) -> AppResult<Server> {
    servers::get(&app.state::<AppState>().db, id)
}

#[tauri::command]
pub async fn ping_server(app: AppHandle, id: i64) -> AppResult<u64> {
    blocking(move || remote::ping(&server_of(&app, id)?)).await
}

#[tauri::command]
pub async fn server_metrics(app: AppHandle, id: i64) -> AppResult<RemoteMetrics> {
    blocking(move || remote::metrics(&server_of(&app, id)?)).await
}

#[tauri::command]
pub async fn server_services(app: AppHandle, id: i64) -> AppResult<Vec<RemoteService>> {
    blocking(move || remote::services(&server_of(&app, id)?)).await
}

#[tauri::command]
pub async fn server_service_action(app: AppHandle, id: i64, name: String, action: String) -> AppResult<()> {
    blocking(move || remote::service_action(&server_of(&app, id)?, &name, &action)).await
}

#[tauri::command]
pub async fn server_service_logs(app: AppHandle, id: i64, name: String, lines: Option<u32>) -> AppResult<String> {
    blocking(move || remote::service_logs(&server_of(&app, id)?, &name, lines.unwrap_or(300))).await
}

#[tauri::command]
pub async fn server_containers(app: AppHandle, id: i64) -> AppResult<Vec<Container>> {
    blocking(move || remote::containers(&server_of(&app, id)?)).await
}

#[tauri::command]
pub async fn server_container_action(app: AppHandle, id: i64, container: String, action: String) -> AppResult<()> {
    blocking(move || remote::container_action(&server_of(&app, id)?, &container, &action)).await
}

#[tauri::command]
pub async fn server_container_logs(app: AppHandle, id: i64, container: String, lines: Option<u32>) -> AppResult<String> {
    blocking(move || remote::container_logs(&server_of(&app, id)?, &container, lines.unwrap_or(300))).await
}

#[tauri::command]
pub async fn terminal_open(app: AppHandle, server_id: i64, cols: u16, rows: u16) -> AppResult<u64> {
    blocking(move || {
        let state = app.state::<AppState>();
        let server = servers::get(&state.db, server_id)?;
        state.terminals.open(&app, &server, cols, rows)
    })
    .await
}

#[tauri::command]
pub fn terminal_write(state: State<'_, AppState>, id: u64, data: String) -> AppResult<()> {
    state.terminals.write(id, &data)
}

#[tauri::command]
pub fn terminal_resize(state: State<'_, AppState>, id: u64, cols: u16, rows: u16) -> AppResult<()> {
    state.terminals.resize(id, cols, rows)
}

#[tauri::command]
pub fn terminal_close(state: State<'_, AppState>, id: u64) -> AppResult<()> {
    state.terminals.close(id)
}

#[tauri::command]
pub async fn server_key_status(app: AppHandle, id: i64) -> AppResult<KeyStatus> {
    blocking(move || Ok(servers::agent::status(server_of(&app, id)?.key_path.as_deref()))).await
}

/// Ouvre `ssh-add` pour la clé du serveur (chemin déjà validé à l'enregistrement).
#[tauri::command]
pub async fn terminal_open_ssh_add(app: AppHandle, server_id: i64, cols: u16, rows: u16) -> AppResult<u64> {
    blocking(move || {
        let state = app.state::<AppState>();
        let server = servers::get(&state.db, server_id)?;
        state.terminals.open_ssh_add(&app, server.key_path.as_deref(), cols, rows)
    })
    .await
}

// ---------------------------------------------------------------- Automatisations

#[tauri::command]
pub fn list_automations(state: State<'_, AppState>) -> AppResult<Vec<Automation>> {
    automations::list(&state.db, &state.automations)
}

#[tauri::command]
pub fn save_automation(state: State<'_, AppState>, input: AutomationInput) -> AppResult<Vec<Automation>> {
    automations::save(&state.db, &input)?;
    automations::list(&state.db, &state.automations)
}

#[tauri::command]
pub fn delete_automation(state: State<'_, AppState>, id: i64) -> AppResult<Vec<Automation>> {
    automations::delete(&state.db, &state.automations, id)?;
    automations::list(&state.db, &state.automations)
}

#[tauri::command]
pub fn set_automation_enabled(state: State<'_, AppState>, id: i64, enabled: bool) -> AppResult<Vec<Automation>> {
    automations::set_enabled(&state.db, id, enabled)?;
    automations::list(&state.db, &state.automations)
}

/// Exécution manuelle (en arrière-plan) ; retourne l'id de l'exécution.
#[tauri::command]
pub fn run_automation(app: AppHandle, id: i64) -> AppResult<i64> {
    automations::trigger(&app, id, "manual")
}

#[tauri::command]
pub fn automation_history(
    state: State<'_, AppState>,
    automation_id: Option<i64>,
    limit: Option<u32>,
    before_id: Option<i64>,
) -> AppResult<Vec<RunSummary>> {
    automations::history(&state.db, automation_id, limit.unwrap_or(50), before_id)
}

// ---------------------------------------------------------------- Accès à distance

#[tauri::command]
pub fn remote_status(state: State<'_, AppState>) -> AppResult<RemoteStatus> {
    state.remote.status(&state.db)
}

/// Active/désactive le tableau de bord mobile et (re)démarre le serveur local.
#[tauri::command]
pub fn remote_configure(app: AppHandle, state: State<'_, AppState>, enabled: bool, port: u16) -> AppResult<RemoteStatus> {
    state.settings.set(&state.db, "remotePort", serde_json::json!(port))?;
    state.settings.set(&state.db, "remoteEnabled", serde_json::json!(enabled))?;
    if enabled {
        state.remote.start(&app, port)?;
    } else {
        state.remote.stop();
    }
    state.remote.status(&state.db)
}

#[tauri::command]
pub fn remote_pairing_code(state: State<'_, AppState>) -> AppResult<PairingCode> {
    state.remote.new_pairing_code()
}

#[tauri::command]
pub fn remote_revoke(state: State<'_, AppState>, id: i64) -> AppResult<RemoteStatus> {
    remote_access::revoke(&state.db, id)?;
    state.remote.status(&state.db)
}

// ---------------------------------------------------------------- Sauvegarde / synchronisation

#[tauri::command]
pub async fn export_config(app: AppHandle, path: String) -> AppResult<()> {
    blocking(move || backup::export(&app.state::<AppState>().db, &path)).await
}

#[tauri::command]
pub async fn import_config(app: AppHandle, path: String) -> AppResult<ImportSummary> {
    blocking(move || {
        let summary = backup::import(&app.state::<AppState>().db, &path)?;
        let _ = app.emit("config://imported", ());
        Ok(summary)
    })
    .await
}

// ---------------------------------------------------------------- HTTPS (Tailscale) et notifications

#[tauri::command]
pub async fn tailscale_status(app: AppHandle) -> AppResult<TailscaleStatus> {
    blocking(move || {
        let port = SettingsService::load(&app.state::<AppState>().db)?.remote_port;
        Ok(tailscale::status(port))
    })
    .await
}

#[tauri::command]
pub async fn tailscale_serve(app: AppHandle, enabled: bool) -> AppResult<TailscaleStatus> {
    blocking(move || {
        let port = SettingsService::load(&app.state::<AppState>().db)?.remote_port;
        tailscale::set_serve(enabled, port)?;
        Ok(tailscale::status(port))
    })
    .await
}

/// Notification de test vers tous les téléphones abonnés ; retourne le nombre d'envois réussis.
#[tauri::command]
pub async fn push_test(app: AppHandle) -> AppResult<usize> {
    blocking(move || {
        push::send(
            &app.state::<AppState>().db,
            None,
            &push::Notification {
                title: "DevCenter".into(),
                body: "Notification de test envoyée depuis le PC.".into(),
                tab: Some("home".into()),
                tag: Some("test".into()),
            },
        )
    })
    .await
}

// ---------------------------------------------------------------- GitHub

#[tauri::command]
pub async fn github_status() -> AppResult<GithubStatus> {
    blocking(|| Ok(github::status())).await
}

#[tauri::command]
pub async fn github_repos(app: AppHandle, refresh: Option<bool>) -> AppResult<Vec<Repo>> {
    blocking(move || {
        let state = app.state::<AppState>();
        Ok(state.github.repos(&state.db, refresh.unwrap_or(false))?.1)
    })
    .await
}

#[tauri::command]
pub async fn github_login_terminal(app: AppHandle, cols: u16, rows: u16) -> AppResult<u64> {
    blocking(move || {
        let state = app.state::<AppState>();
        state.github.invalidate();
        state.terminals.open_gh_login(&app, cols, rows)
    })
    .await
}

#[tauri::command]
pub fn clone_repo(app: AppHandle, state: State<'_, AppState>, url: String, name: Option<String>) -> AppResult<CloneJob> {
    state.clones.start(&app, &url, name.as_deref())
}

#[tauri::command]
pub fn list_clone_jobs(state: State<'_, AppState>) -> Vec<CloneJob> {
    state.clones.list()
}

// ---------------------------------------------------------------- Activité (tableau de bord)

/// Commits par jour de l'utilisateur, tous projets confondus.
#[tauri::command]
pub async fn commit_activity(app: AppHandle, days: Option<u32>) -> AppResult<crate::modules::activity::CommitActivity> {
    blocking(move || {
        let paths = projects::list(&app.state::<AppState>().db)?.into_iter().filter(|p| p.exists).map(|p| p.path).collect();
        Ok(crate::modules::activity::commits(paths, days.unwrap_or(371)))
    })
    .await
}

/// Détail des commits de l'utilisateur pour un jour (`AAAA-MM-JJ`).
#[tauri::command]
pub async fn commits_on_day(app: AppHandle, date: String) -> AppResult<Vec<crate::modules::activity::DayCommit>> {
    blocking(move || {
        let list = projects::list(&app.state::<AppState>().db)?.into_iter().filter(|p| p.exists).map(|p| (p.id, p.name, p.path)).collect();
        crate::modules::activity::commits_on(list, &date)
    })
    .await
}

/// Détail Claude Code d'un jour (`AAAA-MM-JJ`) : coût par projet et fenêtres de 5 h.
#[tauri::command]
pub async fn ccusage_day(app: AppHandle, date: String) -> AppResult<crate::modules::activity::DayUsage> {
    blocking(move || {
        let list = projects::list(&app.state::<AppState>().db)?.into_iter().map(|p| (p.id, p.name, p.path)).collect();
        crate::modules::activity::ccusage_day(list, &date)
    })
    .await
}

/// Coût et tokens Claude Code depuis le premier usage.
#[tauri::command]
pub async fn ccusage_total(force: Option<bool>) -> AppResult<crate::modules::activity::UsageTotal> {
    blocking(move || crate::modules::activity::ccusage_total(force.unwrap_or(false))).await
}

/// Consommation Claude Code relevée par `ccusage daily --json`.
#[tauri::command]
pub async fn ccusage_daily(days: Option<u32>, force: Option<bool>) -> AppResult<serde_json::Value> {
    blocking(move || crate::modules::activity::ccusage(days.unwrap_or(30), force.unwrap_or(false))).await
}

// ---------------------------------------------------------------- Historique Git

#[tauri::command]
pub async fn git_log(app: AppHandle, project_id: i64, limit: Option<usize>) -> AppResult<std::sync::Arc<GitLog>> {
    blocking(move || {
        let path = projects::path_of(&app.state::<AppState>().db, project_id)?;
        projects::gitcache::log(&path, limit.unwrap_or(300))
    })
    .await
}

#[tauri::command]
pub async fn git_commit(app: AppHandle, project_id: i64, hash: String) -> AppResult<std::sync::Arc<CommitDetails>> {
    blocking(move || {
        let path = projects::path_of(&app.state::<AppState>().db, project_id)?;
        projects::gitcache::commit(&path, &hash)
    })
    .await
}

// ---------------------------------------------------------------- Branches Git

#[tauri::command]
pub async fn git_branches(app: AppHandle, project_id: i64) -> AppResult<Vec<Branch>> {
    blocking(move || {
        let path = projects::path_of(&app.state::<AppState>().db, project_id)?;
        branches::list(&path)
    })
    .await
}

#[tauri::command]
pub async fn git_checkout(app: AppHandle, project_id: i64, name: String, remote: bool) -> AppResult<ProjectDetails> {
    blocking(move || {
        let path = projects::path_of(&app.state::<AppState>().db, project_id)?;
        branches::checkout(&path, &name, remote)?;
        Ok(projects::details(project_id, &path))
    })
    .await
}

#[tauri::command]
pub async fn git_create_branch(
    app: AppHandle,
    project_id: i64,
    name: String,
    from: Option<String>,
    switch: bool,
) -> AppResult<ProjectDetails> {
    blocking(move || {
        let path = projects::path_of(&app.state::<AppState>().db, project_id)?;
        branches::create(&path, name.trim(), from.as_deref(), switch)?;
        Ok(projects::details(project_id, &path))
    })
    .await
}
