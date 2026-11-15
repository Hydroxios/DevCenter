//! Exécution des scripts de projet (`pnpm run dev`, …) avec logs en direct.
//!
//! Chaque exécution garde son PID ; l'arrêt tue tout l'arbre de processus (node lance des
//! sous-processus) et tous les scripts sont arrêtés à la fermeture de DevCenter : pas d'orphelins.

use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, Read};
use std::path::Path;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::error::{AppError, AppResult};
use crate::modules::shell;

const MAX_LOG_LINES: usize = 2000;
pub const EVENT_LOG: &str = "runner://log";
pub const EVENT_STATUS: &str = "runner://status";

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RunStatus {
    Running,
    Exited,
    Failed,
    Stopped,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunInfo {
    pub id: u64,
    pub project_id: i64,
    pub script: String,
    pub command: String,
    pub pid: u32,
    pub status: RunStatus,
    pub exit_code: Option<i32>,
    /// Première URL locale détectée dans les logs (serveur de développement).
    pub url: Option<String>,
    pub started_at: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LogEvent<'a> {
    run_id: u64,
    line: &'a str,
}

struct Run {
    info: RunInfo,
    logs: VecDeque<String>,
    stop_requested: bool,
    /// Ouvre l'URL détectée dans le navigateur (démarrage de workspace).
    open_browser: bool,
}

#[derive(Default)]
pub struct Runner {
    runs: Arc<Mutex<HashMap<u64, Run>>>,
    next_id: AtomicU64,
}

/// Cherche `http://localhost:PORT` ou `http://127.0.0.1:PORT` dans une ligne de log.
fn detect_url(line: &str) -> Option<String> {
    for prefix in ["http://localhost:", "http://127.0.0.1:", "https://localhost:"] {
        if let Some(start) = line.find(prefix) {
            let rest = &line[start..];
            let end = rest.find(|c: char| c.is_whitespace() || c == ')' || c == ',' || c == '"').unwrap_or(rest.len());
            let url = rest[..end].trim_end_matches(['.', '/']);
            if url.len() > prefix.len() {
                return Some(url.to_string());
            }
        }
    }
    None
}

impl Runner {
    pub fn list(&self) -> AppResult<Vec<RunInfo>> {
        let mut list: Vec<RunInfo> = self.runs.lock()?.values().map(|r| r.info.clone()).collect();
        list.sort_by_key(|r| std::cmp::Reverse(r.id));
        Ok(list)
    }

    pub fn logs(&self, run_id: u64) -> AppResult<Vec<String>> {
        let runs = self.runs.lock()?;
        let run = runs.get(&run_id).ok_or_else(|| AppError::InvalidInput(format!("exécution {run_id} inconnue")))?;
        Ok(run.logs.iter().cloned().collect())
    }

    pub fn start(
        &self,
        app: &AppHandle,
        project_id: i64,
        dir: &Path,
        package_manager: &str,
        script: &str,
        command: &str,
        open_browser: bool,
    ) -> AppResult<RunInfo> {
        // Gradle : la tâche est passée directement (`gradlew build`) ; npm & co : `pnpm run dev`.
        let (program, args, shown): (std::ffi::OsString, Vec<&str>, String) = if package_manager == "gradle" {
            let program = shell::gradle_program(dir)
                .ok_or_else(|| AppError::InvalidInput("Gradle introuvable : ni gradlew dans le projet, ni gradle dans le PATH".into()))?;
            (program.into_os_string(), vec![script, "--console=plain"], format!("gradle {script}"))
        } else {
            let program = shell::package_manager_program(package_manager).ok_or_else(|| {
                AppError::InvalidInput(format!("exécution de scripts non prise en charge pour {package_manager}"))
            })?;
            (program.into(), vec!["run", script], format!("{package_manager} run {script}  →  {command}"))
        };

        {
            let runs = self.runs.lock()?;
            if runs.values().any(|r| {
                r.info.project_id == project_id && r.info.script == script && r.info.status == RunStatus::Running
            }) {
                return Err(AppError::InvalidInput(format!("« {script} » tourne déjà pour ce projet")));
            }
        }

        let mut child = shell::command(&program)
            .args(&args)
            .current_dir(dir)
            .env("FORCE_COLOR", "0")
            .env("NO_COLOR", "1")
            .env("BROWSER", "none") // empêche certains outils d'ouvrir le navigateur tout seuls
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| AppError::InvalidInput(format!("impossible de lancer {} : {e}", program.to_string_lossy())))?;

        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        let info = RunInfo {
            id,
            project_id,
            script: script.to_string(),
            command: shown,
            pid: child.id(),
            status: RunStatus::Running,
            exit_code: None,
            url: None,
            started_at: SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0),
        };

        // Retire les anciennes exécutions terminées du même script (garde l'historique court).
        {
            let mut runs = self.runs.lock()?;
            runs.retain(|_, r| {
                !(r.info.project_id == project_id && r.info.script == script && r.info.status != RunStatus::Running)
            });
            runs.insert(id, Run { info: info.clone(), logs: VecDeque::new(), stop_requested: false, open_browser });
        }
        let _ = app.emit(EVENT_STATUS, &info);

        if let Some(out) = child.stdout.take() {
            self.spawn_reader(app.clone(), id, out);
        }
        if let Some(err) = child.stderr.take() {
            self.spawn_reader(app.clone(), id, err);
        }

        let runs = Arc::clone(&self.runs);
        let app = app.clone();
        std::thread::spawn(move || {
            let code = child.wait().ok().and_then(|s| s.code());
            let info = {
                let Ok(mut runs) = runs.lock() else { return };
                let Some(run) = runs.get_mut(&id) else { return };
                run.info.exit_code = code;
                run.info.status = if run.stop_requested {
                    RunStatus::Stopped
                } else if code == Some(0) {
                    RunStatus::Exited
                } else {
                    RunStatus::Failed
                };
                run.info.clone()
            };
            // Un script qui plante (sans avoir été arrêté) prévient les téléphones abonnés.
            if info.status == RunStatus::Failed {
                crate::modules::push::notify_all(
                    &app,
                    crate::modules::push::Notification {
                        title: format!("Script arrêté · {}", info.script),
                        body: format!("Code de sortie {}", info.exit_code.map(|c| c.to_string()).unwrap_or_else(|| "?".into())),
                        tab: Some("scripts".into()),
                        tag: Some(format!("run-{}-{}", info.project_id, info.script)),
                    },
                );
            }
            let _ = app.emit(EVENT_STATUS, &info);
        });

        Ok(info)
    }

    fn spawn_reader(&self, app: AppHandle, id: u64, stream: impl Read + Send + 'static) {
        let runs = Arc::clone(&self.runs);
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stream);
            let mut buf = Vec::new();
            loop {
                buf.clear();
                match reader.read_until(b'\n', &mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {}
                }
                let line = shell::strip_ansi(String::from_utf8_lossy(&buf).trim_end_matches('\n'));
                let mut url_found = None;
                {
                    let Ok(mut runs) = runs.lock() else { break };
                    let Some(run) = runs.get_mut(&id) else { break };
                    if run.info.url.is_none() {
                        if let Some(url) = detect_url(&line) {
                            if run.open_browser {
                                let _ = tauri_plugin_opener::open_url(&url, None::<&str>);
                            }
                            run.info.url = Some(url);
                            url_found = Some(run.info.clone());
                        }
                    }
                    if run.logs.len() >= MAX_LOG_LINES {
                        run.logs.pop_front();
                    }
                    run.logs.push_back(line.clone());
                }
                let _ = app.emit(EVENT_LOG, LogEvent { run_id: id, line: &line });
                if let Some(info) = url_found {
                    let _ = app.emit(EVENT_STATUS, &info);
                }
            }
        });
    }

    /// Arrête une exécution et tous ses sous-processus.
    pub fn stop(&self, run_id: u64) -> AppResult<()> {
        let pid = {
            let mut runs = self.runs.lock()?;
            let run = runs.get_mut(&run_id).ok_or_else(|| AppError::InvalidInput(format!("exécution {run_id} inconnue")))?;
            if run.info.status != RunStatus::Running {
                return Ok(());
            }
            run.stop_requested = true;
            run.info.pid
        };
        kill_tree(pid);
        Ok(())
    }

    /// Supprime une exécution terminée (et ses logs).
    pub fn dismiss(&self, run_id: u64) -> AppResult<()> {
        let mut runs = self.runs.lock()?;
        if runs.get(&run_id).is_some_and(|r| r.info.status != RunStatus::Running) {
            runs.remove(&run_id);
        }
        Ok(())
    }

    /// Appelé à la fermeture de l'application.
    pub fn stop_all(&self) {
        let pids: Vec<u32> = match self.runs.lock() {
            Ok(mut runs) => runs
                .values_mut()
                .filter(|r| r.info.status == RunStatus::Running)
                .map(|r| {
                    r.stop_requested = true;
                    r.info.pid
                })
                .collect(),
            Err(_) => return,
        };
        for pid in pids {
            kill_tree(pid);
        }
    }
}

pub fn kill_tree(pid: u32) {
    #[cfg(windows)]
    {
        let _ = shell::command("taskkill").args(["/PID", &pid.to_string(), "/T", "/F"]).output();
    }
    #[cfg(not(windows))]
    {
        let _ = shell::command("kill").args(["-TERM", &pid.to_string()]).output();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_dev_server_urls() {
        assert_eq!(detect_url("  ➜  Local:   http://localhost:5173/").as_deref(), Some("http://localhost:5173"));
        assert_eq!(detect_url("ready - started server on http://127.0.0.1:3000, url").as_deref(), Some("http://127.0.0.1:3000"));
        assert_eq!(detect_url("Listening (http://localhost:8080)").as_deref(), Some("http://localhost:8080"));
        assert_eq!(detect_url("compiled successfully"), None);
        assert_eq!(detect_url("see http://localhost: for help"), None);
    }
}
