//! Tunnels SSH : redirections de ports (`-L` local, `-R` distant, `-D` SOCKS) par serveur.
//!
//! Chaque tunnel actif est un processus `ssh -N` du client OpenSSH (authentification par clé,
//! `BatchMode=yes`), surveillé par un fil dédié : statut en direct, message d'erreur lisible,
//! reconnexion automatique optionnelle avec délai croissant. Tous les tunnels sont fermés à
//! l'arrêt de DevCenter.

use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader};
use std::process::{Child, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::database::Database;
use crate::error::{AppError, AppResult};
use crate::modules::shell;

use super::{Server, ssh};

pub const EVENT_STATUS: &str = "tunnel://status";
const MAX_PER_SERVER: usize = 50;
/// Sans signe d'authentification réussie, un tunnel toujours vivant après ce délai est considéré actif.
const READY_FALLBACK: Duration = Duration::from_secs(ssh::CONNECT_TIMEOUT_SECS as u64 + 4);
/// Après l'authentification, délai laissé à `ExitOnForwardFailure` pour refuser la redirection.
const READY_GRACE: Duration = Duration::from_millis(1200);
const MAX_BACKOFF_SECS: u64 = 60;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TunnelKind {
    /// `-L` : un port de ce PC mène à une adresse vue depuis le serveur.
    Local,
    /// `-R` : un port du serveur mène à une adresse vue depuis ce PC.
    Remote,
    /// `-D` : proxy SOCKS local qui sort par le serveur.
    Dynamic,
}

impl TunnelKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Local => "local",
            Self::Remote => "remote",
            Self::Dynamic => "dynamic",
        }
    }
    fn parse(s: &str) -> Self {
        match s {
            "remote" => Self::Remote,
            "dynamic" => Self::Dynamic,
            _ => Self::Local,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TunnelState {
    Stopped,
    Starting,
    Running,
    /// En échec, nouvelle tentative programmée (reconnexion automatique).
    Retrying,
    Error,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelStatus {
    pub state: TunnelState,
    /// Erreur (stderr de ssh, traduit) ou délai avant la prochaine tentative.
    pub message: Option<String>,
    /// Horodatage (s) du dernier changement d'état.
    pub since: i64,
    pub restarts: u32,
}

impl TunnelStatus {
    fn stopped() -> Self {
        Self {
            state: TunnelState::Stopped,
            message: None,
            since: now(),
            restarts: 0,
        }
    }
    pub fn is_active(&self) -> bool {
        matches!(
            self.state,
            TunnelState::Starting | TunnelState::Running | TunnelState::Retrying
        )
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tunnel {
    pub id: i64,
    pub server_id: i64,
    pub server_name: String,
    pub name: String,
    pub kind: TunnelKind,
    /// Adresse de ce PC (écoute pour `-L`/`-D`, destination pour `-R`).
    pub bind_address: String,
    pub local_port: u16,
    /// Adresse côté serveur (destination pour `-L`, écoute pour `-R`) ; absente pour `-D`.
    pub remote_host: Option<String>,
    pub remote_port: Option<u16>,
    pub auto_start: bool,
    pub auto_restart: bool,
    pub status: TunnelStatus,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelInput {
    pub id: Option<i64>,
    pub server_id: i64,
    pub name: String,
    pub kind: TunnelKind,
    pub bind_address: Option<String>,
    pub local_port: u16,
    pub remote_host: Option<String>,
    pub remote_port: Option<u16>,
    #[serde(default)]
    pub auto_start: bool,
    #[serde(default)]
    pub auto_restart: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct StatusEvent {
    id: i64,
    status: TunnelStatus,
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

// ------------------------------------------------------------------ Validation

/// Nom d'hôte ou IP passé dans une spécification `-L`/`-R`/`-D` : jamais d'option déguisée
/// (« -oProxyCommand=… »), IPv6 uniquement entre crochets (le « : » sépare les champs).
pub fn validate_host(host: &str, what: &str) -> AppResult<()> {
    let inner = host.strip_prefix('[').and_then(|h| h.strip_suffix(']'));
    let ok = !host.is_empty()
        && host.len() <= 253
        && !host.starts_with('-')
        && match inner {
            Some(v6) => {
                !v6.is_empty()
                    && v6
                        .chars()
                        .all(|c| c.is_ascii_hexdigit() || c == ':' || c == '.')
            }
            None => host
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || ".-_".contains(c)),
        };
    if ok {
        Ok(())
    } else {
        Err(AppError::InvalidInput(format!(
            "{what} invalide : {host} (nom d'hôte, IPv4 ou [IPv6])"
        )))
    }
}

struct Clean {
    name: String,
    bind: String,
    remote_host: Option<String>,
    remote_port: Option<u16>,
}

fn validate(input: &TunnelInput) -> AppResult<Clean> {
    let name = input.name.trim().to_string();
    if name.is_empty() || name.len() > 80 {
        return Err(AppError::InvalidInput(
            "le nom doit faire entre 1 et 80 caractères".into(),
        ));
    }
    let bind = input
        .bind_address
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("127.0.0.1")
        .to_string();
    validate_host(&bind, "adresse locale")?;
    if input.local_port == 0 {
        return Err(AppError::InvalidInput(
            "port local invalide (1 à 65535)".into(),
        ));
    }
    let (remote_host, remote_port) = match input.kind {
        TunnelKind::Dynamic => (None, None),
        kind => {
            let default_host = "localhost";
            let host = input
                .remote_host
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or(default_host)
                .to_string();
            validate_host(
                &host,
                if kind == TunnelKind::Local {
                    "hôte de destination"
                } else {
                    "adresse d'écoute du serveur"
                },
            )?;
            let port = input.remote_port.filter(|p| *p != 0).ok_or_else(|| {
                AppError::InvalidInput("port distant invalide (1 à 65535)".into())
            })?;
            (Some(host), Some(port))
        }
    };
    Ok(Clean {
        name,
        bind,
        remote_host,
        remote_port,
    })
}

// ------------------------------------------------------------------ Stockage

const COLUMNS: &str = "t.id, t.server_id, s.name, t.name, t.kind, t.bind_address, t.local_port, t.remote_host, t.remote_port, t.auto_start, t.auto_restart";

fn row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Tunnel> {
    Ok(Tunnel {
        id: r.get(0)?,
        server_id: r.get(1)?,
        server_name: r.get(2)?,
        name: r.get(3)?,
        kind: TunnelKind::parse(&r.get::<_, String>(4)?),
        bind_address: r.get(5)?,
        local_port: r.get::<_, i64>(6)? as u16,
        remote_host: r.get(7)?,
        remote_port: r.get::<_, Option<i64>>(8)?.map(|p| p as u16),
        auto_start: r.get::<_, i64>(9)? != 0,
        auto_restart: r.get::<_, i64>(10)? != 0,
        status: TunnelStatus::stopped(),
    })
}

/// Tunnels (d'un serveur ou de tous), avec leur statut en direct.
pub fn list(
    db: &Database,
    runtime: &TunnelRuntime,
    server_id: Option<i64>,
) -> AppResult<Vec<Tunnel>> {
    let mut list: Vec<Tunnel> = db.with(|conn| {
        let mut stmt = conn.prepare(&format!(
            "SELECT {COLUMNS} FROM ssh_tunnels t JOIN servers s ON s.id = t.server_id
             WHERE ?1 IS NULL OR t.server_id = ?1 ORDER BY s.name COLLATE NOCASE, t.name COLLATE NOCASE"
        ))?;
        let rows = stmt.query_map(params![server_id], row)?;
        Ok(rows.collect::<Result<_, _>>()?)
    })?;
    let live = runtime.live.lock()?;
    for t in &mut list {
        if let Some(l) = live.get(&t.id) {
            t.status = l.status.clone();
        }
    }
    Ok(list)
}

pub fn get(db: &Database, id: i64) -> AppResult<Tunnel> {
    db.with(|conn| {
        Ok(conn
            .query_row(&format!("SELECT {COLUMNS} FROM ssh_tunnels t JOIN servers s ON s.id = t.server_id WHERE t.id = ?1"), params![id], row)
            .optional()?)
    })?
    .ok_or_else(|| AppError::InvalidInput(format!("tunnel {id} inconnu")))
}

/// Enregistre un tunnel ; retourne son identifiant. Un tunnel actif modifié est relancé.
pub fn save(
    app: &AppHandle,
    db: &Database,
    runtime: &TunnelRuntime,
    input: &TunnelInput,
) -> AppResult<i64> {
    let c = validate(input)?;
    super::get(db, input.server_id)?;
    let id = db.with(|conn| {
        match input.id {
            Some(id) => {
                let n = conn.execute(
                    "UPDATE ssh_tunnels SET server_id = ?1, name = ?2, kind = ?3, bind_address = ?4, local_port = ?5,
                     remote_host = ?6, remote_port = ?7, auto_start = ?8, auto_restart = ?9 WHERE id = ?10",
                    params![input.server_id, c.name, input.kind.as_str(), c.bind, input.local_port, c.remote_host, c.remote_port, input.auto_start as i64, input.auto_restart as i64, id],
                )?;
                if n == 0 {
                    return Err(AppError::InvalidInput(format!("tunnel {id} inconnu")));
                }
                Ok(id)
            }
            None => {
                let count: i64 = conn.query_row("SELECT COUNT(*) FROM ssh_tunnels WHERE server_id = ?1", params![input.server_id], |r| r.get(0))?;
                if count as usize >= MAX_PER_SERVER {
                    return Err(AppError::InvalidInput(format!("{MAX_PER_SERVER} tunnels maximum par serveur")));
                }
                conn.execute(
                    "INSERT INTO ssh_tunnels (server_id, name, kind, bind_address, local_port, remote_host, remote_port, auto_start, auto_restart)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                    params![input.server_id, c.name, input.kind.as_str(), c.bind, input.local_port, c.remote_host, c.remote_port, input.auto_start as i64, input.auto_restart as i64],
                )?;
                Ok(conn.last_insert_rowid())
            }
        }
    })?;
    if input.id.is_some() && runtime.is_active(id) {
        runtime.stop(app, id)?;
        runtime.start(app, db, id)?;
    }
    Ok(id)
}

pub fn delete(app: &AppHandle, db: &Database, runtime: &TunnelRuntime, id: i64) -> AppResult<()> {
    runtime.stop(app, id)?;
    runtime.live.lock()?.remove(&id);
    db.with(|conn| {
        conn.execute("DELETE FROM ssh_tunnels WHERE id = ?1", params![id])?;
        Ok(())
    })
}

/// Avant la suppression d'un serveur : ferme ses tunnels (les lignes partent en cascade).
pub fn stop_for_server(
    app: &AppHandle,
    db: &Database,
    runtime: &TunnelRuntime,
    server_id: i64,
) -> AppResult<()> {
    for t in list(db, runtime, Some(server_id))? {
        runtime.stop(app, t.id)?;
        runtime.live.lock()?.remove(&t.id);
    }
    Ok(())
}

// ------------------------------------------------------------------ Processus

/// Arguments de `ssh` pour un tunnel. Les options passées en premier l'emportent sur celles de
/// `base_args` et de `~/.ssh/config`.
pub fn ssh_args(server: &Server, t: &Tunnel) -> Vec<String> {
    let mut args: Vec<String> = vec!["-N".into()];
    for opt in [
        "BatchMode=yes",
        "ExitOnForwardFailure=yes",
        "ServerAliveInterval=30",
        "ServerAliveCountMax=3",
        // Affiche « Authenticated to … » : permet de savoir quand le tunnel est réellement ouvert.
        "LogLevel=VERBOSE",
    ] {
        args.extend(["-o".into(), opt.into()]);
    }
    let remote = || {
        format!(
            "{}:{}",
            t.remote_host.as_deref().unwrap_or("localhost"),
            t.remote_port.unwrap_or(0)
        )
    };
    match t.kind {
        TunnelKind::Local => args.extend([
            "-L".into(),
            format!("{}:{}:{}", t.bind_address, t.local_port, remote()),
        ]),
        TunnelKind::Remote => args.extend([
            "-R".into(),
            format!("{}:{}:{}", remote(), t.bind_address, t.local_port),
        ]),
        TunnelKind::Dynamic => {
            args.extend(["-D".into(), format!("{}:{}", t.bind_address, t.local_port)])
        }
    }
    args.extend(ssh::base_args(server, true));
    args
}

/// Traduit la sortie d'erreur de ssh pour un tunnel.
fn explain(stderr: &str, code: Option<i32>, t: &Tunnel) -> String {
    let lower = stderr.to_lowercase();
    if lower.contains("address already in use")
        || lower.contains("cannot listen to port")
        || lower.contains("could not request local forwarding")
    {
        format!(
            "le port local {} est déjà utilisé (ou interdit) sur ce PC",
            t.local_port
        )
    } else if lower.contains("remote port forwarding failed") {
        format!(
            "le serveur a refusé d'écouter sur le port {} (déjà utilisé, port < 1024 ou AllowTcpForwarding/GatewayPorts désactivé)",
            t.remote_port.unwrap_or(0)
        )
    } else if stderr.is_empty() {
        format!(
            "ssh s'est arrêté (code {})",
            code.map(|c| c.to_string()).unwrap_or_else(|| "?".into())
        )
    } else {
        ssh::explain(stderr, code)
    }
}

/// Lignes de diagnostic sans intérêt pour l'utilisateur.
fn is_noise(line: &str) -> bool {
    let l = line.trim();
    l.is_empty()
        || l.starts_with("debug")
        || l.starts_with("Warning: Permanently added")
        || l.starts_with("Authenticated to")
        || l.starts_with("Authentication succeeded")
        || l.starts_with("Transferred:")
}

struct Live {
    generation: u64,
    status: TunnelStatus,
    stop: Arc<AtomicBool>,
    child: Arc<Mutex<Option<Child>>>,
}

#[derive(Default)]
pub struct TunnelRuntime {
    live: Arc<Mutex<HashMap<i64, Live>>>,
    next_generation: AtomicU64,
}

/// Met à jour le statut (si la génération est toujours la bonne) et prévient l'interface.
fn set_status(
    app: &AppHandle,
    live: &Mutex<HashMap<i64, Live>>,
    id: i64,
    generation: u64,
    f: impl FnOnce(&mut TunnelStatus),
) {
    let status = {
        let Ok(mut live) = live.lock() else { return };
        let Some(entry) = live.get_mut(&id).filter(|e| e.generation == generation) else {
            return;
        };
        f(&mut entry.status);
        entry.status.since = now();
        entry.status.clone()
    };
    let _ = app.emit(EVENT_STATUS, StatusEvent { id, status });
}

impl TunnelRuntime {
    pub fn status(&self, id: i64) -> TunnelStatus {
        self.live
            .lock()
            .ok()
            .and_then(|l| l.get(&id).map(|e| e.status.clone()))
            .unwrap_or_else(TunnelStatus::stopped)
    }

    pub fn is_active(&self, id: i64) -> bool {
        self.status(id).is_active()
    }

    /// Ouvre le tunnel (sans effet s'il est déjà actif). Le statut arrive ensuite par événement.
    pub fn start(&self, app: &AppHandle, db: &Database, id: i64) -> AppResult<TunnelStatus> {
        let tunnel = get(db, id)?;
        // Valeurs relues de la base (import, ancienne version) : revalidées avant d'atteindre ssh.
        validate(&TunnelInput {
            id: Some(id),
            server_id: tunnel.server_id,
            name: tunnel.name.clone(),
            kind: tunnel.kind,
            bind_address: Some(tunnel.bind_address.clone()),
            local_port: tunnel.local_port,
            remote_host: tunnel.remote_host.clone(),
            remote_port: tunnel.remote_port,
            auto_start: tunnel.auto_start,
            auto_restart: tunnel.auto_restart,
        })?;
        let server = super::get(db, tunnel.server_id)?;

        let mut live = self.live.lock()?;
        if let Some(entry) = live.get(&id)
            && entry.status.is_active()
        {
            return Ok(entry.status.clone());
        }
        let generation = self.next_generation.fetch_add(1, Ordering::Relaxed) + 1;
        let stop = Arc::new(AtomicBool::new(false));
        let child = Arc::new(Mutex::new(None));
        let status = TunnelStatus {
            state: TunnelState::Starting,
            message: None,
            since: now(),
            restarts: 0,
        };
        live.insert(
            id,
            Live {
                generation,
                status: status.clone(),
                stop: Arc::clone(&stop),
                child: Arc::clone(&child),
            },
        );
        drop(live);
        let _ = app.emit(
            EVENT_STATUS,
            StatusEvent {
                id,
                status: status.clone(),
            },
        );

        let app = app.clone();
        let live = Arc::clone(&self.live);
        std::thread::spawn(move || supervise(app, live, tunnel, server, generation, stop, child));
        Ok(status)
    }

    /// Ferme le tunnel (processus tué immédiatement, reconnexion annulée).
    pub fn stop(&self, app: &AppHandle, id: i64) -> AppResult<()> {
        let child = {
            let mut live = self.live.lock()?;
            let Some(entry) = live.get_mut(&id) else {
                return Ok(());
            };
            entry.stop.store(true, Ordering::SeqCst);
            entry.status = TunnelStatus::stopped();
            let _ = app.emit(
                EVENT_STATUS,
                StatusEvent {
                    id,
                    status: entry.status.clone(),
                },
            );
            Arc::clone(&entry.child)
        };
        if let Some(c) = child.lock()?.as_mut() {
            let _ = c.kill();
            let _ = c.wait(); // libère le port avant une éventuelle relance
        }
        Ok(())
    }

    /// Attend que le tunnel soit actif ; échoue s'il passe en erreur ou si le délai expire.
    pub fn wait_ready(&self, id: i64, timeout: Duration) -> AppResult<()> {
        let end = Instant::now() + timeout;
        loop {
            let s = self.status(id);
            match s.state {
                TunnelState::Running => return Ok(()),
                TunnelState::Error | TunnelState::Retrying => {
                    return Err(AppError::InvalidInput(
                        s.message
                            .unwrap_or_else(|| "le tunnel n'a pas pu s'ouvrir".into()),
                    ));
                }
                TunnelState::Stopped => return Err(AppError::InvalidInput("tunnel fermé".into())),
                TunnelState::Starting => {}
            }
            if Instant::now() >= end {
                return Err(AppError::InvalidInput(format!(
                    "le tunnel ne s'est pas ouvert en {} s",
                    timeout.as_secs()
                )));
            }
            std::thread::sleep(Duration::from_millis(200));
        }
    }

    /// Au lancement de DevCenter : ouvre les tunnels marqués « démarrage automatique ».
    pub fn start_auto(&self, app: &AppHandle, db: &Database) {
        let Ok(list) = list(db, self, None) else {
            return;
        };
        for t in list.into_iter().filter(|t| t.auto_start) {
            if let Err(e) = self.start(app, db, t.id) {
                log::warn!("tunnel « {} » non démarré : {e}", t.name);
            }
        }
    }

    /// Fermeture de DevCenter : aucun processus ssh orphelin.
    pub fn stop_all(&self) {
        let children: Vec<_> = match self.live.lock() {
            Ok(live) => live
                .values()
                .map(|e| {
                    e.stop.store(true, Ordering::SeqCst);
                    Arc::clone(&e.child)
                })
                .collect(),
            Err(_) => return,
        };
        for child in children {
            if let Ok(mut c) = child.lock()
                && let Some(c) = c.as_mut()
            {
                let _ = c.kill();
            }
        }
    }
}

/// Fil de surveillance d'un tunnel : lance ssh, suit son état, relance si demandé.
fn supervise(
    app: AppHandle,
    live: Arc<Mutex<HashMap<i64, Live>>>,
    tunnel: Tunnel,
    server: Server,
    generation: u64,
    stop: Arc<AtomicBool>,
    slot: Arc<Mutex<Option<Child>>>,
) {
    let id = tunnel.id;
    let mut attempt: u32 = 0;
    let mut restarts: u32 = 0;
    loop {
        if stop.load(Ordering::SeqCst) {
            return;
        }
        let spawned = shell::command("ssh")
            .args(ssh_args(&server, &tunnel))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn();
        let mut child = match spawned {
            Ok(c) => c,
            Err(e) => {
                set_status(&app, &live, id, generation, |s| {
                    s.state = TunnelState::Error;
                    s.message = Some(format!("client ssh introuvable : {e}"));
                });
                return;
            }
        };

        // stderr lu en continu (le tampon du pipe ne doit jamais se remplir).
        let lines = Arc::new(Mutex::new(VecDeque::<String>::new()));
        let authenticated = Arc::new(AtomicBool::new(false));
        let reader = child.stderr.take().map(|stderr| {
            let lines = Arc::clone(&lines);
            let authenticated = Arc::clone(&authenticated);
            std::thread::spawn(move || {
                for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                    let line = shell::strip_ansi(&line);
                    if line.starts_with("Authenticated to")
                        || line.starts_with("Authentication succeeded")
                    {
                        authenticated.store(true, Ordering::SeqCst);
                    }
                    if is_noise(&line) {
                        continue;
                    }
                    if let Ok(mut l) = lines.lock() {
                        if l.len() >= 20 {
                            l.pop_front();
                        }
                        l.push_back(line.trim().to_string());
                    }
                }
            })
        });
        if let Ok(mut s) = slot.lock() {
            *s = Some(child);
        }
        // `stop` a pu être demandé entre le lancement et l'enregistrement du processus.
        if stop.load(Ordering::SeqCst)
            && let Ok(mut s) = slot.lock()
            && let Some(c) = s.as_mut()
        {
            let _ = c.kill();
        }

        let started = Instant::now();
        let mut auth_at: Option<Instant> = None;
        let mut running = false;
        let code = loop {
            let exited = match slot.lock() {
                Ok(mut s) => match s.as_mut() {
                    Some(c) => c.try_wait().ok().flatten().map(|st| st.code()),
                    None => Some(None),
                },
                Err(_) => Some(None),
            };
            if let Some(code) = exited {
                break code;
            }
            if !running {
                if authenticated.load(Ordering::SeqCst) {
                    auth_at.get_or_insert_with(Instant::now);
                }
                if auth_at.is_some_and(|t| t.elapsed() >= READY_GRACE)
                    || started.elapsed() >= READY_FALLBACK
                {
                    running = true;
                    set_status(&app, &live, id, generation, |s| {
                        s.state = TunnelState::Running;
                        s.message = None;
                        s.restarts = restarts;
                    });
                }
            }
            std::thread::sleep(Duration::from_millis(200));
        };
        if let Ok(mut s) = slot.lock() {
            *s = None;
        }
        if let Some(r) = reader {
            let _ = r.join();
        }
        if stop.load(Ordering::SeqCst) {
            set_status(&app, &live, id, generation, |s| {
                *s = TunnelStatus::stopped()
            });
            return;
        }

        let stderr = lines
            .lock()
            .map(|l| l.iter().cloned().collect::<Vec<_>>().join(" "))
            .unwrap_or_default();
        let message = explain(&stderr, code, &tunnel);
        log::warn!(
            "tunnel « {} » ({}) fermé : {message}",
            tunnel.name,
            server.name
        );
        if !tunnel.auto_restart {
            set_status(&app, &live, id, generation, |s| {
                s.state = TunnelState::Error;
                s.message = Some(message);
            });
            return;
        }

        // Reconnexion : 2, 4, 8… jusqu'à 60 s ; remis à zéro après une connexion qui a tenu.
        if started.elapsed() > Duration::from_secs(60) {
            attempt = 0;
        }
        let delay = (1u64 << (attempt + 1).min(6)).min(MAX_BACKOFF_SECS);
        attempt += 1;
        restarts += 1;
        set_status(&app, &live, id, generation, |s| {
            s.state = TunnelState::Retrying;
            s.message = Some(format!("{message} · nouvelle tentative dans {delay} s"));
            s.restarts = restarts;
        });
        let end = Instant::now() + Duration::from_secs(delay);
        while Instant::now() < end {
            if stop.load(Ordering::SeqCst) {
                return;
            }
            std::thread::sleep(Duration::from_millis(200));
        }
        set_status(&app, &live, id, generation, |s| {
            s.state = TunnelState::Starting;
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(kind: TunnelKind) -> TunnelInput {
        TunnelInput {
            id: None,
            server_id: 1,
            name: "db".into(),
            kind,
            bind_address: None,
            local_port: 5433,
            remote_host: Some("localhost".into()),
            remote_port: Some(5432),
            auto_start: false,
            auto_restart: false,
        }
    }

    #[test]
    fn validates_hosts_and_ports() {
        assert!(validate(&input(TunnelKind::Local)).is_ok());
        assert_eq!(
            validate(&input(TunnelKind::Local)).unwrap().bind,
            "127.0.0.1"
        );
        assert!(validate_host("[::1]", "x").is_ok());
        assert!(validate_host("::1", "x").is_err());
        assert!(validate_host("-oProxyCommand=calc", "x").is_err());
        assert!(validate_host("a b", "x").is_err());
        let mut bad = input(TunnelKind::Local);
        bad.remote_host = Some("-oProxyCommand=calc".into());
        assert!(validate(&bad).is_err());
        let mut no_port = input(TunnelKind::Remote);
        no_port.remote_port = None;
        assert!(validate(&no_port).is_err());
        let mut dynamic = input(TunnelKind::Dynamic);
        dynamic.remote_port = None;
        let c = validate(&dynamic).unwrap();
        assert!(c.remote_host.is_none() && c.remote_port.is_none());
    }

    #[test]
    fn builds_forward_specs() {
        let server = Server {
            id: 1,
            name: "vps".into(),
            host: "example.org".into(),
            port: 22,
            user: Some("deploy".into()),
            key_path: None,
        };
        let mut t = Tunnel {
            id: 1,
            server_id: 1,
            server_name: "vps".into(),
            name: "db".into(),
            kind: TunnelKind::Local,
            bind_address: "127.0.0.1".into(),
            local_port: 5433,
            remote_host: Some("localhost".into()),
            remote_port: Some(5432),
            auto_start: false,
            auto_restart: false,
            status: TunnelStatus::stopped(),
        };
        let args = ssh_args(&server, &t);
        assert_eq!(args[0], "-N");
        assert!(
            args.windows(2)
                .any(|w| w == ["-L", "127.0.0.1:5433:localhost:5432"])
        );
        assert!(args.contains(&"ExitOnForwardFailure=yes".to_string()));
        assert_eq!(args.last().unwrap(), "deploy@example.org");
        t.kind = TunnelKind::Remote;
        assert!(
            ssh_args(&server, &t)
                .windows(2)
                .any(|w| w == ["-R", "localhost:5432:127.0.0.1:5433"])
        );
        t.kind = TunnelKind::Dynamic;
        assert!(
            ssh_args(&server, &t)
                .windows(2)
                .any(|w| w == ["-D", "127.0.0.1:5433"])
        );
    }
}
