//! Journal unifié : bus d'événements en mémoire (tampon circulaire) alimenté par les autres
//! modules (scripts, workspaces, automatisations, serveurs, mises à jour).
//!
//! Chaque événement est gardé dans le tampon (les plus anciens sont retirés au-delà de
//! [`CAPACITY`]) et envoyé à l'interface (`events://new`). Rien n'est écrit en base : le journal
//! repart à vide à chaque lancement de DevCenter.
//!
//! Usage depuis un module, en une ligne :
//! `events::Entry::error(Source::Runner, "Échec · dev").detail("code 1").link("/projects").emit(app);`

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{OptionalExtension, params};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::modules::automations::StepLog;
use crate::modules::runner::{RunInfo, RunStatus};
use crate::modules::workspaces::StepResult;
use crate::state::AppState;

pub const EVENT_NEW: &str = "events://new";
pub const EVENT_CLEARED: &str = "events://cleared";
/// Nombre maximum d'événements gardés en mémoire.
pub const CAPACITY: usize = 2000;
/// Un détail trop long (sortie d'erreur…) est tronqué.
const MAX_DETAIL: usize = 2000;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Level {
    Info,
    Warn,
    Error,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    App,
    Runner,
    Workspace,
    Automation,
    Server,
    Update,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub id: u64,
    /// Horodatage Unix en millisecondes.
    pub timestamp: u64,
    pub source: Source,
    pub level: Level,
    pub title: String,
    pub detail: Option<String>,
    /// Route de l'interface vers le détail (« /automations?automation=3 »).
    pub link: Option<String>,
}

struct Bus {
    entries: Mutex<VecDeque<Entry>>,
    next_id: AtomicU64,
    /// Dernier état connu de chaque serveur (joignable ou non) : seuls les changements sont notés.
    servers: Mutex<HashMap<i64, bool>>,
}

fn bus() -> &'static Bus {
    static BUS: OnceLock<Bus> = OnceLock::new();
    BUS.get_or_init(|| Bus {
        entries: Mutex::new(VecDeque::with_capacity(CAPACITY)),
        next_id: AtomicU64::new(0),
        servers: Mutex::new(HashMap::new()),
    })
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

impl Entry {
    pub fn new(source: Source, level: Level, title: impl Into<String>) -> Self {
        Entry {
            id: 0,
            timestamp: 0,
            source,
            level,
            title: title.into(),
            detail: None,
            link: None,
        }
    }
    pub fn info(source: Source, title: impl Into<String>) -> Self {
        Self::new(source, Level::Info, title)
    }
    pub fn warn(source: Source, title: impl Into<String>) -> Self {
        Self::new(source, Level::Warn, title)
    }
    pub fn error(source: Source, title: impl Into<String>) -> Self {
        Self::new(source, Level::Error, title)
    }
    pub fn detail(mut self, detail: impl Into<String>) -> Self {
        let detail: String = detail.into();
        let detail = if detail.chars().count() > MAX_DETAIL {
            format!("{}…", detail.chars().take(MAX_DETAIL).collect::<String>())
        } else {
            detail
        };
        self.detail = Some(detail).filter(|d| !d.trim().is_empty());
        self
    }
    pub fn link(mut self, link: impl Into<String>) -> Self {
        self.link = Some(link.into());
        self
    }

    /// Ajoute l'événement au journal et l'envoie à l'interface.
    pub fn emit(self, app: &AppHandle) {
        let entry = record(self);
        let _ = app.emit(EVENT_NEW, &entry);
    }
}

/// Ajoute au tampon (sans envoi) ; retourne l'événement numéroté et horodaté.
fn record(mut entry: Entry) -> Entry {
    let bus = bus();
    entry.id = bus.next_id.fetch_add(1, Ordering::Relaxed) + 1;
    entry.timestamp = now_ms();
    if let Ok(mut entries) = bus.entries.lock() {
        while entries.len() >= CAPACITY {
            entries.pop_front();
        }
        entries.push_back(entry.clone());
    }
    entry
}

/// Événements en mémoire, du plus ancien au plus récent.
pub fn backlog() -> Vec<Entry> {
    bus()
        .entries
        .lock()
        .map(|e| e.iter().cloned().collect())
        .unwrap_or_default()
}

/// Vide le journal (toutes les fenêtres sont prévenues).
pub fn clear(app: &AppHandle) {
    if let Ok(mut entries) = bus().entries.lock() {
        entries.clear();
    }
    let _ = app.emit(EVENT_CLEARED, ());
}

/// Nom d'un élément en base pour les libellés (`table` vient uniquement de ce module).
fn name_in(app: &AppHandle, table: &str, id: i64) -> Option<String> {
    let state = app.try_state::<AppState>()?;
    state
        .db
        .with(|conn| {
            Ok(conn
                .query_row(
                    &format!("SELECT name FROM {table} WHERE id = ?1"),
                    params![id],
                    |r| r.get::<_, String>(0),
                )
                .optional()?)
        })
        .ok()
        .flatten()
}

/// Nom d'un projet pour les libellés (`projet 3` s'il a disparu).
pub fn project_name(app: &AppHandle, project_id: i64) -> String {
    name_in(app, "projects", project_id).unwrap_or_else(|| format!("projet {project_id}"))
}

