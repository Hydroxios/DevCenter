//! Étapes d'un workflow : actions, attentes et conditions.

use std::net::{TcpStream, ToSocketAddrs};
use std::time::{Duration, Instant};

use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use tauri_plugin_notification::NotificationExt;

use crate::database::Database;
use crate::error::{AppError, AppResult};
use crate::modules::settings::SettingsService;
use crate::modules::{apps, editor, projects, servers, workspaces};
use crate::state::AppState;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Step {
    StartWorkspace {
        workspace_id: i64,
    },
    StopWorkspace {
        workspace_id: i64,
    },
    RunScript {
        project_id: i64,
        script: String,
        #[serde(default)]
        open_browser: bool,
    },
    StopScript {
        project_id: i64,
        script: String,
    },
    OpenEditor {
        project_id: i64,
    },
    OpenFolder {
        project_id: i64,
    },
    LaunchApp {
        app_id: i64,
    },
    OpenUrl {
        url: String,
    },
    Notify {
        title: String,
        #[serde(default)]
        body: String,
    },
    /// Pause (1 à 3600 s).
    Wait {
        seconds: u32,
    },
    /// Attend qu'un port TCP accepte les connexions (serveur de dev prêt, base de données…).
    WaitForPort {
        host: String,
        port: u16,
        timeout_secs: u32,
    },
    /// Requête HTTP (webhook, API, vérification d'état). Échoue si le code reçu n'est pas attendu.
    HttpRequest {
        method: HttpMethod,
        url: String,
        /// Un en-tête par ligne : `Nom: valeur`.
        #[serde(default)]
        headers: String,
        #[serde(default)]
        body: String,
        /// Codes acceptés, ex. « 200-299 », « 2xx » ou « 200,204 ». Vide = 2xx.
        #[serde(default)]
        expect_status: String,
        #[serde(default = "default_http_timeout")]
        timeout_secs: u32,
    },
    /// « Continuer seulement si… » : arrête proprement le workflow si la condition est fausse.
    Condition {
        condition: Condition,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Condition {
    ProcessRunning {
        name: String,
        #[serde(default)]
        negate: bool,
    },
    ServerReachable {
        server_id: i64,
        #[serde(default)]
        negate: bool,
    },
    WorkspaceActive {
        workspace_id: i64,
        #[serde(default)]
        negate: bool,
    },
    PortOpen {
        host: String,
        port: u16,
        #[serde(default)]
        negate: bool,
    },
    CpuAbove {
        percent: f32,
        #[serde(default)]
        negate: bool,
    },
    MemoryAbove {
        percent: f32,
        #[serde(default)]
        negate: bool,
    },
    /// Heure locale comprise entre `start` et `end` (« HH:MM », peut passer minuit).
    TimeBetween {
        start: String,
        end: String,
        #[serde(default)]
        negate: bool,
    },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "UPPERCASE")]
pub enum HttpMethod {
    Get,
    Post,
    Put,
    Patch,
    Delete,
    Head,
}

impl HttpMethod {
    fn as_str(self) -> &'static str {
        match self {
            Self::Get => "GET",
            Self::Post => "POST",
            Self::Put => "PUT",
            Self::Patch => "PATCH",
            Self::Delete => "DELETE",
            Self::Head => "HEAD",
        }
    }
}

fn default_http_timeout() -> u32 {
    30
}

pub enum Flow {
    Continue,
    /// Réussite avec un détail affiché dans l'historique.
    Done(String),
    Stop(String),
}

