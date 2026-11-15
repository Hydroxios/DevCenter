use crate::database::Database;
use crate::modules::github::GithubCache;
use crate::modules::projects::import::CloneJobs;
use crate::modules::automations::AutomationRuntime;
use crate::modules::remote::RemoteAccess;
use crate::modules::runner::Runner;
use crate::modules::servers::terminal::Terminals;
use crate::modules::settings::SettingsService;
use crate::modules::system::SystemService;
use crate::modules::workspaces::WorkspaceRuntime;

/// État partagé, injecté dans les commandes via `State<AppState>`.
pub struct AppState {
    pub db: Database,
    pub settings: SettingsService,
    pub system: SystemService,
    pub runner: Runner,
    pub workspaces: WorkspaceRuntime,
    pub terminals: Terminals,
    pub automations: AutomationRuntime,
    pub remote: RemoteAccess,
    pub clones: CloneJobs,
    pub github: GithubCache,
}
