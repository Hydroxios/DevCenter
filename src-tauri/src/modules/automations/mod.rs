//! Automation Engine : workflows = déclencheur + suite d'étapes (actions, conditions, attentes).
//!
//! Exécution sur un thread dédié par workflow (un seul passage simultané par workflow),
//! délai maximum global, gestion d'erreur configurable et historique en base.

mod scheduler;
mod steps;

use std::collections::HashSet;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::database::Database;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

pub use scheduler::spawn_scheduler;
pub use steps::Step;

pub const EVENT_CHANGED: &str = "automation://changed";
const MAX_STEPS: usize = 40;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Trigger {
    Manual,
    /// Toutes les N minutes (1 à 1440).
    Interval {
        minutes: u32,
    },
    /// Chaque jour à `time` (« HH:MM », heure locale) ; `days` : 0 = lundi … 6 = dimanche, vide = tous.
    Daily {
        time: String,
        #[serde(default)]
        days: Vec<u8>,
    },
    /// Au démarrage de DevCenter.
    AppStart,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum OnError {
    #[default]
    Stop,
    Continue,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Automation {
    pub id: i64,
    pub name: String,
    pub description: String,
    pub enabled: bool,
    pub trigger: Trigger,
    pub steps: Vec<Step>,
    pub on_error: OnError,
    /// Durée maximale d'une exécution, en minutes.
    pub timeout_minutes: u32,
    pub running: bool,
    pub last_run: Option<RunSummary>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationInput {
    pub id: Option<i64>,
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default = "yes")]
    pub enabled: bool,
    pub trigger: Trigger,
    pub steps: Vec<Step>,
    #[serde(default)]
    pub on_error: OnError,
    #[serde(default = "default_timeout")]
    pub timeout_minutes: u32,
}

fn yes() -> bool {
    true
}
fn default_timeout() -> u32 {
    30
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StepLog {
    pub label: String,
    /// ok | failed | skipped
    pub outcome: String,
    pub message: Option<String>,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunSummary {
    pub id: i64,
    pub automation_id: Option<i64>,
    pub automation_name: String,
    /// manual | schedule | startup
    pub origin: String,
    pub started_at: i64,
    pub ended_at: Option<i64>,
    /// running | success | failed | stopped (condition non remplie) | timeout
    pub status: String,
    pub log: Vec<StepLog>,
}

/// Workflows en cours d'exécution.
#[derive(Default)]
pub struct AutomationRuntime {
    running: Mutex<HashSet<i64>>,
}

pub fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

// ------------------------------------------------------------------ Validation & stockage

pub fn parse_hhmm(s: &str) -> Option<(u32, u32)> {
    let (h, m) = s.trim().split_once(':')?;
    let (h, m) = (h.parse().ok()?, m.parse().ok()?);
    (h < 24 && m < 60).then_some((h, m))
}

fn validate(db: &Database, input: &AutomationInput) -> AppResult<()> {
    let name = input.name.trim();
    if name.is_empty() || name.len() > 80 {
        return Err(AppError::InvalidInput(
            "le nom doit faire entre 1 et 80 caractères".into(),
        ));
    }
    if input.description.len() > 300 {
        return Err(AppError::InvalidInput("description trop longue".into()));
    }
    if input.steps.is_empty() || input.steps.len() > MAX_STEPS {
        return Err(AppError::InvalidInput(format!(
            "entre 1 et {MAX_STEPS} étapes"
        )));
    }
    if !(1..=24 * 60).contains(&input.timeout_minutes) {
        return Err(AppError::InvalidInput(
            "délai maximum entre 1 et 1440 minutes".into(),
        ));
    }
    match &input.trigger {
        Trigger::Interval { minutes } if !(1..=24 * 60).contains(minutes) => {
            return Err(AppError::InvalidInput(
                "intervalle entre 1 et 1440 minutes".into(),
            ));
        }
        Trigger::Daily { time, days } => {
            if parse_hhmm(time).is_none() {
                return Err(AppError::InvalidInput(format!(
                    "heure invalide : {time} (HH:MM)"
                )));
            }
            if days.iter().any(|d| *d > 6) {
                return Err(AppError::InvalidInput("jour invalide".into()));
            }
        }
        _ => {}
    }
    for step in &input.steps {
        steps::validate(db, step)?;
    }
    Ok(())
}

fn row_to_automation(
    r: &rusqlite::Row<'_>,
) -> rusqlite::Result<(i64, String, String, bool, String, String, String, u32)> {
    Ok((
        r.get(0)?,
        r.get(1)?,
        r.get(2)?,
        r.get::<_, i64>(3)? != 0,
        r.get(4)?,
        r.get(5)?,
        r.get(6)?,
        r.get::<_, i64>(7)? as u32,
    ))
}

fn last_run(db: &Database, automation_id: i64) -> AppResult<Option<RunSummary>> {
    Ok(history(db, Some(automation_id), 1, None)?
        .into_iter()
        .next())
}

pub fn list(db: &Database, runtime: &AutomationRuntime) -> AppResult<Vec<Automation>> {
    let rows = db.with(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id, name, description, enabled, trigger, steps, on_error, timeout_minutes
             FROM automations ORDER BY name COLLATE NOCASE",
        )?;
        let rows = stmt.query_map([], row_to_automation)?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    })?;
    let running = runtime.running.lock()?.clone();
    rows.into_iter()
        .map(
            |(id, name, description, enabled, trigger, steps, on_error, timeout_minutes)| {
                Ok(Automation {
                    trigger: serde_json::from_str(&trigger).unwrap_or(Trigger::Manual),
                    // Étape illisible (format changé) : ignorée plutôt que de casser la liste.
                    steps: serde_json::from_value::<Vec<serde_json::Value>>(
                        serde_json::from_str(&steps).unwrap_or_default(),
                    )
                    .unwrap_or_default()
                    .into_iter()
                    .filter_map(|v| serde_json::from_value(v).ok())
                    .collect(),
                    on_error: serde_json::from_str(&on_error).unwrap_or_default(),
                    running: running.contains(&id),
                    last_run: last_run(db, id)?,
                    id,
                    name,
                    description,
                    enabled,
                    timeout_minutes,
                })
            },
        )
        .collect()
}

pub fn get(db: &Database, runtime: &AutomationRuntime, id: i64) -> AppResult<Automation> {
    list(db, runtime)?
        .into_iter()
        .find(|a| a.id == id)
        .ok_or_else(|| AppError::InvalidInput(format!("automatisation {id} inconnue")))
}

pub fn save(db: &Database, input: &AutomationInput) -> AppResult<i64> {
    validate(db, input)?;
    let trigger = to_json(&input.trigger);
    let steps = to_json(&input.steps);
    let on_error = to_json(&input.on_error);
    db.with(|conn| match input.id {
        Some(id) => {
            let n = conn.execute(
                "UPDATE automations SET name=?1, description=?2, enabled=?3, trigger=?4, steps=?5, on_error=?6, timeout_minutes=?7 WHERE id=?8",
                params![input.name.trim(), input.description.trim(), input.enabled as i64, trigger, steps, on_error, input.timeout_minutes, id],
            )?;
            if n == 0 {
                return Err(AppError::InvalidInput(format!("automatisation {id} inconnue")));
            }
            Ok(id)
        }
        None => {
            conn.execute(
                "INSERT INTO automations (name, description, enabled, trigger, steps, on_error, timeout_minutes, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![input.name.trim(), input.description.trim(), input.enabled as i64, trigger, steps, on_error, input.timeout_minutes, now()],
            )?;
            Ok(conn.last_insert_rowid())
        }
    })
}

fn to_json<T: Serialize>(value: &T) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "null".into())
}

