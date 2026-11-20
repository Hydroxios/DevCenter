//! Exécution des scripts de projet (`pnpm run dev`, …) avec logs en direct.
//!
//! Chaque exécution garde son PID ; l'arrêt tue tout l'arbre de processus (node lance des
//! sous-processus) et tous les scripts sont arrêtés à la fermeture de DevCenter : pas d'orphelins.

use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, Read};
use std::path::Path;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::error::{AppError, AppResult};
use crate::modules::shell;

const MAX_LOG_LINES: usize = 2000;
/// Les lignes de log sont envoyées à l'interface par lots, au plus une fois par intervalle :
/// un build bavard produit des centaines de lignes par seconde, un événement IPC par ligne
/// saturerait l'interface.
const LOG_FLUSH_EVERY: Duration = Duration::from_millis(50);
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
struct LogEvent {
    run_id: u64,
    lines: Vec<String>,
}

/// Lignes lues mais pas encore envoyées à l'interface, partagées par les lecteurs stdout/stderr.
struct LogBatch {
    lines: Mutex<Vec<String>>,
    /// Lecteurs encore ouverts : l'envoi s'arrête quand tous ont terminé.
    open_readers: AtomicUsize,
    /// Flux en direct (page mobile) : reçoivent chaque lot, fermés à la fin de l'exécution.
    subscribers: Mutex<Vec<mpsc::Sender<Vec<String>>>>,
}

