//! Accès à distance (tableau de bord mobile sur le réseau local).
//!
//! Sécurité :
//! - désactivé par défaut ; serveur HTTP local démarré uniquement si l'utilisateur l'active ;
//! - seules les adresses de réseau privé (LAN, Tailscale/CGNAT, loopback) sont acceptées ;
//! - appairage par code à 6 chiffres valable 5 minutes, 5 essais maximum ;
//! - chaque appareil reçoit un jeton aléatoire de 256 bits ; seule son empreinte SHA-256 est
//!   stockée ; un appareil peut être révoqué à tout moment ;
//! - l'API n'expose qu'un petit ensemble d'actions (workspaces, automatisations, métriques).

use std::io::Read;
use std::net::{IpAddr, UdpSocket};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager};
use tiny_http::{Header, Method, Request, Response, Server};

use crate::database::Database;
use crate::error::{AppError, AppResult};
use crate::modules::{automations, workspaces};
use crate::state::AppState;

pub const DEFAULT_PORT: u16 = 47820;
pub const EVENT_CHANGED: &str = "remote://changed";
const PAIRING_TTL: Duration = Duration::from_secs(300);
const PAIRING_MAX_ATTEMPTS: u32 = 5;
const PAGE: &str = include_str!("page.html");

/// Fichiers de l'appli installable (PWA), servis sans authentification : aucune donnée dedans.
const ASSETS: &[(&str, &str, &[u8])] = &[
    ("/manifest.webmanifest", "application/manifest+json", include_bytes!("assets/manifest.webmanifest")),
    ("/sw.js", "text/javascript; charset=utf-8", include_bytes!("assets/sw.js")),
    ("/icon-180.png", "image/png", include_bytes!("assets/icon-180.png")),
    ("/icon-192.png", "image/png", include_bytes!("assets/icon-192.png")),
    ("/icon-512.png", "image/png", include_bytes!("assets/icon-512.png")),
    ("/icon-maskable-512.png", "image/png", include_bytes!("assets/icon-maskable-512.png")),
    ("/badge-96.png", "image/png", include_bytes!("assets/badge-96.png")),
];

struct Pairing {
    code: String,
    expires: Instant,
    attempts: u32,
}

struct Running {
    server: Arc<Server>,
    port: u16,
}

#[derive(Default)]
pub struct RemoteAccess {
    running: Mutex<Option<Running>>,
    pairing: Mutex<Option<Pairing>>,
    last_error: Mutex<Option<String>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub id: i64,
    pub name: String,
    pub created_at: i64,
    pub last_seen: Option<i64>,
    /// L'appareil a activé les notifications push.
    pub notifications: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteStatus {
    pub running: bool,
    pub port: Option<u16>,
    pub urls: Vec<String>,
    pub error: Option<String>,
    pub devices: Vec<Device>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingCode {
    pub code: String,
    pub expires_in_secs: u64,
}

fn random_bytes<const N: usize>() -> AppResult<[u8; N]> {
    let mut buf = [0u8; N];
    getrandom::fill(&mut buf).map_err(|e| AppError::InvalidInput(format!("générateur aléatoire indisponible : {e}")))?;
    Ok(buf)
}

fn sha256_hex(s: &str) -> String {
    hex::encode(Sha256::digest(s.as_bytes()))
}

/// Comparaison en temps constant (évite de deviner un code caractère par caractère).
fn constant_eq(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Réseau privé uniquement : 10/8, 172.16/12, 192.168/16, 127/8, 100.64/10 (Tailscale), 169.254/16, IPv6 local.
pub fn is_private(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let o = v4.octets();
            v4.is_private() || v4.is_loopback() || v4.is_link_local() || (o[0] == 100 && (64..128).contains(&o[1]))
        }
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return is_private(IpAddr::V4(v4));
            }
            let s = v6.segments()[0];
            v6.is_loopback() || (s & 0xfe00) == 0xfc00 || (s & 0xffc0) == 0xfe80
        }
    }
}

/// Adresse IP locale principale (aucun paquet n'est envoyé : simple sélection de route).
fn lan_ip() -> Option<IpAddr> {
    let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("192.0.2.1:9").ok()?;
    socket.local_addr().ok().map(|a| a.ip())
}

// ------------------------------------------------------------------ Appareils