pub fn delete(db: &Database, runtime: &AutomationRuntime, id: i64) -> AppResult<()> {
    if runtime.running.lock()?.contains(&id) {
        return Err(AppError::InvalidInput(
            "attendez la fin de l'exécution en cours".into(),
        ));
    }
    db.with(|conn| {
        conn.execute("DELETE FROM automations WHERE id = ?1", params![id])?;
        Ok(())
    })
}

pub fn set_enabled(db: &Database, id: i64, enabled: bool) -> AppResult<()> {
    db.with(|conn| {
        conn.execute(
            "UPDATE automations SET enabled = ?1 WHERE id = ?2",
            params![enabled as i64, id],
        )?;
        Ok(())
    })
}

/// Historique du plus récent au plus ancien. `before_id` : curseur de pagination (exécutions
/// antérieures à celle-ci), pour charger la suite au défilement.
pub fn history(
    db: &Database,
    automation_id: Option<i64>,
    limit: u32,
    before_id: Option<i64>,
) -> AppResult<Vec<RunSummary>> {
    db.with(|conn| {
        let sql = "SELECT id, automation_id, automation_name, origin, started_at, ended_at, status, log
                   FROM automation_runs
                   WHERE (?1 IS NULL OR automation_id = ?1)
                     AND (?3 IS NULL OR (started_at, id) < (SELECT started_at, id FROM automation_runs WHERE id = ?3))
                   ORDER BY started_at DESC, id DESC LIMIT ?2";
        let mut stmt = conn.prepare(sql)?;
        let rows = stmt.query_map(params![automation_id, limit.clamp(1, 200), before_id], |r| {
            let log: String = r.get(7)?;
            Ok(RunSummary {
                id: r.get(0)?,
                automation_id: r.get(1)?,
                automation_name: r.get(2)?,
                origin: r.get(3)?,
                started_at: r.get(4)?,
                ended_at: r.get(5)?,
                status: r.get(6)?,
                log: serde_json::from_str(&log).unwrap_or_default(),
            })
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    })
}

/// Au démarrage : les exécutions restées « running » ont été interrompues ; on purge le vieil historique.
pub fn startup_cleanup(db: &Database) -> AppResult<()> {
    db.with(|conn| {
        conn.execute("UPDATE automation_runs SET status = 'failed', ended_at = COALESCE(ended_at, started_at) WHERE status = 'running'", [])?;
        conn.execute(
            "DELETE FROM automation_runs WHERE id NOT IN (SELECT id FROM automation_runs ORDER BY started_at DESC LIMIT 1000)",
            [],
        )?;
        Ok(())
    })
}

/// Dernier démarrage planifié (pour ne pas redéclencher après un redémarrage de DevCenter).
pub fn last_scheduled_start(db: &Database, automation_id: i64) -> AppResult<Option<i64>> {
    db.with(|conn| {
        Ok(conn
            .query_row(
                "SELECT MAX(started_at) FROM automation_runs WHERE automation_id = ?1 AND origin = 'schedule'",
                params![automation_id],
                |r| r.get::<_, Option<i64>>(0),
            )
            .optional()?
            .flatten())
    })
}

// ------------------------------------------------------------------ Exécution

/// Lance un workflow en arrière-plan. Retourne l'id de l'exécution.
pub fn trigger(app: &AppHandle, id: i64, origin: &str) -> AppResult<i64> {
    let state = app.state::<AppState>();
    let automation = get(&state.db, &state.automations, id)?;
    {
        let mut running = state.automations.running.lock()?;
        if !running.insert(id) {
            return Err(AppError::InvalidInput(format!(
                "« {} » est déjà en cours",
                automation.name
            )));
        }
    }
    let run_id = state.db.with(|conn| {
        conn.execute(
            "INSERT INTO automation_runs (automation_id, automation_name, origin, started_at, status, log)
             VALUES (?1, ?2, ?3, ?4, 'running', '[]')",
            params![id, automation.name, origin, now()],
        )?;
        Ok(conn.last_insert_rowid())
    });
    let run_id = match run_id {
        Ok(r) => r,
        Err(e) => {
            state.automations.running.lock()?.remove(&id);
            return Err(e);
        }
    };
    let _ = app.emit(EVENT_CHANGED, id);

    let app = app.clone();
    std::thread::Builder::new()
        .name(format!("automation-{id}"))
        .spawn(move || {
            let state = app.state::<AppState>();
            let (status, log) = execute(&app, &automation);
            if status == "failed" || status == "timeout" {
                let reason = log
                    .iter()
                    .find(|l| l.outcome == "failed")
                    .map(|l| format!("{} : {}", l.label, l.message.clone().unwrap_or_default()))
                    .unwrap_or_else(|| "délai maximum dépassé".into());
                crate::modules::push::notify_all(
                    &app,
                    crate::modules::push::Notification {
                        title: format!("Échec · {}", automation.name),
                        body: reason,
                        tab: Some("auto".into()),
                        tag: Some(format!("automation-{}", automation.id)),
                    },
                );
            }
            let _ = state.db.with(|conn| {
                conn.execute(
                    "UPDATE automation_runs SET status = ?1, ended_at = ?2, log = ?3 WHERE id = ?4",
                    params![
                        status,
                        now(),
                        serde_json::to_string(&log).unwrap_or_else(|_| "[]".into()),
                        run_id
                    ],
                )?;
                Ok(())
            });
            if let Ok(mut running) = state.automations.running.lock() {
                running.remove(&id);
            }
            let _ = app.emit(EVENT_CHANGED, id);
        })?;
    Ok(run_id)
}

fn execute(app: &AppHandle, automation: &Automation) -> (&'static str, Vec<StepLog>) {
    let deadline = Instant::now() + Duration::from_secs(automation.timeout_minutes as u64 * 60);
    let mut log = Vec::new();
    let mut failed = false;
    for (i, step) in automation.steps.iter().enumerate() {
        if Instant::now() >= deadline {
            log.push(StepLog {
                label: "Délai maximum atteint".into(),
                outcome: "failed".into(),
                message: None,
                duration_ms: 0,
            });
            return ("timeout", log);
        }
        let started = Instant::now();
        let label = steps::label(app, step);
        let result = steps::run(app, step, deadline);
        let duration_ms = started.elapsed().as_millis() as u64;
        match result {
            Ok(steps::Flow::Continue) => log.push(StepLog {
                label,
                outcome: "ok".into(),
                message: None,
                duration_ms,
            }),
            Ok(steps::Flow::Done(detail)) => log.push(StepLog {
                label,
                outcome: "ok".into(),
                message: Some(detail),
                duration_ms,
            }),
            Ok(steps::Flow::Stop(reason)) => {
                log.push(StepLog {
                    label,
                    outcome: "skipped".into(),
                    message: Some(reason),
                    duration_ms,
                });
                // Les étapes restantes ne sont pas exécutées : on les note pour la lisibilité.
                for rest in &automation.steps[i + 1..] {
                    log.push(StepLog {
                        label: steps::label(app, rest),
                        outcome: "skipped".into(),
                        message: None,
                        duration_ms: 0,
                    });
                }
                return (if failed { "failed" } else { "stopped" }, log);
            }
            Err(e) => {
                failed = true;
                log.push(StepLog {
                    label,
                    outcome: "failed".into(),
                    message: Some(e.to_string()),
                    duration_ms,
                });
                if automation.on_error == OnError::Stop {
                    for rest in &automation.steps[i + 1..] {
                        log.push(StepLog {
                            label: steps::label(app, rest),
                            outcome: "skipped".into(),
                            message: None,
                            duration_ms: 0,
                        });
                    }
                    return ("failed", log);
                }
            }
        }
    }
    (if failed { "failed" } else { "success" }, log)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_times() {
        assert_eq!(parse_hhmm("09:05"), Some((9, 5)));
        assert_eq!(parse_hhmm("24:00"), None);
        assert_eq!(parse_hhmm("9h"), None);
    }

    #[test]
    fn trigger_and_step_json() {
        let t: Trigger =
            serde_json::from_str(r#"{"kind":"daily","time":"09:00","days":[0,1,2,3,4]}"#).unwrap();
        assert_eq!(
            t,
            Trigger::Daily {
                time: "09:00".into(),
                days: vec![0, 1, 2, 3, 4]
            }
        );
        let s: Step = serde_json::from_str(
            r#"{"kind":"condition","condition":{"kind":"processRunning","name":"Docker Desktop.exe","negate":true}}"#,
        )
        .unwrap();
        assert!(matches!(s, Step::Condition { .. }));
    }

    #[test]
    fn validates_and_saves() {
        let dir = std::env::temp_dir().join(format!("devcenter-auto-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = Database::open(&dir.join("t.db")).unwrap();
        let rt = AutomationRuntime::default();
        let base = |trigger: Trigger, steps: Vec<Step>| AutomationInput {
            id: None,
            name: "Matin".into(),
            description: String::new(),
            enabled: true,
            trigger,
            steps,
            on_error: OnError::Continue,
            timeout_minutes: 10,
        };
        let notify = Step::Notify {
            title: "Bonjour".into(),
            body: String::new(),
        };
        assert!(
            save(
                &db,
                &base(
                    Trigger::Daily {
                        time: "25:00".into(),
                        days: vec![]
                    },
                    vec![notify.clone()]
                )
            )
            .is_err()
        );
        assert!(
            save(
                &db,
                &base(Trigger::Interval { minutes: 0 }, vec![notify.clone()])
            )
            .is_err()
        );
        assert!(save(&db, &base(Trigger::Manual, vec![])).is_err());
        assert!(
            save(
                &db,
                &base(
                    Trigger::Manual,
                    vec![Step::StartWorkspace { workspace_id: 42 }]
                )
            )
            .is_err()
        );
        assert!(
            save(
                &db,
                &base(
                    Trigger::Manual,
                    vec![Step::OpenUrl {
                        url: "javascript:alert(1)".into()
                    }]
                )
            )
            .is_err()
        );

        let id = save(
            &db,
            &base(
                Trigger::Daily {
                    time: "09:00".into(),
                    days: vec![0, 4],
                },
                vec![notify.clone(), Step::Wait { seconds: 5 }],
            ),
        )
        .unwrap();
        let a = get(&db, &rt, id).unwrap();
        assert_eq!(a.steps.len(), 2);
        assert_eq!(a.on_error, OnError::Continue);
        set_enabled(&db, id, false).unwrap();
        assert!(!get(&db, &rt, id).unwrap().enabled);
        delete(&db, &rt, id).unwrap();
        assert!(list(&db, &rt).unwrap().is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn history_pages_with_cursor() {
        let dir = std::env::temp_dir().join(format!("devcenter-hist-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = Database::open(&dir.join("t.db")).unwrap();
        db.with(|c| {
            // Deux exécutions par seconde : l'ordre secondaire par id doit tenir.
            for i in 0..45 {
                c.execute(
                    "INSERT INTO automation_runs (automation_id, automation_name, origin, started_at, status, log) VALUES (NULL, ?1, 'manual', ?2, 'success', '[]')",
                    params![format!("run {i}"), 1000 + i / 2],
                )?;
            }
            Ok(())
        })
        .unwrap();
        let mut seen = Vec::new();
        let mut cursor = None;
        loop {
            let page = history(&db, None, 20, cursor).unwrap();
            if page.is_empty() {
                break;
            }
            cursor = page.last().map(|r| r.id);
            seen.extend(page.into_iter().map(|r| r.id));
        }
        assert_eq!(seen.len(), 45);
        let mut sorted = seen.clone();
        sorted.sort_by(|a, b| b.cmp(a));
        assert_eq!(
            seen, sorted,
            "du plus récent au plus ancien, sans doublon ni trou"
        );
        std::fs::remove_dir_all(&dir).ok();
    }
}