fn exists(db: &Database, table: &str, id: i64) -> AppResult<bool> {
    // `table` est une constante de ce module.
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

fn require(db: &Database, table: &str, id: i64, what: &str) -> AppResult<()> {
    if exists(db, table, id)? {
        Ok(())
    } else {
        Err(AppError::InvalidInput(format!("{what} {id} inconnu(e)")))
    }
}

fn validate_url(url: &str) -> AppResult<()> {
    let lower = url.trim().to_ascii_lowercase();
    if (lower.starts_with("http://") || lower.starts_with("https://"))
        && url.len() <= 2000
        && !url.contains(char::is_whitespace)
    {
        Ok(())
    } else {
        Err(AppError::InvalidInput(format!("URL invalide : {url}")))
    }
}

/// En-têtes `Nom: valeur` (un par ligne, lignes vides ignorées).
fn parse_headers(text: &str) -> AppResult<Vec<(String, String)>> {
    let mut out = Vec::new();
    for line in text.lines().map(str::trim).filter(|l| !l.is_empty()) {
        let (name, value) = line.split_once(':').ok_or_else(|| {
            AppError::InvalidInput(format!("en-tête invalide (Nom: valeur) : {line}"))
        })?;
        let name = name.trim();
        if name.is_empty()
            || !name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "-_".contains(c))
        {
            return Err(AppError::InvalidInput(format!("en-tête invalide : {line}")));
        }
        out.push((name.to_string(), value.trim().to_string()));
    }
    Ok(out)
}

/// Plages de codes acceptés : « 200-299 », « 200,204 », « 2xx ». Vide = 2xx.
fn parse_expect(spec: &str) -> AppResult<Vec<(u16, u16)>> {
    let spec = spec.trim();
    if spec.is_empty() {
        return Ok(vec![(200, 299)]);
    }
    let bad = || {
        AppError::InvalidInput(format!(
            "codes attendus invalides : {spec} (ex. 200-299 ou 200,204)"
        ))
    };
    spec.split(',')
        .map(|part| {
            let part = part.trim().to_ascii_lowercase();
            if let Some(d) = part.strip_suffix("xx") {
                let d: u16 = d.parse().map_err(|_| bad())?;
                return if (1..=5).contains(&d) {
                    Ok((d * 100, d * 100 + 99))
                } else {
                    Err(bad())
                };
            }
            let (a, b) = part.split_once('-').unwrap_or((&part, &part));
            let (a, b): (u16, u16) = (
                a.trim().parse().map_err(|_| bad())?,
                b.trim().parse().map_err(|_| bad())?,
            );
            if (100..=599).contains(&a) && (a..=599).contains(&b) {
                Ok((a, b))
            } else {
                Err(bad())
            }
        })
        .collect()
}

/// Exécute la requête via `curl.exe` (fourni avec Windows) ; retourne le code HTTP et le début de la réponse.
fn http_request(
    method: HttpMethod,
    url: &str,
    headers: &[(String, String)],
    body: &str,
    timeout_secs: u32,
) -> AppResult<(u16, String)> {
    use std::io::Write;
    use std::process::Stdio;

    let mut cmd = crate::modules::shell::command(if cfg!(windows) { "curl.exe" } else { "curl" });
    cmd.args([
        "-sS",
        "-L",
        "--max-redirs",
        "5",
        "--max-time",
        &timeout_secs.to_string(),
    ]);
    cmd.args(["-w", "\n%{http_code}", "-X", method.as_str()]);
    if method == HttpMethod::Head {
        cmd.arg("-I");
    }
    for (name, value) in headers {
        cmd.arg("-H").arg(format!("{name}: {value}"));
    }
    let has_body = !body.is_empty() && !matches!(method, HttpMethod::Get | HttpMethod::Head);
    if has_body {
        cmd.args(["--data-binary", "@-"]);
    }
    // `--` : l'URL ne peut pas être interprétée comme une option.
    cmd.arg("--").arg(url);
    let mut child = cmd
        .stdin(if has_body {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| AppError::InvalidInput(format!("curl indisponible : {e}")))?;
    if has_body {
        child
            .stdin
            .take()
            .expect("stdin")
            .write_all(body.as_bytes())?;
    }
    let out = child.wait_with_output()?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    let (response, code) = stdout.rsplit_once('\n').unwrap_or(("", &stdout));
    let code: u16 = code.trim().parse().unwrap_or(0);
    if code == 0 {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(AppError::InvalidInput(format!(
            "requête impossible : {}",
            err.trim().trim_start_matches("curl: ")
        )));
    }
    let snippet: String = response
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(200)
        .collect();
    Ok((code, snippet))
}

fn validate_host(host: &str) -> AppResult<()> {
    let ok = !host.is_empty()
        && host.len() <= 253
        && host
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || ".-_:[]".contains(c));
    if ok {
        Ok(())
    } else {
        Err(AppError::InvalidInput(format!("hôte invalide : {host}")))
    }
}

