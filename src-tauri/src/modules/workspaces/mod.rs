//! Workspace Manager : profils de travail = suite d'étapes exécutées en un clic.
//!
//! Une session garde la trace de ce qu'elle a lancé (exécutions de scripts, PID d'applications)
//! pour pouvoir tout arrêter proprement, et chaque démarrage est historisé.

use std::collections::HashMap;
use std::sync::Mutex;

use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::database::Database;
use crate::error::{AppError, AppResult};
use crate::modules::servers::tunnels;
use crate::modules::settings::SettingsService;
use crate::modules::{apps, editor, events, projects, runner};
use crate::state::AppState;

pub const EVENT_CHANGED: &str = "workspace://changed";
const MAX_STEPS: usize = 30;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Step {
    /// Ouvre le projet dans l'éditeur.
    Editor { project_id: i64 },
    /// Ouvre le dossier du projet dans l'Explorateur.
    Folder { project_id: i64 },
    /// Lance un script du package.json ; ouvre éventuellement le navigateur quand le serveur est prêt.
    Script {
        project_id: i64,
        script: String,
        #[serde(default)]
        open_browser: bool,
    },
    /// Lance une application enregistrée ; `close_on_stop` la ferme à l'arrêt de la session (.exe uniquement).
    App {
        app_id: i64,
        #[serde(default)]
        close_on_stop: bool,
    },
    /// Ouvre une adresse http(s) dans le navigateur.
    Url { url: String },
    /// Ouvre un tunnel SSH ; `close_on_stop` le ferme à l'arrêt de la session.
    TunnelOpen {
        tunnel_id: i64,
        #[serde(default)]
        close_on_stop: bool,
    },
    /// Ferme un tunnel SSH.
    TunnelClose { tunnel_id: i64 },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: i64,
    pub name: String,
    pub description: String,
    pub favorite: bool,
    pub steps: Vec<Step>,
    pub active: Option<ActiveInfo>,
    pub last_started_at: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceInput {
    pub id: Option<i64>,
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub favorite: bool,
    pub steps: Vec<Step>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StepResult {
    pub label: String,
    pub ok: bool,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveInfo {
    pub session_id: i64,
    pub started_at: i64,
    pub run_ids: Vec<u64>,
    pub results: Vec<StepResult>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRecord {
    pub id: i64,
    pub workspace_id: Option<i64>,
    pub workspace_name: String,
    pub started_at: i64,
    pub ended_at: Option<i64>,
    /// running | completed | partial | stopped | interrupted
    pub status: String,
    pub results: Vec<StepResult>,
}

struct ActiveSession {
    info: ActiveInfo,
    /// PID des applications à fermer à l'arrêt.
    app_pids: Vec<u32>,
    /// Tunnels SSH à fermer à l'arrêt.
    tunnel_ids: Vec<i64>,
}

/// Sessions en cours, indexées par workspace (une seule session active par workspace).
#[derive(Default)]
pub struct WorkspaceRuntime {
    active: Mutex<HashMap<i64, ActiveSession>>,
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

// ------------------------------------------------------------------ Stockage

fn exists(db: &Database, table: &str, id: i64) -> AppResult<bool> {
    // `table` vient uniquement de ce module (jamais du frontend).
    db.with(|conn| {
        Ok(conn
            .query_row(
                &format!("SELECT 1 FROM {table} WHERE id = ?1"),
                params![id],
                |_| Ok(()),
            )
            .optional()?
            .is_some())
    })
}

fn validate(db: &Database, input: &WorkspaceInput) -> AppResult<()> {
    let name = input.name.trim();
    if name.is_empty() || name.len() > 80 {
        return Err(AppError::InvalidInput(
            "le nom doit faire entre 1 et 80 caractères".into(),
        ));
    }
    if input.description.len() > 300 {
        return Err(AppError::InvalidInput(
            "description trop longue (300 caractères max.)".into(),
        ));
    }
    if input.steps.len() > MAX_STEPS {
        return Err(AppError::InvalidInput(format!(
            "{MAX_STEPS} étapes maximum"
        )));
    }
    for step in &input.steps {
        match step {
            Step::Editor { project_id }
            | Step::Folder { project_id }
            | Step::Script { project_id, .. } => {
                if !exists(db, "projects", *project_id)? {
                    return Err(AppError::InvalidInput(format!(
                        "projet {project_id} inconnu"
                    )));
                }
                if let Step::Script { script, .. } = step {
                    if script.trim().is_empty() {
                        return Err(AppError::InvalidInput("script manquant".into()));
                    }
                }
            }
            Step::App { app_id, .. } => {
                if !exists(db, "app_shortcuts", *app_id)? {
                    return Err(AppError::InvalidInput(format!(
                        "application {app_id} inconnue"
                    )));
                }
            }
            Step::Url { url } => validate_url(url)?,
            Step::TunnelOpen { tunnel_id, .. } | Step::TunnelClose { tunnel_id } => {
                if !exists(db, "ssh_tunnels", *tunnel_id)? {
                    return Err(AppError::InvalidInput(format!(
                        "tunnel {tunnel_id} inconnu"
                    )));
                }
            }
        }
    }
    Ok(())
}

fn validate_url(url: &str) -> AppResult<()> {
    let lower = url.trim().to_ascii_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://"))
        || url.len() > 2000
        || url.contains(char::is_whitespace)
    {
        return Err(AppError::InvalidInput(format!(
            "URL invalide : {url} (http:// ou https:// attendu)"
        )));
    }
    Ok(())
}

fn load_steps(db: &Database, workspace_id: i64) -> AppResult<Vec<Step>> {
    db.with(|conn| {
        let mut stmt = conn.prepare(
            "SELECT action FROM workspace_steps WHERE workspace_id = ?1 ORDER BY position",
        )?;
        let rows = stmt.query_map(params![workspace_id], |r| r.get::<_, String>(0))?;
        // Une étape illisible (format modifié) est ignorée plutôt que de casser tout le workspace.
        Ok(rows
            .filter_map(|r| r.ok())
            .filter_map(|json| serde_json::from_str(&json).ok())
            .collect())
    })
}

pub fn list(db: &Database, runtime: &WorkspaceRuntime) -> AppResult<Vec<Workspace>> {
    let base: Vec<(i64, String, String, bool, Option<i64>)> = db.with(|conn| {
        let mut stmt = conn.prepare(
            "SELECT w.id, w.name, w.description, w.favorite,
                    (SELECT MAX(started_at) FROM workspace_sessions s WHERE s.workspace_id = w.id)
             FROM workspaces w ORDER BY w.favorite DESC, w.name COLLATE NOCASE",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get::<_, i64>(3)? != 0,
                r.get(4)?,
            ))
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    })?;
    let active = runtime.active.lock()?;
    base.into_iter()
        .map(|(id, name, description, favorite, last_started_at)| {
            Ok(Workspace {
                steps: load_steps(db, id)?,
                active: active.get(&id).map(|a| a.info.clone()),
                id,
                name,
                description,
                favorite,
                last_started_at,
            })
        })
        .collect()
}

pub fn save(db: &Database, input: &WorkspaceInput) -> AppResult<i64> {
    validate(db, input)?;
    db.with(|conn| {
        let tx = conn.unchecked_transaction()?;
        let id = match input.id {
            Some(id) => {
                let n = tx.execute(
                    "UPDATE workspaces SET name = ?1, description = ?2, favorite = ?3 WHERE id = ?4",
                    params![input.name.trim(), input.description.trim(), input.favorite as i64, id],
                )?;
                if n == 0 {
                    return Err(AppError::InvalidInput(format!("workspace {id} inconnu")));
                }
                tx.execute("DELETE FROM workspace_steps WHERE workspace_id = ?1", params![id])?;
                id
            }
            None => {
                tx.execute(
                    "INSERT INTO workspaces (name, description, favorite, created_at) VALUES (?1, ?2, ?3, ?4)",
                    params![input.name.trim(), input.description.trim(), input.favorite as i64, now()],
                )?;
                tx.last_insert_rowid()
            }
        };
        for (pos, step) in input.steps.iter().enumerate() {
            let json = serde_json::to_string(step).map_err(|e| AppError::InvalidInput(e.to_string()))?;
            tx.execute(
                "INSERT INTO workspace_steps (workspace_id, position, action) VALUES (?1, ?2, ?3)",
                params![id, pos as i64, json],
            )?;
        }
        tx.commit()?;
        Ok(id)
    })
}

pub fn delete(db: &Database, runtime: &WorkspaceRuntime, id: i64) -> AppResult<()> {
    if runtime.active.lock()?.contains_key(&id) {
        return Err(AppError::InvalidInput(
            "arrêtez la session avant de supprimer ce workspace".into(),
        ));
    }
    db.with(|conn| {
        conn.execute("DELETE FROM workspaces WHERE id = ?1", params![id])?;
        Ok(())
    })
}

pub fn set_favorite(db: &Database, id: i64, favorite: bool) -> AppResult<()> {
    db.with(|conn| {
        conn.execute(
            "UPDATE workspaces SET favorite = ?1 WHERE id = ?2",
            params![favorite as i64, id],
        )?;
        Ok(())
    })
}

pub fn history(db: &Database, limit: u32) -> AppResult<Vec<SessionRecord>> {
    db.with(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id, workspace_id, workspace_name, started_at, ended_at, status, results
             FROM workspace_sessions ORDER BY started_at DESC, id DESC LIMIT ?1",
        )?;
        let rows = stmt.query_map(params![limit.min(200)], |r| {
            let results: String = r.get(6)?;
            Ok(SessionRecord {
                id: r.get(0)?,
                workspace_id: r.get(1)?,
                workspace_name: r.get(2)?,
                started_at: r.get(3)?,
                ended_at: r.get(4)?,
                status: r.get(5)?,
                results: serde_json::from_str(&results).unwrap_or_default(),
            })
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    })
}

/// Au démarrage de DevCenter : les sessions restées « running » ont été interrompues.
pub fn mark_interrupted(db: &Database) -> AppResult<()> {
    db.with(|conn| {
        conn.execute(
            "UPDATE workspace_sessions SET status = 'interrupted', ended_at = COALESCE(ended_at, started_at)
             WHERE ended_at IS NULL",
            [],
        )?;
        Ok(())
    })
}

// ------------------------------------------------------------------ Sessions

fn project_label(db: &Database, project_id: i64) -> String {
    db.with(|conn| {
        Ok(conn
            .query_row(
                "SELECT name FROM projects WHERE id = ?1",
                params![project_id],
                |r| r.get::<_, String>(0),
            )
            .optional()?)
    })
    .ok()
    .flatten()
    .unwrap_or_else(|| format!("projet {project_id}"))
}

/// Ce qu'une étape a lancé et que l'arrêt de la session devra fermer.
#[derive(Default)]
struct Launched {
    run_id: Option<u64>,
    pid: Option<u32>,
    tunnel_id: Option<i64>,
}

impl Launched {
    fn run(run_id: u64) -> AppResult<Self> {
        Ok(Self {
            run_id: Some(run_id),
            ..Default::default()
        })
    }
    fn pid(pid: Option<u32>) -> AppResult<Self> {
        Ok(Self {
            pid,
            ..Default::default()
        })
    }
    fn nothing() -> AppResult<Self> {
        Ok(Self::default())
    }
}

/// Délai d'ouverture d'un tunnel avant de passer à l'étape suivante.
const TUNNEL_READY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);

fn tunnel_label(db: &Database, tunnel_id: i64) -> String {
    tunnels::get(db, tunnel_id)
        .map(|t| format!("{} ({})", t.name, t.server_name))
        .unwrap_or_else(|_| format!("tunnel {tunnel_id}"))
}

/// Exécute une étape. Retourne le libellé et ce qui a été lancé.
fn run_step(app: &AppHandle, state: &AppState, step: &Step) -> (String, AppResult<Launched>) {
    let db = &state.db;
    match step {
        Step::Editor { project_id } => (
            format!("Ouvrir {} dans l'éditeur", project_label(db, *project_id)),
            projects::path_of(db, *project_id).and_then(|path| {
                let settings = SettingsService::load(db)?;
                editor::open(settings.editor_path.as_deref(), &path)?;
                Launched::nothing()
            }),
        ),
        Step::Folder { project_id } => (
            format!("Ouvrir le dossier de {}", project_label(db, *project_id)),
            projects::path_of(db, *project_id).and_then(|path| {
                tauri_plugin_opener::open_path(&path, None::<&str>)
                    .map_err(|e| AppError::InvalidInput(e.to_string()))?;
                Launched::nothing()
            }),
        ),
        Step::Script {
            project_id,
            script,
            open_browser,
        } => (
            format!("{} : {script}", project_label(db, *project_id)),
            projects::path_of(db, *project_id).and_then(|path| {
                let meta = projects::detect::detect(&path);
                let declared =
                    meta.scripts
                        .iter()
                        .find(|s| &s.name == script)
                        .ok_or_else(|| {
                            AppError::InvalidInput(format!(
                                "script « {script} » absent du package.json"
                            ))
                        })?;
                let pm = meta.package_manager.as_deref().unwrap_or("npm");
                let run = state.runner.start(
                    app,
                    *project_id,
                    &path,
                    pm,
                    &declared.name,
                    &declared.command,
                    *open_browser,
                )?;
                Launched::run(run.id)
            }),
        ),
        Step::App {
            app_id,
            close_on_stop,
        } => (
            format!(
                "Lancer {}",
                apps::name_of(db, *app_id).unwrap_or_else(|| format!("application {app_id}"))
            ),
            apps::resolve(db, *app_id).and_then(|path| {
                let pid = apps::launch(&path)?;
                Launched::pid(if *close_on_stop { pid } else { None })
            }),
        ),
        Step::Url { url } => (
            format!("Ouvrir {url}"),
            validate_url(url).and_then(|_| {
                tauri_plugin_opener::open_url(url, None::<&str>)
                    .map_err(|e| AppError::InvalidInput(e.to_string()))?;
                Launched::nothing()
            }),
        ),
        Step::TunnelOpen {
            tunnel_id,
            close_on_stop,
        } => (
            format!("Ouvrir le tunnel {}", tunnel_label(db, *tunnel_id)),
            (|| {
                let already = state.tunnels.is_active(*tunnel_id);
                state.tunnels.start(app, db, *tunnel_id)?;
                state.tunnels.wait_ready(*tunnel_id, TUNNEL_READY_TIMEOUT)?;
                // Un tunnel déjà ouvert avant la session n'est pas fermé par elle.
                Ok(Launched {
                    tunnel_id: (*close_on_stop && !already).then_some(*tunnel_id),
                    ..Default::default()
                })
            })(),
        ),
        Step::TunnelClose { tunnel_id } => (
            format!("Fermer le tunnel {}", tunnel_label(db, *tunnel_id)),
            tunnels::get(db, *tunnel_id).and_then(|_| {
                state.tunnels.stop(app, *tunnel_id)?;
                Launched::nothing()
            }),
        ),
    }
}

pub fn start(app: &AppHandle, state: &AppState, id: i64) -> AppResult<ActiveInfo> {
    if state.workspaces.active.lock()?.contains_key(&id) {
        return Err(AppError::InvalidInput(
            "ce workspace est déjà démarré".into(),
        ));
    }
    let name: String = state
        .db
        .with(|conn| {
            Ok(conn
                .query_row(
                    "SELECT name FROM workspaces WHERE id = ?1",
                    params![id],
                    |r| r.get(0),
                )
                .optional()?)
        })?
        .ok_or_else(|| AppError::InvalidInput(format!("workspace {id} inconnu")))?;
    let steps = load_steps(&state.db, id)?;
    if steps.is_empty() {
        return Err(AppError::InvalidInput(
            "ce workspace n'a aucune étape".into(),
        ));
    }

    let started_at = now();
    let mut results = Vec::new();
    let mut run_ids = Vec::new();
    let mut app_pids = Vec::new();
    let mut tunnel_ids = Vec::new();
    // Les étapes s'enchaînent ; un échec n'empêche pas les suivantes.
    for step in &steps {
        let (label, outcome) = run_step(app, state, step);
        match outcome {
            Ok(launched) => {
                run_ids.extend(launched.run_id);
                app_pids.extend(launched.pid);
                tunnel_ids.extend(launched.tunnel_id);
                results.push(StepResult {
                    label,
                    ok: true,
                    message: None,
                });
            }
            Err(e) => results.push(StepResult {
                label,
                ok: false,
                message: Some(e.to_string()),
            }),
        }
    }

    let status = if results.iter().all(|r| r.ok) {
        "running"
    } else {
        "partial"
    };
    let results_json = serde_json::to_string(&results).unwrap_or_else(|_| "[]".into());
    let session_id = state.db.with(|conn| {
        conn.execute(
            "INSERT INTO workspace_sessions (workspace_id, workspace_name, started_at, status, results)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![id, name, started_at, status, results_json],
        )?;
        Ok(conn.last_insert_rowid())
    })?;

    let failures: Vec<&StepResult> = results.iter().filter(|r| !r.ok).collect();
    if !failures.is_empty() {
        crate::modules::notify::dispatch(
            app,
            crate::modules::notify::Event {
                category: crate::modules::notify::Category::Workspace,
                target: Some(crate::modules::notify::Target::Workspace { workspace_id: id }),
                retry: Some(crate::modules::notify::Retry::Workspace { id }),
                title: format!("{} · {} étape(s) en échec", name, failures.len()),
                body: failures
                    .iter()
                    .map(|f| format!("{} : {}", f.label, f.message.clone().unwrap_or_default()))
                    .collect::<Vec<_>>()
                    .join("\n"),
                tab: Some("workspaces".into()),
                tag: Some(format!("workspace-{id}")),
            },
        );
    }
    let info = ActiveInfo {
        session_id,
        started_at,
        run_ids,
        results,
    };
    state.workspaces.active.lock()?.insert(
        id,
        ActiveSession {
            info: info.clone(),
            app_pids,
            tunnel_ids,
        },
    );
    let _ = app.emit(EVENT_CHANGED, id);
    events::workspace_started(app, id, &name, &info.results);
    Ok(info)
}

/// Arrête tout ce que la session a lancé : scripts (arbre de processus) et applications marquées.
pub fn stop(app: &AppHandle, state: &AppState, id: i64) -> AppResult<()> {
    let session =
        state.workspaces.active.lock()?.remove(&id).ok_or_else(|| {
            AppError::InvalidInput("aucune session active pour ce workspace".into())
        })?;
    for run_id in &session.info.run_ids {
        let _ = state.runner.stop(*run_id);
    }
    for pid in &session.app_pids {
        runner::kill_tree(*pid);
    }
    for tunnel_id in &session.tunnel_ids {
        let _ = state.tunnels.stop(app, *tunnel_id);
    }
    let status = if session.info.results.iter().all(|r| r.ok) {
        "completed"
    } else {
        "partial"
    };
    state.db.with(|conn| {
        conn.execute(
            "UPDATE workspace_sessions SET ended_at = ?1, status = ?2 WHERE id = ?3",
            params![now(), status, session.info.session_id],
        )?;
        Ok(())
    })?;
    let _ = app.emit(EVENT_CHANGED, id);
    events::workspace_stopped(app, id);
    Ok(())
}

/// Fermeture de DevCenter : clôture les sessions (les scripts sont arrêtés par le runner).
pub fn close_all(state: &AppState) {
    let Ok(mut active) = state.workspaces.active.lock() else {
        return;
    };
    for (_, session) in active.drain() {
        for pid in &session.app_pids {
            runner::kill_tree(*pid);
        }
        let _ = state.db.with(|conn| {
            conn.execute(
                "UPDATE workspace_sessions SET ended_at = ?1, status = 'stopped' WHERE id = ?2",
                params![now(), session.info.session_id],
            )?;
            Ok(())
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> (Database, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!(
            "devcenter-ws-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        (Database::open(&dir.join("t.db")).unwrap(), dir)
    }

    #[test]
    fn step_json_format() {
        let s = Step::Script {
            project_id: 3,
            script: "dev".into(),
            open_browser: true,
        };
        let json = serde_json::to_string(&s).unwrap();
        assert_eq!(
            json,
            r#"{"kind":"script","projectId":3,"script":"dev","openBrowser":true}"#
        );
        let back: Step = serde_json::from_str(r#"{"kind":"app","appId":1}"#).unwrap();
        assert_eq!(
            back,
            Step::App {
                app_id: 1,
                close_on_stop: false
            }
        );
    }

    #[test]
    fn save_validates_and_round_trips() {
        let (db, dir) = db();
        let runtime = WorkspaceRuntime::default();
        let project = dir.join("proj");
        std::fs::create_dir_all(&project).unwrap();
        let pid = projects::add(&db, &[project.display().to_string()]).unwrap()[0].id;

        // Références inconnues et URL non http refusées.
        let bad = WorkspaceInput {
            id: None,
            name: "Dev".into(),
            description: String::new(),
            favorite: false,
            steps: vec![Step::Editor { project_id: 999 }],
        };
        assert!(save(&db, &bad).is_err());
        let bad_url = WorkspaceInput {
            steps: vec![Step::Url {
                url: "file:///C:/Windows".into(),
            }],
            ..bad
        };
        assert!(save(&db, &bad_url).is_err());

        let steps = vec![
            Step::Editor { project_id: pid },
            Step::Script {
                project_id: pid,
                script: "dev".into(),
                open_browser: true,
            },
            Step::Url {
                url: "http://localhost:5173".into(),
            },
        ];
        let id = save(
            &db,
            &WorkspaceInput {
                id: None,
                name: " Front ".into(),
                description: "x".into(),
                favorite: true,
                steps: steps.clone(),
            },
        )
        .unwrap();
        let list = list(&db, &runtime).unwrap();
        assert_eq!(list[0].name, "Front");
        assert_eq!(list[0].steps, steps);

        // Mise à jour : les étapes sont remplacées, pas ajoutées.
        save(
            &db,
            &WorkspaceInput {
                id: Some(id),
                name: "Front".into(),
                description: String::new(),
                favorite: false,
                steps: vec![Step::Folder { project_id: pid }],
            },
        )
        .unwrap();
        assert_eq!(super::list(&db, &runtime).unwrap()[0].steps.len(), 1);

        // Supprimer le projet supprime l'étape ? Non : l'étape reste mais échouera au démarrage.
        delete(&db, &runtime, id).unwrap();
        assert!(super::list(&db, &runtime).unwrap().is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }
}