pub fn devices(db: &Database) -> AppResult<Vec<Device>> {
    db.with(|conn| {
        let mut stmt = conn.prepare("SELECT id, name, created_at, last_seen FROM remote_devices ORDER BY created_at DESC")?;
        let rows = stmt.query_map([], |r| {
            Ok(Device { id: r.get(0)?, name: r.get(1)?, created_at: r.get(2)?, last_seen: r.get(3)?, notifications: false })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    })
    .and_then(|mut list| {
        let subscribed = crate::modules::push::subscribed_devices(db)?;
        for d in &mut list {
            d.notifications = subscribed.contains(&d.id);
        }
        Ok(list)
    })
}

pub fn revoke(db: &Database, id: i64) -> AppResult<()> {
    db.with(|conn| {
        conn.execute("DELETE FROM remote_devices WHERE id = ?1", params![id])?;
        Ok(())
    })
}

fn authenticate(db: &Database, token: &str) -> AppResult<Option<i64>> {
    if token.len() != 64 {
        return Ok(None);
    }
    let hash = sha256_hex(token);
    db.with(|conn| {
        let id: Option<i64> = conn.query_row("SELECT id FROM remote_devices WHERE token_hash = ?1", params![hash], |r| r.get(0)).optional()?;
        if let Some(id) = id {
            conn.execute("UPDATE remote_devices SET last_seen = ?1 WHERE id = ?2", params![automations::now(), id])?;
        }
        Ok(id)
    })
}

// ------------------------------------------------------------------ Cycle de vie

impl RemoteAccess {
    pub fn status(&self, db: &Database) -> AppResult<RemoteStatus> {
        let running = self.running.lock()?;
        let port = running.as_ref().map(|r| r.port);
        let mut urls = Vec::new();
        if let Some(p) = port {
            if let Some(ip) = lan_ip() {
                urls.push(format!("http://{ip}:{p}"));
            }
            urls.push(format!("http://localhost:{p}"));
        }
        Ok(RemoteStatus { running: port.is_some(), port, urls, error: self.last_error.lock()?.clone(), devices: devices(db)? })
    }

    pub fn stop(&self) {
        if let Ok(mut running) = self.running.lock() {
            if let Some(r) = running.take() {
                r.server.unblock();
            }
        }
    }

    pub fn start(&self, app: &AppHandle, port: u16) -> AppResult<()> {
        self.stop();
        let server = match Server::http(("0.0.0.0", port)) {
            Ok(s) => Arc::new(s),
            Err(e) => {
                let msg = format!("impossible d'ouvrir le port {port} : {e}");
                *self.last_error.lock()? = Some(msg.clone());
                return Err(AppError::InvalidInput(msg));
            }
        };
        *self.last_error.lock()? = None;
        *self.running.lock()? = Some(Running { server: Arc::clone(&server), port });

        let app = app.clone();
        std::thread::Builder::new().name("remote-http".into()).spawn(move || {
            for request in server.incoming_requests() {
                let app = app.clone();
                // Une requête par thread : une action longue ne bloque pas les autres.
                std::thread::spawn(move || handle(&app, request));
            }
        })?;
        Ok(())
    }

    pub fn new_pairing_code(&self) -> AppResult<PairingCode> {
        if self.running.lock()?.is_none() {
            return Err(AppError::InvalidInput("activez d'abord l'accès à distance".into()));
        }
        let n = u32::from_le_bytes(random_bytes::<4>()?) % 1_000_000;
        let code = format!("{n:06}");
        *self.pairing.lock()? = Some(Pairing { code: code.clone(), expires: Instant::now() + PAIRING_TTL, attempts: 0 });
        Ok(PairingCode { code, expires_in_secs: PAIRING_TTL.as_secs() })
    }

    fn try_pair(&self, code: &str) -> Result<(), &'static str> {
        let mut pairing = self.pairing.lock().map_err(|_| "erreur interne")?;
        let Some(p) = pairing.as_mut() else { return Err("aucun appairage en cours : générez un code dans DevCenter") };
        if Instant::now() > p.expires {
            *pairing = None;
            return Err("code expiré : générez-en un nouveau dans DevCenter");
        }
        p.attempts += 1;
        if !constant_eq(&p.code, code.trim()) {
            if p.attempts >= PAIRING_MAX_ATTEMPTS {
                *pairing = None;
                return Err("trop d'essais : générez un nouveau code dans DevCenter");
            }
            return Err("code incorrect");
        }
        *pairing = None; // usage unique
        Ok(())
    }
}

// ------------------------------------------------------------------ HTTP

fn header(name: &str, value: &str) -> Header {
    Header::from_bytes(name.as_bytes(), value.as_bytes()).expect("en-tête valide")
}

fn json_response<T: Serialize>(status: u16, body: &T) -> Response<std::io::Cursor<Vec<u8>>> {
    let data = serde_json::to_vec(body).unwrap_or_else(|_| b"{}".to_vec());
    Response::from_data(data)
        .with_status_code(status)
        .with_header(header("Content-Type", "application/json; charset=utf-8"))
        .with_header(header("Cache-Control", "no-store"))
        .with_header(header("X-Content-Type-Options", "nosniff"))
}

fn error(status: u16, message: &str) -> Response<std::io::Cursor<Vec<u8>>> {
    json_response(status, &serde_json::json!({ "error": message }))
}

#[derive(Deserialize)]
struct PairBody {
    code: String,
    #[serde(default)]
    name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MobileStatus {
    host: String,
    os: Option<String>,
    cpu_brand: String,
    cpu_cores: usize,
    cpu_usage: f32,
    cpu_per_core: Vec<f32>,
    memory_used: u64,
    memory_total: u64,
    swap_used: u64,
    swap_total: u64,
    uptime_secs: u64,
    disks: Vec<MobileDisk>,
    gpus: Vec<MobileGpu>,
    top_processes: Vec<MobileProcess>,
    runs: Vec<MobileRun>,
    workspaces: Vec<MobileWorkspace>,
    automations: Vec<MobileAutomation>,
    servers: Vec<MobileServer>,
    clone_jobs: Vec<crate::modules::projects::import::CloneJob>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MobileProject {
    id: i64,
    name: String,
    path: String,
    exists: bool,
    languages: Vec<String>,
    frameworks: Vec<String>,
    package_manager: Option<String>,
    scripts: Vec<String>,
    branch: Option<String>,
    changes: u32,
    ahead: u32,
    behind: u32,
    last_commit: Option<String>,
    last_commit_at: Option<i64>,
}

/// Projets avec Git et frameworks ; lecture en parallèle (un `git status` par projet).
fn projects_payload(app: &AppHandle) -> AppResult<Vec<MobileProject>> {
    let state = app.state::<AppState>();
    let list = crate::modules::projects::list(&state.db)?;
    let mut out: Vec<MobileProject> = std::thread::scope(|scope| {
        let handles: Vec<_> = list
            .iter()
            .map(|p| {
                scope.spawn(move || {
                    let path = std::path::Path::new(&p.path);
                    let d = p.exists.then(|| crate::modules::projects::details(p.id, path));
                    let meta = d.as_ref().map(|d| &d.meta);
                    let git = d.as_ref().and_then(|d| d.git.as_ref());
                    MobileProject {
                        id: p.id,
                        name: p.name.clone(),
                        path: p.path.clone(),
                        exists: p.exists,
                        languages: meta.map(|m| m.languages.clone()).unwrap_or_default(),
                        frameworks: meta.map(|m| m.frameworks.clone()).unwrap_or_default(),
                        package_manager: meta.and_then(|m| m.package_manager.clone()),
                        scripts: meta.map(|m| m.scripts.iter().map(|s| s.name.clone()).collect()).unwrap_or_default(),
                        branch: git.and_then(|g| g.branch.clone()),
                        changes: git.map(|g| g.staged + g.modified + g.untracked + g.conflicts).unwrap_or(0),
                        ahead: git.map(|g| g.ahead).unwrap_or(0),
                        behind: git.map(|g| g.behind).unwrap_or(0),
                        last_commit: git.and_then(|g| g.last_commit.as_ref().map(|c| c.subject.clone())),
                        last_commit_at: git.and_then(|g| g.last_commit.as_ref().map(|c| c.timestamp)),
                    }
                })
            })
            .collect();
        handles.into_iter().filter_map(|h| h.join().ok()).collect()
    });
    out.sort_by_key(|p| p.name.to_lowercase());
    Ok(out)
}

#[derive(Deserialize)]
struct RunBody {
    script: String,
}

#[derive(Deserialize)]
struct ScanBody {
    root: String,
}

#[derive(Deserialize)]
struct ImportBody {
    paths: Vec<String>,
}

#[derive(Deserialize)]
struct CloneBody {
    url: String,
    #[serde(default)]
    name: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MobileDisk {
    mount: String,
    total_bytes: u64,
    available_bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MobileGpu {
    name: String,
    usage: Option<f32>,
    memory_total: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MobileProcess {
    name: String,
    pid: u32,
    cpu_usage: f32,
    memory: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MobileRun {
    id: u64,
    project: String,
    script: String,
    status: String,
    url: Option<String>,
    exit_code: Option<i32>,
    started_at: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MobileWorkspace {
    id: i64,
    name: String,
    description: String,
    favorite: bool,
    active: bool,
    started_at: Option<i64>,
    run_ids: Vec<u64>,
    failures: Vec<String>,
    steps: usize,
    last_started_at: Option<i64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MobileAutomation {
    id: i64,
    name: String,
    enabled: bool,
    running: bool,
    trigger: automations::Trigger,
    steps: usize,
    last_status: Option<String>,
    last_started_at: Option<i64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MobileServer {
    id: i64,
    name: String,
    destination: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MobileHistoryItem {
    kind: &'static str,
    name: String,
    origin: Option<String>,
    status: String,
    started_at: i64,
    ended_at: Option<i64>,
    failures: Vec<String>,
}

fn status_payload(app: &AppHandle) -> AppResult<MobileStatus> {
    use crate::modules::runner::RunStatus;
    let state = app.state::<AppState>();
    let snap = state.system.snapshot()?;
    let info = state.system.info()?;
    let projects = crate::modules::projects::list(&state.db)?;
    let project_name = |id: i64| projects.iter().find(|p| p.id == id).map(|p| p.name.clone()).unwrap_or_else(|| format!("projet {id}"));

    let mut procs = state.system.processes(None, None)?;
    procs.sort_by(|a, b| b.cpu_usage.total_cmp(&a.cpu_usage));
    let gpus = state.system.hardware().map(|h| h.gpus).unwrap_or_default();

    let status_str = |s: RunStatus| match s {
        RunStatus::Running => "running",
        RunStatus::Exited => "exited",
        RunStatus::Failed => "failed",
        RunStatus::Stopped => "stopped",
    };

    Ok(MobileStatus {
        host: info.host_name.unwrap_or_else(|| "DevCenter".into()),
        os: info.os_version.or(info.os_name),
        cpu_brand: info.cpu_brand,
        cpu_cores: info.cpu_cores,
        cpu_usage: snap.cpu_usage,
        cpu_per_core: snap.cpu_per_core,
        memory_used: snap.memory_used,
        memory_total: snap.memory_total,
        swap_used: snap.swap_used,
        swap_total: snap.swap_total,
        uptime_secs: snap.uptime_secs,
        disks: snap
            .disks
            .into_iter()
            .filter(|d| d.total_bytes > 0)
            .map(|d| MobileDisk { mount: d.mount_point, total_bytes: d.total_bytes, available_bytes: d.available_bytes })
            .collect(),
        gpus: gpus
            .into_iter()
            .map(|g| MobileGpu { name: g.model.or(g.vendor).unwrap_or_else(|| "GPU".into()), usage: g.usage, memory_total: g.memory_total })
            .collect(),
        top_processes: procs
            .into_iter()
            .take(8)
            .map(|p| MobileProcess { name: p.name, pid: p.pid, cpu_usage: p.cpu_usage, memory: p.memory })
            .collect(),
        runs: state
            .runner
            .list()?
            .into_iter()
            .map(|r| MobileRun {
                id: r.id,
                project: project_name(r.project_id),
                script: r.script,
                status: status_str(r.status).into(),
                url: r.url,
                exit_code: r.exit_code,
                started_at: r.started_at,
            })
            .collect(),
        workspaces: workspaces::list(&state.db, &state.workspaces)?
            .into_iter()
            .map(|w| MobileWorkspace {
                id: w.id,
                description: w.description,
                favorite: w.favorite,
                active: w.active.is_some(),
                started_at: w.active.as_ref().map(|a| a.started_at),
                run_ids: w.active.as_ref().map(|a| a.run_ids.clone()).unwrap_or_default(),
                failures: w
                    .active
                    .as_ref()
                    .map(|a| a.results.iter().filter(|r| !r.ok).map(|r| format!("{} : {}", r.label, r.message.clone().unwrap_or_default())).collect())
                    .unwrap_or_default(),
                steps: w.steps.len(),
                last_started_at: w.last_started_at,
                name: w.name,
            })
            .collect(),
        automations: automations::list(&state.db, &state.automations)?
            .into_iter()
            .map(|a| MobileAutomation {
                id: a.id,
                enabled: a.enabled,
                running: a.running,
                steps: a.steps.len(),
                last_status: a.last_run.as_ref().map(|r| r.status.clone()),
                last_started_at: a.last_run.as_ref().map(|r| r.started_at),
                trigger: a.trigger,
                name: a.name,
            })
            .collect(),
        servers: crate::modules::servers::list(&state.db)?
            .into_iter()
            .map(|s| MobileServer { destination: crate::modules::servers::ssh::destination(&s), id: s.id, name: s.name })
            .collect(),
        clone_jobs: state.clones.list(),
    })
}

fn history_payload(app: &AppHandle) -> AppResult<Vec<MobileHistoryItem>> {
    let state = app.state::<AppState>();
    let mut items: Vec<MobileHistoryItem> = automations::history(&state.db, None, 25, None)?
        .into_iter()
        .map(|r| MobileHistoryItem {
            kind: "automation",
            name: r.automation_name,
            origin: Some(r.origin),
            status: r.status,
            started_at: r.started_at,
            ended_at: r.ended_at,
            failures: r.log.into_iter().filter(|l| l.outcome == "failed").map(|l| format!("{} : {}", l.label, l.message.unwrap_or_default())).collect(),
        })
        .collect();
    items.extend(workspaces::history(&state.db, 15)?.into_iter().map(|s| MobileHistoryItem {
        kind: "workspace",
        name: s.workspace_name,
        origin: None,
        status: s.status,
        started_at: s.started_at,
        ended_at: s.ended_at,
        failures: s.results.into_iter().filter(|r| !r.ok).map(|r| format!("{} : {}", r.label, r.message.unwrap_or_default())).collect(),
    }));
    items.sort_by_key(|i| std::cmp::Reverse(i.started_at));
    items.truncate(30);
    Ok(items)
}

fn handle(app: &AppHandle, mut req: Request) {
    let peer_ok = req.remote_addr().is_some_and(|a| is_private(a.ip()));
    if !peer_ok {
        let _ = req.respond(error(403, "accès réservé au réseau local"));
        return;
    }
    let path = req.url().split('?').next().unwrap_or("/").to_string();
    let query = req.url().split_once('?').map(|(_, q)| q.to_string()).unwrap_or_default();
    let method = req.method().clone();

    // Page web (aucune donnée sensible : tout passe ensuite par l'API authentifiée).
    if method == Method::Get && (path == "/" || path == "/index.html") {
        let resp = Response::from_string(PAGE)
            .with_header(header("Content-Type", "text/html; charset=utf-8"))
            .with_header(header("Cache-Control", "no-store"))
            .with_header(header("X-Content-Type-Options", "nosniff"))
            .with_header(header("X-Frame-Options", "DENY"))
            .with_header(header(
                "Content-Security-Policy",
                "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; manifest-src 'self'; worker-src 'self'",
            ));
        let _ = req.respond(resp);
        return;
    }
    if method == Method::Get {
        if let Some((_, mime, bytes)) = ASSETS.iter().find(|(p, _, _)| *p == path) {
            let mut resp = Response::from_data(bytes.to_vec())
                .with_header(header("Content-Type", mime))
                .with_header(header("X-Content-Type-Options", "nosniff"));
            // Le service worker doit être revalidé à chaque fois ; les icônes peuvent être mises en cache.
            resp = if path == "/sw.js" {
                resp.with_header(header("Cache-Control", "no-cache")).with_header(header("Service-Worker-Allowed", "/"))
            } else {
                resp.with_header(header("Cache-Control", "public, max-age=86400"))
            };
            let _ = req.respond(resp);
            return;
        }
    }

    let state = app.state::<AppState>();

    if method == Method::Post && path == "/api/pair" {
        let mut body = String::new();
        if req.as_reader().take(4096).read_to_string(&mut body).is_err() {
            let _ = req.respond(error(400, "requête invalide"));
            return;
        }
        let Ok(pair) = serde_json::from_str::<PairBody>(&body) else {
            let _ = req.respond(error(400, "requête invalide"));
            return;
        };
        let resp = match state.remote.try_pair(&pair.code) {
            Err(msg) => error(401, msg),
            Ok(()) => match random_bytes::<32>() {
                Err(_) => error(500, "erreur interne"),
                Ok(bytes) => {
                    let token = hex::encode(bytes);
                    let name: String = pair.name.chars().filter(|c| !c.is_control()).take(60).collect();
                    let name = if name.trim().is_empty() { "Appareil".to_string() } else { name };
                    let saved = state.db.with(|conn| {
                        conn.execute(
                            "INSERT INTO remote_devices (name, token_hash, created_at) VALUES (?1, ?2, ?3)",
                            params![name, sha256_hex(&token), automations::now()],
                        )?;
                        Ok(())
                    });
                    let _ = app.emit(EVENT_CHANGED, ());
                    match saved {
                        Ok(()) => json_response(200, &serde_json::json!({ "token": token })),
                        Err(_) => error(500, "erreur interne"),
                    }
                }
            },
        };
        let _ = req.respond(resp);
        return;
    }

    // Toutes les autres routes de l'API exigent un jeton d'appareil.
    let token = req
        .headers()
        .iter()
        .find(|h| h.field.equiv("Authorization"))
        .and_then(|h| h.value.as_str().strip_prefix("Bearer ").map(str::to_string))
        .unwrap_or_default();
    let device_id = match authenticate(&state.db, &token) {
        Ok(Some(id)) => id,
        _ => {
            let _ = req.respond(error(401, "appareil non appairé ou révoqué"));
            return;
        }
    };
    // Corps JSON (limité à 8 Ko) pour les routes qui en ont besoin.
    let mut body = String::new();
    if method == Method::Post {
        let _ = req.as_reader().take(8192).read_to_string(&mut body);
    }

    let segments: Vec<&str> = path.trim_matches('/').split('/').collect();
    let ok = || json_response(200, &serde_json::json!({ "ok": true }));
    let resp = match (&method, segments.as_slice()) {
        (Method::Get, ["api", "status"]) => match status_payload(app) {
            Ok(s) => json_response(200, &s),
            Err(e) => error(500, &e.to_string()),
        },
        (Method::Get, ["api", "history"]) => match history_payload(app) {
            Ok(h) => json_response(200, &h),
            Err(e) => error(500, &e.to_string()),
        },
        (Method::Post, ["api", "workspaces", id, action @ ("start" | "stop")]) => match id.parse::<i64>() {
            Err(_) => error(400, "identifiant invalide"),
            Ok(id) => {
                let r = if *action == "start" { workspaces::start(app, &state, id).map(|_| ()) } else { workspaces::stop(app, &state, id) };
                match r {
                    Ok(()) => ok(),
                    Err(e) => error(400, &e.to_string()),
                }
            }
        },
        (Method::Post, ["api", "automations", id, "run"]) => match id.parse::<i64>() {
            Err(_) => error(400, "identifiant invalide"),
            Ok(id) => match automations::trigger(app, id, "manual") {
                Ok(run) => json_response(200, &serde_json::json!({ "ok": true, "runId": run })),
                Err(e) => error(400, &e.to_string()),
            },
        },
        // Scripts : uniquement ceux lancés par DevCenter (identifiants du runner).
        (Method::Get, ["api", "runs", id, "logs"]) => match id.parse::<u64>() {
            Err(_) => error(400, "identifiant invalide"),
            Ok(id) => match state.runner.logs(id) {
                Ok(lines) => {
                    let tail: Vec<String> = lines.iter().rev().take(400).rev().cloned().collect();
                    json_response(200, &serde_json::json!({ "lines": tail }))
                }
                Err(e) => error(404, &e.to_string()),
            },
        },
        (Method::Post, ["api", "runs", id, "stop"]) => match id.parse::<u64>() {
            Err(_) => error(400, "identifiant invalide"),
            Ok(id) => match state.runner.stop(id) {
                Ok(()) => ok(),
                Err(e) => error(400, &e.to_string()),
            },
        },
        (Method::Post, ["api", "servers", id, "ping"]) => match id.parse::<i64>() {
            Err(_) => error(400, "identifiant invalide"),
            Ok(id) => match crate::modules::servers::get(&state.db, id).and_then(|s| crate::modules::servers::remote::ping(&s)) {
                Ok(ms) => json_response(200, &serde_json::json!({ "ok": true, "ms": ms })),
                Err(e) => json_response(200, &serde_json::json!({ "ok": false, "error": e.to_string() })),
            },
        },
        // Projets : liste, scripts, éditeur, import (dossiers de projets uniquement) et clonage.
        (Method::Get, ["api", "projects"]) => match projects_payload(app) {
            Ok(p) => json_response(200, &p),
            Err(e) => error(500, &e.to_string()),
        },
        (Method::Post, ["api", "projects", id, "run"]) => match (id.parse::<i64>(), serde_json::from_str::<RunBody>(&body)) {
            (Ok(id), Ok(b)) => match crate::modules::projects::run_script(app, id, &b.script) {
                Ok(run) => json_response(200, &serde_json::json!({ "ok": true, "runId": run.id })),
                Err(e) => error(400, &e.to_string()),
            },
            _ => error(400, "requête invalide"),
        },
        (Method::Get, ["api", "projects", id, "log"]) => match id.parse::<i64>() {
            Err(_) => error(400, "identifiant invalide"),
            Ok(id) => {
                let limit = query.split('&').find_map(|p| p.strip_prefix("limit=")).and_then(|v| v.parse().ok()).unwrap_or(150);
                match crate::modules::projects::path_of(&state.db, id).and_then(|p| crate::modules::projects::gitcache::log(&p, limit)) {
                    Ok(log) => json_response(200, &log),
                    Err(e) => error(400, &e.to_string()),
                }
            }
        },
        (Method::Get, ["api", "projects", id, "commits", hash]) => match id.parse::<i64>() {
            Err(_) => error(400, "identifiant invalide"),
            Ok(id) => match crate::modules::projects::path_of(&state.db, id).and_then(|p| crate::modules::projects::gitcache::commit(&p, hash)) {
                Ok(d) => json_response(200, &d),
                Err(e) => error(400, &e.to_string()),
            },
        },
        (Method::Post, ["api", "projects", id, "open"]) => match id.parse::<i64>() {
            Err(_) => error(400, "identifiant invalide"),
            Ok(id) => {
                let r = crate::modules::projects::path_of(&state.db, id).and_then(|path| {
                    let settings = crate::modules::settings::SettingsService::load(&state.db)?;
                    crate::modules::editor::open(settings.editor_path.as_deref(), &path)
                });
                match r {
                    Ok(()) => ok(),
                    Err(e) => error(400, &e.to_string()),
                }
            }
        },
        (Method::Get, ["api", "projects", "import"]) => {
            use crate::modules::projects::import;
            match (import::roots(&state.db), import::default_root(&state.db)) {
                (Ok(roots), Ok(default_root)) => json_response(
                    200,
                    &serde_json::json!({ "roots": roots, "defaultRoot": default_root.display().to_string(), "jobs": state.clones.list() }),
                ),
                (Err(e), _) | (_, Err(e)) => error(500, &e.to_string()),
            }
        }
        (Method::Post, ["api", "projects", "scan"]) => match serde_json::from_str::<ScanBody>(&body) {
            Err(_) => error(400, "requête invalide"),
            Ok(b) => {
                let allowed = crate::modules::projects::import::roots(&state.db)
                    .map(|r| r.iter().any(|x| x.eq_ignore_ascii_case(b.root.trim_end_matches(['\\', '/']))))
                    .unwrap_or(false);
                if !allowed {
                    error(403, "dossier non autorisé : choisissez un des dossiers de projets")
                } else {
                    match crate::modules::projects::scan(&state.db, &b.root) {
                        Ok(c) => json_response(200, &c),
                        Err(e) => error(400, &e.to_string()),
                    }
                }
            }
        },
        (Method::Post, ["api", "projects", "import"]) => match serde_json::from_str::<ImportBody>(&body) {
            Err(_) => error(400, "requête invalide"),
            Ok(b) if b.paths.is_empty() || b.paths.len() > 200 => error(400, "liste de dossiers invalide"),
            Ok(b) => {
                let all_allowed = b.paths.iter().all(|p| crate::modules::projects::import::within_roots(&state.db, p).unwrap_or(false));
                if !all_allowed {
                    error(403, "dossier hors des dossiers de projets")
                } else {
                    match crate::modules::projects::add(&state.db, &b.paths) {
                        Ok(_) => {
                            let _ = app.emit(crate::modules::projects::import::EVENT_CHANGED, ());
                            json_response(200, &serde_json::json!({ "ok": true, "count": b.paths.len() }))
                        }
                        Err(e) => error(400, &e.to_string()),
                    }
                }
            }
        },
        (Method::Post, ["api", "projects", "clone"]) => match serde_json::from_str::<CloneBody>(&body) {
            Err(_) => error(400, "requête invalide"),
            Ok(b) => match state.clones.start(app, &b.url, b.name.as_deref()) {
                Ok(job) => json_response(200, &job),
                Err(e) => error(400, &e.to_string()),
            },
        },
        (Method::Get, ["api", "github", "repos"]) => {
            let st = crate::modules::github::status();
            if st.login.is_none() {
                json_response(200, &serde_json::json!({ "installed": st.installed, "login": null, "repos": [] }))
            } else {
                match state.github.repos(&state.db, query.split('&').any(|p| p == "refresh=1")) {
                    Ok((login, repos)) => json_response(200, &serde_json::json!({ "installed": true, "login": login, "repos": repos })),
                    Err(e) => error(500, &e.to_string()),
                }
            }
        }
        // Notifications push de cet appareil.
        (Method::Get, ["api", "push"]) => match (crate::modules::push::public_key(&state.db), crate::modules::push::is_subscribed(&state.db, device_id)) {
            (Ok(key), Ok(subscribed)) => json_response(200, &serde_json::json!({ "publicKey": key, "subscribed": subscribed })),
            (Err(e), _) | (_, Err(e)) => error(500, &e.to_string()),
        },
        (Method::Post, ["api", "push", "subscribe"]) => match serde_json::from_str::<crate::modules::push::SubscriptionInput>(&body) {
            Err(_) => error(400, "abonnement invalide"),
            Ok(sub) => match crate::modules::push::subscribe(&state.db, device_id, &sub) {
                Ok(()) => {
                    let _ = app.emit(EVENT_CHANGED, ());
                    ok()
                }
                Err(e) => error(400, &e.to_string()),
            },
        },
        (Method::Post, ["api", "push", "unsubscribe"]) => match crate::modules::push::unsubscribe(&state.db, device_id) {
            Ok(()) => {
                let _ = app.emit(EVENT_CHANGED, ());
                ok()
            }
            Err(e) => error(500, &e.to_string()),
        },
        (Method::Post, ["api", "push", "test"]) => {
            let n = crate::modules::push::Notification {
                title: "DevCenter".into(),
                body: "Les notifications fonctionnent sur cet appareil.".into(),
                tab: Some("home".into()),
                tag: Some("test".into()),
            };
            match crate::modules::push::send(&state.db, Some(device_id), &n) {
                Ok(0) => error(400, "aucun abonnement actif sur cet appareil"),
                Ok(_) => ok(),
                Err(e) => error(500, &e.to_string()),
            }
        }
        _ => error(404, "introuvable"),
    };
    let _ = req.respond(resp);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn private_networks_only() {
        for ok in ["192.168.1.20", "10.0.0.5", "172.20.1.1", "127.0.0.1", "100.101.102.103", "::1", "fd00::1", "fe80::1"] {
            assert!(is_private(ok.parse().unwrap()), "{ok}");
        }
        for bad in ["8.8.8.8", "172.32.0.1", "100.128.0.1", "2001:4860::8888"] {
            assert!(!is_private(bad.parse().unwrap()), "{bad}");
        }
    }

    #[test]
    fn pairing_codes_are_single_use_and_limited() {
        let r = RemoteAccess::default();
        *r.pairing.lock().unwrap() = Some(Pairing { code: "123456".into(), expires: Instant::now() + PAIRING_TTL, attempts: 0 });
        assert!(r.try_pair("000000").is_err());
        assert!(r.try_pair("123456").is_ok());
        assert!(r.try_pair("123456").is_err()); // usage unique

        *r.pairing.lock().unwrap() = Some(Pairing { code: "123456".into(), expires: Instant::now() + PAIRING_TTL, attempts: 0 });
        for _ in 0..PAIRING_MAX_ATTEMPTS {
            let _ = r.try_pair("999999");
        }
        assert!(r.try_pair("123456").is_err()); // invalidé après 5 essais

        *r.pairing.lock().unwrap() = Some(Pairing { code: "123456".into(), expires: Instant::now() - Duration::from_secs(1), attempts: 0 });
        assert!(r.try_pair("123456").is_err()); // expiré
    }

    #[test]
    fn tokens_are_hashed() {
        let dir = std::env::temp_dir().join(format!("devcenter-remote-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = Database::open(&dir.join("t.db")).unwrap();
        let token = hex::encode(random_bytes::<32>().unwrap());
        db.with(|c| {
            c.execute("INSERT INTO remote_devices (name, token_hash, created_at) VALUES ('tel', ?1, 0)", params![sha256_hex(&token)])?;
            Ok(())
        })
        .unwrap();
        assert!(authenticate(&db, &token).unwrap().is_some());
        assert!(authenticate(&db, &"0".repeat(64)).unwrap().is_none());
        let id = devices(&db).unwrap()[0].id;
        revoke(&db, id).unwrap();
        assert!(authenticate(&db, &token).unwrap().is_none());
        std::fs::remove_dir_all(&dir).ok();
    }
}