pub fn validate(db: &Database, step: &Step) -> AppResult<()> {
    match step {
        Step::StartWorkspace { workspace_id } | Step::StopWorkspace { workspace_id } => {
            require(db, "workspaces", *workspace_id, "workspace")
        }
        Step::RunScript {
            project_id, script, ..
        }
        | Step::StopScript { project_id, script } => {
            if script.trim().is_empty() {
                return Err(AppError::InvalidInput("script manquant".into()));
            }
            require(db, "projects", *project_id, "projet")
        }
        Step::OpenEditor { project_id } | Step::OpenFolder { project_id } => {
            require(db, "projects", *project_id, "projet")
        }
        Step::LaunchApp { app_id } => require(db, "app_shortcuts", *app_id, "application"),
        Step::OpenUrl { url } => validate_url(url),
        Step::Notify { title, body } => {
            if title.trim().is_empty() || title.len() > 120 || body.len() > 500 {
                Err(AppError::InvalidInput(
                    "notification : titre de 1 à 120 caractères, texte de 500 maximum".into(),
                ))
            } else {
                Ok(())
            }
        }
        Step::Wait { seconds } => {
            if (1..=3600).contains(seconds) {
                Ok(())
            } else {
                Err(AppError::InvalidInput(
                    "pause entre 1 et 3600 secondes".into(),
                ))
            }
        }
        Step::WaitForPort {
            host,
            port,
            timeout_secs,
        } => {
            validate_host(host)?;
            if *port == 0 || !(1..=3600).contains(timeout_secs) {
                return Err(AppError::InvalidInput("port ou délai invalide".into()));
            }
            Ok(())
        }
        Step::HttpRequest {
            url,
            headers,
            body,
            expect_status,
            timeout_secs,
            ..
        } => {
            validate_url(url)?;
            parse_headers(headers)?;
            parse_expect(expect_status)?;
            if body.len() > 100_000 {
                return Err(AppError::InvalidInput(
                    "corps de requête trop long (100 Ko maximum)".into(),
                ));
            }
            if !(1..=300).contains(timeout_secs) {
                return Err(AppError::InvalidInput(
                    "délai de requête entre 1 et 300 secondes".into(),
                ));
            }
            Ok(())
        }
        Step::Condition { condition } => match condition {
            Condition::ProcessRunning { name, .. } => {
                if name.trim().is_empty() || name.len() > 260 {
                    Err(AppError::InvalidInput("nom de processus invalide".into()))
                } else {
                    Ok(())
                }
            }
            Condition::ServerReachable { server_id, .. } => {
                require(db, "servers", *server_id, "serveur")
            }
            Condition::WorkspaceActive { workspace_id, .. } => {
                require(db, "workspaces", *workspace_id, "workspace")
            }
            Condition::PortOpen { host, port, .. } => {
                validate_host(host)?;
                if *port == 0 {
                    Err(AppError::InvalidInput("port invalide".into()))
                } else {
                    Ok(())
                }
            }
            Condition::CpuAbove { percent, .. } | Condition::MemoryAbove { percent, .. } => {
                if (0.0..=100.0).contains(percent) {
                    Ok(())
                } else {
                    Err(AppError::InvalidInput("pourcentage entre 0 et 100".into()))
                }
            }
            Condition::TimeBetween { start, end, .. } => {
                if super::parse_hhmm(start).is_some() && super::parse_hhmm(end).is_some() {
                    Ok(())
                } else {
                    Err(AppError::InvalidInput("heures invalides (HH:MM)".into()))
                }
            }
        },
    }
}