/// Démarrage d'une session de workspace : avertissement si des étapes ont échoué.
pub fn workspace_started(app: &AppHandle, id: i64, name: &str, results: &[StepResult]) {
    let failures: Vec<String> = results
        .iter()
        .filter(|r| !r.ok)
        .map(|r| format!("{} : {}", r.label, r.message.clone().unwrap_or_default()))
        .collect();
    let entry = if failures.is_empty() {
        Entry::info(Source::Workspace, format!("{name} · session démarrée"))
            .detail(format!("{} étape(s) exécutée(s)", results.len()))
    } else {
        Entry::warn(
            Source::Workspace,
            format!("{name} · {} étape(s) en échec", failures.len()),
        )
        .detail(failures.join("\n"))
    };
    entry.link(format!("/workspaces?workspace={id}")).emit(app);
}

/// Arrêt d'une session de workspace.
pub fn workspace_stopped(app: &AppHandle, id: i64) {
    let name = name_in(app, "workspaces", id).unwrap_or_else(|| format!("workspace {id}"));
    Entry::info(Source::Workspace, format!("{name} · session arrêtée"))
        .link(format!("/workspaces?workspace={id}"))
        .emit(app);
}

/// Fin d'une exécution d'automatisation, niveau selon le statut.
pub fn automation_finished(app: &AppHandle, name: &str, id: i64, status: &str, log: &[StepLog]) {
    let failure = log
        .iter()
        .find(|l| l.outcome == "failed")
        .map(|l| format!("{} : {}", l.label, l.message.clone().unwrap_or_default()));
    let entry = match status {
        "success" => Entry::info(Source::Automation, format!("{name} · réussie"))
            .detail(format!("{} étape(s)", log.len())),
        "stopped" => Entry::info(
            Source::Automation,
            format!("{name} · condition non remplie"),
        ),
        "timeout" => Entry::warn(
            Source::Automation,
            format!("{name} · délai maximum dépassé"),
        ),
        _ => Entry::error(Source::Automation, format!("{name} · échec"))
            .detail(failure.unwrap_or_default()),
    };
    entry
        .link(format!("/automations?automation={id}"))
        .emit(app);
}

/// Vérification des mises à jour : une version disponible n'est notée qu'une fois.
pub fn update_checked(app: &AppHandle, available: Option<&str>) {
    static LAST: Mutex<Option<String>> = Mutex::new(None);
    let Some(version) = available else { return };
    let Ok(mut last) = LAST.lock() else { return };
    if last.as_deref() == Some(version) {
        return;
    }
    *last = Some(version.to_string());
    drop(last);
    Entry::info(
        Source::Update,
        format!("Mise à jour disponible : {version}"),
    )
    .link("/settings")
    .emit(app);
}

/// Fin d'un script : terminé (code 0), arrêté à la main, ou planté (code non nul).
pub fn run_finished(app: &AppHandle, run: &RunInfo) {
    let name = project_name(app, run.project_id);
    let code = run
        .exit_code
        .map(|c| c.to_string())
        .unwrap_or_else(|| "?".into());
    let entry = match run.status {
        RunStatus::Failed => {
            Entry::error(Source::Runner, format!("{name} · {} a planté", run.script))
                .detail(format!("Code de sortie {code}"))
        }
        RunStatus::Stopped => {
            Entry::info(Source::Runner, format!("{name} · {} arrêté", run.script))
        }
        _ => Entry::info(Source::Runner, format!("{name} · {} terminé", run.script))
            .detail(format!("Code de sortie {code}")),
    };
    entry
        .link(format!("/projects?project={}", run.project_id))
        .emit(app);
}

/// Note le résultat d'une vérification de serveur, seulement quand son état change
/// (au premier contrôle, seul un serveur injoignable est noté).
pub fn server_status(app: &AppHandle, id: i64, name: &str, error: Option<String>) {
    let online = error.is_none();
    let previous = match bus().servers.lock() {
        Ok(mut servers) => servers.insert(id, online),
        Err(_) => return,
    };
    if previous == Some(online) || (previous.is_none() && online) {
        return;
    }
    let link = format!("/servers?server={id}");
    let entry = if online {
        Entry::info(Source::Server, format!("{name} · de nouveau joignable"))
    } else {
        Entry::error(Source::Server, format!("{name} · injoignable"))
            .detail(error.unwrap_or_default())
    };
    entry.link(link).emit(app);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ring_buffer_keeps_the_most_recent() {
        for i in 0..(CAPACITY + 5) {
            record(Entry::info(Source::App, format!("e{i}")));
        }
        let all = backlog();
        assert_eq!(all.len(), CAPACITY);
        assert_eq!(all.last().unwrap().title, format!("e{}", CAPACITY + 4));
        assert!(all.windows(2).all(|w| w[0].id < w[1].id));
    }

    #[test]
    fn detail_is_truncated_and_blank_dropped() {
        let e = Entry::info(Source::App, "x").detail("a".repeat(MAX_DETAIL + 10));
        assert_eq!(e.detail.unwrap().chars().count(), MAX_DETAIL + 1);
        assert!(Entry::info(Source::App, "x").detail("  ").detail.is_none());
    }
}