struct Run {
    info: RunInfo,
    logs: VecDeque<String>,
    stop_requested: bool,
    /// URL détectée, statut pas encore envoyé à l'interface.
    url_pending: bool,
    /// Ouvre l'URL détectée dans le navigateur (démarrage de workspace).
    open_browser: bool,
    batch: Arc<LogBatch>,
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

struct ReaderDone(Arc<LogBatch>);

impl Drop for ReaderDone {
    fn drop(&mut self) {
        self.0.open_readers.fetch_sub(1, Ordering::SeqCst);
    }
}

/// Envoie les lignes en attente par lots, jusqu'à la fermeture des deux flux du processus.
fn spawn_log_flusher(app: AppHandle, runs: Arc<Mutex<HashMap<u64, Run>>>, id: u64, batch: Arc<LogBatch>) {
    std::thread::spawn(move || loop {
        std::thread::sleep(LOG_FLUSH_EVERY);
        // Lu avant de vider le tampon : une ligne poussée juste avant la fermeture n'est pas perdue.
        let done = batch.open_readers.load(Ordering::SeqCst) == 0;
        // Abonnés servis sous le verrou du tampon : `subscribe` voit donc chaque ligne soit dans
        // l'instantané, soit dans un lot, jamais les deux.
        let lines = {
            let Ok(mut pending) = batch.lines.lock() else { return };
            let lines = std::mem::take(&mut *pending);
            if let Ok(mut subs) = batch.subscribers.lock() {
                if !lines.is_empty() {
                    subs.retain(|s| s.send(lines.clone()).is_ok());
                }
                if done {
                    subs.clear(); // fin de l'exécution : les flux se ferment
                }
            }
            lines
        };
        if !lines.is_empty() {
            let _ = app.emit(EVENT_LOG, LogEvent { run_id: id, lines });
        }
        let url_info = runs.lock().ok().and_then(|mut runs| {
            let run = runs.get_mut(&id)?;
            std::mem::take(&mut run.url_pending).then(|| run.info.clone())
        });
        if let Some(info) = url_info {
            let _ = app.emit(EVENT_STATUS, &info);
        }
        if done {
            return;
        }
    });
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

    /// Abonnement au flux de logs d'une exécution : les `tail` dernières lignes déjà reçues, puis
    /// chaque nouveau lot via le canal (`None` si l'exécution est terminée : rien ne viendra plus).
    pub fn subscribe(&self, run_id: u64, tail: usize) -> AppResult<(Vec<String>, Option<mpsc::Receiver<Vec<String>>>)> {
        let runs = self.runs.lock()?;
        let run = runs.get(&run_id).ok_or_else(|| AppError::InvalidInput(format!("exécution {run_id} inconnue")))?;
        let pending = run.batch.lines.lock()?;
        let mut subs = run.batch.subscribers.lock()?;
        // Les lignes encore en attente partiront dans le prochain lot : exclues de l'instantané.
        let sent = run.logs.len().saturating_sub(pending.len());
        let snapshot: Vec<String> = run.logs.iter().take(sent).skip(sent.saturating_sub(tail)).cloned().collect();
        let live = run.batch.open_readers.load(Ordering::SeqCst) > 0 || !pending.is_empty();
        let rx = live.then(|| {
            let (tx, rx) = mpsc::channel();
            subs.push(tx);
            rx
        });
        Ok((snapshot, rx))
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

        let batch = Arc::new(LogBatch {
            lines: Mutex::new(Vec::new()),
            open_readers: AtomicUsize::new(0),
            subscribers: Mutex::new(Vec::new()),
        });
        // Retire les anciennes exécutions terminées du même script (garde l'historique court).
        {
            let mut runs = self.runs.lock()?;
            runs.retain(|_, r| {
                !(r.info.project_id == project_id && r.info.script == script && r.info.status != RunStatus::Running)
            });
            runs.insert(
                id,
                Run {
                    info: info.clone(),
                    logs: VecDeque::new(),
                    stop_requested: false,
                    url_pending: false,
                    open_browser,
                    batch: Arc::clone(&batch),
                },
            );
        }
        let _ = app.emit(EVENT_STATUS, &info);

        if let Some(out) = child.stdout.take() {
            self.spawn_reader(Arc::clone(&batch), id, out);
        }
        if let Some(err) = child.stderr.take() {
            self.spawn_reader(Arc::clone(&batch), id, err);
        }
        spawn_log_flusher(app.clone(), Arc::clone(&self.runs), id, batch);

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
                crate::modules::notify::dispatch(
                    &app,
                    crate::modules::notify::Event {
                        category: crate::modules::notify::Category::Script,
                        title: format!("Script arrêté · {}", info.script),
                        body: format!("Code de sortie {}", info.exit_code.map(|c| c.to_string()).unwrap_or_else(|| "?".into())),
                        tab: Some("scripts".into()),
                        tag: Some(format!("run-{}-{}", info.project_id, info.script)),
                        target: Some(crate::modules::notify::Target::Run { project_id: info.project_id, run_id: info.id }),
                        retry: Some(crate::modules::notify::Retry::Script { project_id: info.project_id, script: info.script.clone() }),
                    },
                );
            }
            let _ = app.emit(EVENT_STATUS, &info);
        });

        Ok(info)
    }

    fn spawn_reader(&self, batch: Arc<LogBatch>, id: u64, stream: impl Read + Send + 'static) {
        let runs = Arc::clone(&self.runs);
        batch.open_readers.fetch_add(1, Ordering::SeqCst);
        std::thread::spawn(move || {
            // Signale la fin du lecteur quelle que soit la sortie de la boucle.
            let _done = ReaderDone(Arc::clone(&batch));
            let mut reader = BufReader::new(stream);
            let mut buf = Vec::new();
            loop {
                buf.clear();
                match reader.read_until(b'\n', &mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {}
                }
                let line = shell::strip_ansi(String::from_utf8_lossy(&buf).trim_end_matches('\n'));
                {
                    let Ok(mut runs) = runs.lock() else { break };
                    let Some(run) = runs.get_mut(&id) else { break };
                    if run.info.url.is_none() {
                        if let Some(url) = detect_url(&line) {
                            if run.open_browser {
                                let _ = tauri_plugin_opener::open_url(&url, None::<&str>);
                            }
                            run.info.url = Some(url);
                            // Le statut (avec l'URL) part avec le prochain lot de logs.
                            run.url_pending = true;
                        }
                    }
                    if run.logs.len() >= MAX_LOG_LINES {
                        run.logs.pop_front();
                    }
                    run.logs.push_back(line.clone());
                    // Sous le verrou des exécutions : cohérent avec l'instantané de `subscribe`.
                    match batch.lines.lock() {
                        Ok(mut pending) => pending.push(line),
                        Err(_) => break,
                    }
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