fn name_of(db: &Database, table: &str, id: i64) -> String {
    db.with(|conn| {
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
    .unwrap_or_else(|| format!("#{id} (supprimé)"))
}

pub fn label(app: &AppHandle, step: &Step) -> String {
    let db = &app.state::<AppState>().db;
    let neg = |n: bool| if n { "pas " } else { "" };
    match step {
        Step::StartWorkspace { workspace_id } => format!(
            "Démarrer le workspace {}",
            name_of(db, "workspaces", *workspace_id)
        ),
        Step::StopWorkspace { workspace_id } => format!(
            "Arrêter le workspace {}",
            name_of(db, "workspaces", *workspace_id)
        ),
        Step::RunScript {
            project_id, script, ..
        } => format!("Lancer {} › {script}", name_of(db, "projects", *project_id)),
        Step::StopScript { project_id, script } => format!(
            "Arrêter {} › {script}",
            name_of(db, "projects", *project_id)
        ),
        Step::OpenEditor { project_id } => format!(
            "Ouvrir {} dans l'éditeur",
            name_of(db, "projects", *project_id)
        ),
        Step::OpenFolder { project_id } => format!(
            "Ouvrir le dossier de {}",
            name_of(db, "projects", *project_id)
        ),
        Step::LaunchApp { app_id } => format!("Lancer {}", name_of(db, "app_shortcuts", *app_id)),
        Step::OpenUrl { url } => format!("Ouvrir {url}"),
        Step::Notify { title, .. } => format!("Notifier « {title} »"),
        Step::Wait { seconds } => format!("Attendre {seconds} s"),
        Step::WaitForPort { host, port, .. } => format!("Attendre {host}:{port}"),
        Step::HttpRequest { method, url, .. } => format!("{} {url}", method.as_str()),
        Step::Condition { condition } => format!(
            "Si {}",
            match condition {
                Condition::ProcessRunning { name, negate } =>
                    format!("{name} {}lancé", neg(*negate)),
                Condition::ServerReachable { server_id, negate } => format!(
                    "{} {}joignable",
                    name_of(db, "servers", *server_id),
                    neg(*negate)
                ),
                Condition::WorkspaceActive {
                    workspace_id,
                    negate,
                } => format!(
                    "{} {}actif",
                    name_of(db, "workspaces", *workspace_id),
                    neg(*negate)
                ),
                Condition::PortOpen { host, port, negate } =>
                    format!("{host}:{port} {}ouvert", neg(*negate)),
                Condition::CpuAbove { percent, negate } =>
                    format!("CPU {} {percent:.0} %", if *negate { "≤" } else { ">" }),
                Condition::MemoryAbove { percent, negate } =>
                    format!("RAM {} {percent:.0} %", if *negate { "≤" } else { ">" }),
                Condition::TimeBetween { start, end, negate } => format!(
                    "heure {}entre {start} et {end}",
                    if *negate { "hors " } else { "" }
                )
                .replace("hors entre", "hors de"),
            }
        ),
    }
}

fn port_open(host: &str, port: u16, timeout: Duration) -> bool {
    let Ok(addrs) = (host, port).to_socket_addrs() else {
        return false;
    };
    addrs
        .into_iter()
        .any(|a| TcpStream::connect_timeout(&a, timeout).is_ok())
}

fn time_between(start: &str, end: &str) -> bool {
    use chrono::Timelike;
    let (Some((sh, sm)), Some((eh, em))) = (super::parse_hhmm(start), super::parse_hhmm(end))
    else {
        return false;
    };
    let now = chrono::Local::now();
    let t = now.hour() * 60 + now.minute();
    let (s, e) = (sh * 60 + sm, eh * 60 + em);
    if s <= e {
        t >= s && t < e
    } else {
        t >= s || t < e
    } // plage passant minuit
}

fn evaluate(app: &AppHandle, c: &Condition) -> AppResult<(bool, bool)> {
    let state = app.state::<AppState>();
    Ok(match c {
        Condition::ProcessRunning { name, negate } => {
            let target = name.trim().to_lowercase();
            let target_exe = if target.ends_with(".exe") {
                target.clone()
            } else {
                format!("{target}.exe")
            };
            let found = state.system.processes(None, None)?.iter().any(|p| {
                let n = p.name.to_lowercase();
                n == target || n == target_exe
            });
            (found, *negate)
        }
        Condition::ServerReachable { server_id, negate } => {
            let server = servers::get(&state.db, *server_id)?;
            (servers::remote::ping(&server).is_ok(), *negate)
        }
        Condition::WorkspaceActive {
            workspace_id,
            negate,
        } => {
            let active = workspaces::list(&state.db, &state.workspaces)?
                .iter()
                .any(|w| w.id == *workspace_id && w.active.is_some());
            (active, *negate)
        }
        Condition::PortOpen { host, port, negate } => {
            (port_open(host, *port, Duration::from_secs(2)), *negate)
        }
        Condition::CpuAbove { percent, negate } => {
            // Deux mesures espacées pour une valeur CPU significative.
            state.system.snapshot()?;
            std::thread::sleep(Duration::from_millis(500));
            (state.system.snapshot()?.cpu_usage > *percent, *negate)
        }
        Condition::MemoryAbove { percent, negate } => {
            let s = state.system.snapshot()?;
            let used = if s.memory_total > 0 {
                s.memory_used as f32 * 100.0 / s.memory_total as f32
            } else {
                0.0
            };
            (used > *percent, *negate)
        }
        Condition::TimeBetween { start, end, negate } => (time_between(start, end), *negate),
    })
}

pub fn run(app: &AppHandle, step: &Step, deadline: Instant) -> AppResult<Flow> {
    let state = app.state::<AppState>();
    let db = &state.db;
    match step {
        Step::StartWorkspace { workspace_id } => {
            let already = workspaces::list(db, &state.workspaces)?
                .iter()
                .any(|w| w.id == *workspace_id && w.active.is_some());
            if !already {
                let info = workspaces::start(app, &state, *workspace_id)?;
                if let Some(f) = info.results.iter().find(|r| !r.ok) {
                    return Err(AppError::InvalidInput(format!(
                        "{} : {}",
                        f.label,
                        f.message.clone().unwrap_or_default()
                    )));
                }
            }
        }
        Step::StopWorkspace { workspace_id } => {
            let active = workspaces::list(db, &state.workspaces)?
                .iter()
                .any(|w| w.id == *workspace_id && w.active.is_some());
            if active {
                workspaces::stop(app, &state, *workspace_id)?;
            }
        }
        Step::RunScript {
            project_id,
            script,
            open_browser,
        } => {
            let already = state.runner.list()?.iter().any(|r| {
                r.project_id == *project_id
                    && &r.script == script
                    && r.status == crate::modules::runner::RunStatus::Running
            });
            if !already {
                let path = projects::path_of(db, *project_id)?;
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
                state.runner.start(
                    app,
                    *project_id,
                    &path,
                    pm,
                    &declared.name,
                    &declared.command,
                    *open_browser,
                )?;
            }
        }
        Step::StopScript { project_id, script } => {
            for r in state.runner.list()? {
                if r.project_id == *project_id
                    && &r.script == script
                    && r.status == crate::modules::runner::RunStatus::Running
                {
                    state.runner.stop(r.id)?;
                }
            }
        }
        Step::OpenEditor { project_id } => {
            let path = projects::path_of(db, *project_id)?;
            editor::open(SettingsService::load(db)?.editor_path.as_deref(), &path)?;
        }
        Step::OpenFolder { project_id } => {
            let path = projects::path_of(db, *project_id)?;
            tauri_plugin_opener::open_path(&path, None::<&str>)
                .map_err(|e| AppError::InvalidInput(e.to_string()))?;
        }
        Step::LaunchApp { app_id } => {
            apps::launch(&apps::resolve(db, *app_id)?)?;
        }
        Step::OpenUrl { url } => {
            validate_url(url)?;
            tauri_plugin_opener::open_url(url, None::<&str>)
                .map_err(|e| AppError::InvalidInput(e.to_string()))?;
        }
        Step::Notify { title, body } => {
            app.notification()
                .builder()
                .title(title)
                .body(body)
                .show()
                .map_err(|e| AppError::InvalidInput(format!("notification : {e}")))?;
            // Aussi sur les téléphones appairés qui ont activé les notifications.
            crate::modules::push::notify_all(
                app,
                crate::modules::push::Notification {
                    title: title.clone(),
                    body: body.clone(),
                    tab: Some("auto".into()),
                    tag: None,
                },
            );
        }
        Step::Wait { seconds } => {
            let end = Instant::now() + Duration::from_secs(*seconds as u64);
            while Instant::now() < end {
                if Instant::now() >= deadline {
                    return Err(AppError::InvalidInput(
                        "délai maximum atteint pendant la pause".into(),
                    ));
                }
                std::thread::sleep(Duration::from_millis(250));
            }
        }
        Step::WaitForPort {
            host,
            port,
            timeout_secs,
        } => {
            let end = Instant::now() + Duration::from_secs(*timeout_secs as u64);
            loop {
                if port_open(host, *port, Duration::from_millis(800)) {
                    break;
                }
                if Instant::now() >= end || Instant::now() >= deadline {
                    return Err(AppError::InvalidInput(format!(
                        "{host}:{port} n'a pas répondu en {timeout_secs} s"
                    )));
                }
                std::thread::sleep(Duration::from_millis(700));
            }
        }
        Step::HttpRequest {
            method,
            url,
            headers,
            body,
            expect_status,
            timeout_secs,
        } => {
            validate_url(url)?;
            let headers = parse_headers(headers)?;
            let expected = parse_expect(expect_status)?;
            let remaining = deadline
                .saturating_duration_since(Instant::now())
                .as_secs()
                .max(1) as u32;
            let (code, snippet) =
                http_request(*method, url, &headers, body, (*timeout_secs).min(remaining))?;
            let detail = if snippet.is_empty() {
                format!("HTTP {code}")
            } else {
                format!("HTTP {code} · {snippet}")
            };
            if !expected.iter().any(|(a, b)| (*a..=*b).contains(&code)) {
                return Err(AppError::InvalidInput(format!("code inattendu : {detail}")));
            }
            return Ok(Flow::Done(detail));
        }
        Step::Condition { condition } => {
            let (value, negate) = evaluate(app, condition)?;
            if value == negate {
                return Ok(Flow::Stop(
                    "condition non remplie : arrêt du workflow".into(),
                ));
            }
        }
    }
    Ok(Flow::Continue)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn port_check_and_time_window() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        assert!(port_open("127.0.0.1", port, Duration::from_millis(500)));
        drop(listener);
        assert!(time_between("00:00", "23:59") || time_between("23:59", "00:00"));
    }

    #[test]
    fn parses_headers_and_expected_codes() {
        assert_eq!(
            parse_headers("Content-Type: application/json\n\nX-Token:  abc ")
                .unwrap()
                .len(),
            2
        );
        assert!(parse_headers("pas d'en-tête").is_err());
        assert!(parse_headers("Mauvais Nom: x").is_err());
        assert_eq!(parse_expect("").unwrap(), vec![(200, 299)]);
        assert_eq!(
            parse_expect("2xx, 404").unwrap(),
            vec![(200, 299), (404, 404)]
        );
        assert_eq!(parse_expect("200-204").unwrap(), vec![(200, 204)]);
        assert!(parse_expect("abc").is_err());
        assert!(parse_expect("300-200").is_err());
    }

    /// Requête réelle vers un mini-serveur local : méthode, en-tête et corps transmis, code lu.
    #[test]
    fn sends_http_request_with_curl() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (mut sock, _) = listener.accept().unwrap();
            let mut buf = vec![0u8; 4096];
            let mut req = Vec::new();
            loop {
                let n = sock.read(&mut buf).unwrap();
                req.extend_from_slice(&buf[..n]);
                if n == 0 || String::from_utf8_lossy(&req).ends_with("{\"a\":1}") {
                    break;
                }
            }
            sock.write_all(
                b"HTTP/1.1 201 Created\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok",
            )
            .unwrap();
            String::from_utf8_lossy(&req).into_owned()
        });
        let headers = parse_headers("X-Test: oui").unwrap();
        let url = format!("http://127.0.0.1:{port}/hook");
        let (code, snippet) =
            http_request(HttpMethod::Post, &url, &headers, "{\"a\":1}", 10).unwrap();
        let req = server.join().unwrap();
        assert_eq!(code, 201);
        assert_eq!(snippet, "ok");
        assert!(req.starts_with("POST /hook"));
        assert!(req.to_ascii_lowercase().contains("x-test: oui"));
    }
}
