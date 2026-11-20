//! Navigateur de fichiers distant et transferts, sans bibliothèque SSH : tout passe par
//! le client OpenSSH du système (`ssh.exe`, `BatchMode=yes`).
//!
//! - Listage : `find -maxdepth 1 -printf` (GNU), champs séparés par des tabulations et
//!   entrées terminées par un octet nul, le nom en dernier : aucun nom ne peut casser l'analyse.
//! - Transferts : le contenu du fichier passe dans le flux SSH (`cat`) ; on compte les octets
//!   pour la progression, et annuler revient à tuer le processus `ssh`.
//! - Chaque script distant est exécuté par `sh -c` (quel que soit le shell de connexion) et
//!   chaque chemin y est cité ; les chemins doivent être absolus (jamais pris pour une option)
//!   et les noms ne peuvent contenir ni `/` ni octet nul.

use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStderr, Output, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::error::{AppError, AppResult};
use crate::modules::shell;

use super::Server;
use super::ssh::{self, quote};

pub const EVENT_TRANSFER: &str = "sftp://transfer";

const TIMEOUT: Duration = Duration::from_secs(20);
const MAX_PATH: usize = 4096;
const MAX_NAME: usize = 255;

fn invalid(msg: impl Into<String>) -> AppError {
    AppError::InvalidInput(msg.into())
}

// ------------------------------------------------------------------ Chemins

/// Chemin distant accepté : absolu, sans octet nul ni composant `..`.
pub fn validate_path(path: &str) -> AppResult<()> {
    if !path.starts_with('/') {
        return Err(invalid(format!("chemin distant non absolu : {path}")));
    }
    if path.len() > MAX_PATH || path.contains('\0') {
        return Err(invalid("chemin distant invalide"));
    }
    if path.split('/').any(|c| c == "..") {
        return Err(invalid("chemin distant invalide (« .. » interdit)"));
    }
    Ok(())
}

/// Nom d'un élément (création, renommage, envoi) : un seul composant de chemin.
pub fn validate_name(name: &str) -> AppResult<()> {
    let ok = !name.is_empty()
        && name.len() <= MAX_NAME
        && name != "."
        && name != ".."
        && !name.contains('/')
        && !name.contains('\0');
    if ok {
        Ok(())
    } else {
        Err(invalid(format!("nom invalide : {name}")))
    }
}

pub fn join(dir: &str, name: &str) -> String {
    if dir.ends_with('/') {
        format!("{dir}{name}")
    } else {
        format!("{dir}/{name}")
    }
}

/// Dossier parent d'un chemin absolu (`/` pour un élément à la racine).
pub fn parent(path: &str) -> String {
    let trimmed = path.trim_end_matches('/');
    match trimmed.rfind('/') {
        Some(0) | None => "/".into(),
        Some(i) => trimmed[..i].into(),
    }
}

pub fn basename(path: &str) -> &str {
    path.trim_end_matches('/').rsplit('/').next().unwrap_or("")
}

/// Script POSIX exécuté par `sh -c`, indépendamment du shell de connexion de l'utilisateur.
fn sh(script: &str) -> String {
    format!("sh -c {}", quote(script))
}

// ------------------------------------------------------------------ Exécution

fn clean_stderr(stderr: &[u8]) -> String {
    String::from_utf8_lossy(stderr)
        .lines()
        .filter(|l| !l.starts_with("Warning: Permanently added"))
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .chars()
        .take(400)
        .collect()
}

/// Message d'échec : erreur SSH (code 255) traduite, sinon message de la commande distante.
fn failure(stderr: &[u8], code: Option<i32>) -> String {
    let msg = clean_stderr(stderr);
    if code == Some(255) {
        return ssh::explain(&msg, code);
    }
    if msg.is_empty() {
        format!(
            "la commande distante a échoué (code {})",
            code.map(|c| c.to_string()).unwrap_or_else(|| "?".into())
        )
    } else {
        msg
    }
}

fn run(server: &Server, script: &str) -> AppResult<Output> {
    ssh::exec(server, &sh(script), TIMEOUT)
}

fn run_ok(server: &Server, script: &str) -> AppResult<Vec<u8>> {
    let out = run(server, script)?;
    if out.status.success() {
        Ok(out.stdout)
    } else {
        Err(invalid(failure(&out.stderr, out.status.code())))
    }
}

// ------------------------------------------------------------------ Listage

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum EntryKind {
    File,
    Dir,
    Link,
    Other,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteEntry {
    pub name: String,
    pub path: String,
    pub kind: EntryKind,
    /// Dossier, ou lien symbolique vers un dossier : on peut y entrer.
    pub is_dir: bool,
    pub size: u64,
    /// Horodatage Unix (secondes) de dernière modification.
    pub modified: i64,
    /// Permissions façon `ls -l` (`drwxr-xr-x`).
    pub mode: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteListing {
    /// Chemin absolu réel du dossier listé (`$PWD`).
    pub path: String,
    pub entries: Vec<RemoteEntry>,
}

/// `%y` type, `%Y` type de la cible d'un lien, `%s` taille, `%T@` date, `%M` permissions, `%P` nom.
const FIND_FORMAT: &str = r"%y\t%Y\t%s\t%T@\t%M\t%P\0";

fn list_script(path: Option<&str>) -> String {
    let cd = path
        .map(|p| format!("cd -- {} && ", quote(p)))
        .unwrap_or_default();
    format!(
        "{cd}printf '%s\\0' \"$PWD\" && LC_ALL=C find . -mindepth 1 -maxdepth 1 -printf {}",
        quote(FIND_FORMAT)
    )
}

fn kind_of(c: &str) -> EntryKind {
    match c {
        "f" => EntryKind::File,
        "d" => EntryKind::Dir,
        "l" => EntryKind::Link,
        _ => EntryKind::Other,
    }
}

/// Analyse la sortie de `list_script` : `$PWD\0` puis une entrée par bloc terminé par `\0`.
pub fn parse_listing(raw: &[u8]) -> AppResult<RemoteListing> {
    let mut chunks = raw.split(|b| *b == 0);
    let path = String::from_utf8_lossy(chunks.next().unwrap_or_default())
        .trim_end_matches(['\r', '\n'])
        .to_string();
    if !path.starts_with('/') {
        return Err(invalid(
            "réponse inattendue du serveur (dossier courant introuvable)",
        ));
    }
    let mut entries = Vec::new();
    for chunk in chunks {
        if chunk.is_empty() {
            continue;
        }
        let text = String::from_utf8_lossy(chunk);
        // Le nom est le dernier champ : il peut contenir des tabulations, pas d'octet nul.
        let fields: Vec<&str> = text.splitn(6, '\t').collect();
        let [ty, target_ty, size, mtime, mode, name] = fields[..] else {
            continue;
        };
        if name.is_empty() || name == "." || name == ".." || name.contains('/') {
            continue;
        }
        let kind = kind_of(ty);
        let is_dir = kind == EntryKind::Dir || (kind == EntryKind::Link && target_ty == "d");
        entries.push(RemoteEntry {
            name: name.to_string(),
            path: join(&path, name),
            kind,
            is_dir,
            size: size.parse().unwrap_or(0),
            modified: mtime.parse::<f64>().map(|t| t as i64).unwrap_or(0),
            mode: mode.to_string(),
        });
    }
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(RemoteListing { path, entries })
}

/// Liste un dossier ; `None` = dossier personnel de l'utilisateur SSH.
pub fn list(server: &Server, path: Option<&str>) -> AppResult<RemoteListing> {
    if let Some(p) = path {
        validate_path(p)?;
    }
    let out = run(server, &list_script(path))?;
    if !out.status.success() {
        let msg = failure(&out.stderr, out.status.code());
        let lower = msg.to_lowercase();
        if lower.contains("printf")
            && (lower.contains("unknown")
                || lower.contains("unrecognized")
                || lower.contains("invalid"))
        {
            return Err(invalid(
                "le serveur n'a pas GNU find (option -printf) : navigateur de fichiers indisponible",
            ));
        }
        // Quelques entrées illisibles ne doivent pas masquer tout le dossier.
        if out.status.code() == Some(1) && out.stdout.contains(&0) {
            return parse_listing(&out.stdout);
        }
        return Err(invalid(msg));
    }
    parse_listing(&out.stdout)
}

// ------------------------------------------------------------------ Opérations

pub fn make_dir(server: &Server, dir: &str, name: &str) -> AppResult<()> {
    validate_path(dir)?;
    validate_name(name)?;
    run_ok(server, &format!("mkdir -- {}", quote(&join(dir, name)))).map(|_| ())
}

const EXISTS_CODE: i32 = 17;

fn rename_script(from: &str, to: &str) -> String {
    format!(
        "if [ -e {t} ] || [ -L {t} ]; then exit {EXISTS_CODE}; fi; mv -- {f} {t}",
        f = quote(from),
        t = quote(to)
    )
}

pub fn rename(server: &Server, path: &str, new_name: &str) -> AppResult<()> {
    validate_path(path)?;
    validate_name(new_name)?;
    if path == "/" {
        return Err(invalid("impossible de renommer la racine"));
    }
    let target = join(&parent(path), new_name);
    if target == path {
        return Ok(());
    }
    let out = run(server, &rename_script(path, &target))?;
    match out.status.code() {
        Some(0) => Ok(()),
        Some(EXISTS_CODE) => Err(invalid(format!(
            "« {new_name} » existe déjà dans ce dossier"
        ))),
        code => Err(invalid(failure(&out.stderr, code))),
    }
}

fn delete_script(path: &str, recursive: bool) -> String {
    format!(
        "rm -{}f -- {}",
        if recursive { "r" } else { "" },
        quote(path)
    )
}

pub fn delete(server: &Server, path: &str, recursive: bool) -> AppResult<()> {
    validate_path(path)?;
    let depth = path
        .split('/')
        .filter(|c| !c.is_empty() && *c != ".")
        .count();
    if depth == 0 || (recursive && depth < 2) {
        return Err(invalid(format!(
            "suppression refusée par sécurité : {path}"
        )));
    }
    run_ok(server, &delete_script(path, recursive)).map(|_| ())
}

// ------------------------------------------------------------------ Transferts

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Direction {
    Upload,
    Download,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TransferStatus {
    Running,
    Done,
    Error,
    Cancelled,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferInfo {
    pub id: u64,
    pub server_id: i64,
    pub direction: Direction,
    pub name: String,
    pub remote_path: String,
    pub local_path: String,
    /// Taille attendue en octets (0 = inconnue).
    pub total: u64,
    pub transferred: u64,
    pub status: TransferStatus,
    pub error: Option<String>,
    pub started_at: i64,
}

struct Job {
    info: TransferInfo,
    child: Arc<Mutex<Option<Child>>>,
    cancel: Arc<AtomicBool>,
}

type Jobs = Arc<Mutex<HashMap<u64, Job>>>;

#[derive(Default)]
pub struct Transfers {
    jobs: Jobs,
    next_id: AtomicU64,
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Nom de fichier utilisable sous Windows.
pub fn sanitize_local_name(name: &str) -> String {
    let mut out: String = name
        .chars()
        .map(|c| {
            if c.is_control() || "<>:\"/\\|?*".contains(c) {
                '_'
            } else {
                c
            }
        })
        .collect();
    while out.ends_with(['.', ' ']) {
        out.pop();
    }
    let stem = out.split('.').next().unwrap_or("").to_ascii_uppercase();
    let reserved = ["CON", "PRN", "AUX", "NUL"].contains(&stem.as_str())
        || ((stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.len() == 4
            && stem.as_bytes()[3].is_ascii_digit());
    if out.is_empty() || reserved {
        out.insert(0, '_');
    }
    out
}

/// `dir/name`, ou `dir/name (1).ext`… si le fichier existe déjà.
fn unique_path(dir: &Path, name: &str) -> PathBuf {
    let first = dir.join(name);
    if !first.exists() {
        return first;
    }
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    (1..10_000)
        .map(|i| dir.join(format!("{stem} ({i}){ext}")))
        .find(|p| !p.exists())
        .unwrap_or(first)
}

fn spawn_ssh(server: &Server, script: &str, stdin: Stdio) -> AppResult<Child> {
    shell::command("ssh")
        .arg("-T")
        .args(ssh::base_args(server, true))
        .arg(sh(script))
        .stdin(stdin)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| invalid(format!("client ssh introuvable : {e}")))
}

fn read_stderr(stderr: Option<ChildStderr>) -> std::thread::JoinHandle<Vec<u8>> {
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(mut s) = stderr {
            let _ = s.read_to_end(&mut buf);
        }
        buf
    })
}

/// Attend la fin du processus sans garder le verrou (pour qu'une annulation puisse le tuer).
fn wait_child(child: &Mutex<Option<Child>>) -> Option<std::process::ExitStatus> {
    loop {
        let mut guard = child.lock().ok()?;
        let c = guard.as_mut()?;
        match c.try_wait() {
            Ok(Some(status)) => {
                guard.take();
                return Some(status);
            }
            Ok(None) => {}
            Err(_) => return None,
        }
        drop(guard);
        std::thread::sleep(Duration::from_millis(30));
    }
}

/// Contexte partagé par le fil d'exécution d'un transfert.
struct Ctx {
    app: AppHandle,
    jobs: Jobs,
    id: u64,
    progress: Arc<AtomicU64>,
    cancel: Arc<AtomicBool>,
    child: Arc<Mutex<Option<Child>>>,
}

impl Ctx {
    fn update(&self, f: impl FnOnce(&mut TransferInfo)) {
        let snapshot = {
            let Ok(mut jobs) = self.jobs.lock() else {
                return;
            };
            let Some(job) = jobs.get_mut(&self.id) else {
                return;
            };
            job.info.transferred = self.progress.load(Ordering::Relaxed);
            f(&mut job.info);
            job.info.clone()
        };
        let _ = self.app.emit(EVENT_TRANSFER, &snapshot);
    }

    fn kill(&self) {
        if let Ok(mut guard) = self.child.lock()
            && let Some(c) = guard.as_mut()
        {
            let _ = c.kill();
        }
    }

    /// Fin du transfert : état final selon l'annulation, le code de sortie et l'erreur locale.
    fn finish(
        &self,
        status: Option<std::process::ExitStatus>,
        stderr: &[u8],
        local_err: Option<String>,
    ) -> bool {
        let cancelled = self.cancel.load(Ordering::Relaxed);
        let ok = !cancelled && local_err.is_none() && status.map(|s| s.success()).unwrap_or(false);
        self.update(|info| {
            if cancelled {
                info.status = TransferStatus::Cancelled;
            } else if ok {
                info.status = TransferStatus::Done;
                if info.total > 0 {
                    info.transferred = info.total.max(info.transferred);
                }
            } else {
                info.status = TransferStatus::Error;
                info.error = Some(
                    local_err.unwrap_or_else(|| failure(stderr, status.and_then(|s| s.code()))),
                );
            }
        });
        ok
    }
}

const CHUNK: usize = 64 * 1024;
const EMIT_EVERY: Duration = Duration::from_millis(200);

impl Transfers {
    pub fn list(&self) -> Vec<TransferInfo> {
        let mut v: Vec<TransferInfo> = self
            .jobs
            .lock()
            .map(|j| j.values().map(|j| j.info.clone()).collect())
            .unwrap_or_default();
        v.sort_by_key(|t| t.id);
        v
    }

    pub fn cancel(&self, id: u64) -> AppResult<()> {
        let jobs = self.jobs.lock()?;
        let job = jobs
            .get(&id)
            .ok_or_else(|| invalid(format!("transfert {id} inconnu")))?;
        job.cancel.store(true, Ordering::Relaxed);
        if let Some(child) = job.child.lock()?.as_mut() {
            let _ = child.kill();
        }
        Ok(())
    }

    /// Retire un transfert terminé de la liste (et tous les terminés si `id` vaut `None`).
    pub fn dismiss(&self, id: Option<u64>) -> AppResult<()> {
        self.jobs.lock()?.retain(|k, j| {
            j.info.status == TransferStatus::Running || id.is_some_and(|id| id != *k)
        });
        Ok(())
    }

    /// Arrête tous les transferts (fermeture de l'application).
    pub fn cancel_all(&self) {
        let ids: Vec<u64> = self
            .jobs
            .lock()
            .map(|j| j.keys().copied().collect())
            .unwrap_or_default();
        for id in ids {
            let _ = self.cancel(id);
        }
    }

    fn register(&self, app: &AppHandle, info: TransferInfo, child: Child) -> AppResult<Ctx> {
        let child = Arc::new(Mutex::new(Some(child)));
        let cancel = Arc::new(AtomicBool::new(false));
        let id = info.id;
        let _ = app.emit(EVENT_TRANSFER, &info);
        self.jobs.lock()?.insert(
            id,
            Job {
                info,
                child: child.clone(),
                cancel: cancel.clone(),
            },
        );
        Ok(Ctx {
            app: app.clone(),
            jobs: self.jobs.clone(),
            id,
            progress: Arc::new(AtomicU64::new(0)),
            cancel,
            child,
        })
    }

    fn new_info(
        &self,
        server: &Server,
        direction: Direction,
        name: String,
        remote: String,
        local: String,
        total: u64,
    ) -> TransferInfo {
        TransferInfo {
            id: self.next_id.fetch_add(1, Ordering::Relaxed) + 1,
            server_id: server.id,
            direction,
            name,
            remote_path: remote,
            local_path: local,
            total,
            transferred: 0,
            status: TransferStatus::Running,
            error: None,
            started_at: now_secs(),
        }
    }

    /// Télécharge le fichier distant `remote_path` dans le dossier local `dest_dir`.
    pub fn download(
        &self,
        app: &AppHandle,
        server: &Server,
        remote_path: &str,
        size: u64,
        dest_dir: &str,
    ) -> AppResult<TransferInfo> {
        validate_path(remote_path)?;
        let name = basename(remote_path);
        validate_name(name)?;
        let dir = Path::new(dest_dir);
        if !dir.is_absolute() || !dir.is_dir() {
            return Err(invalid(format!(
                "dossier de destination introuvable : {dest_dir}"
            )));
        }
        let local_name = sanitize_local_name(name);
        let target = unique_path(dir, &local_name);
        let part = dir.join(format!(
            "{}.part",
            target.file_name().unwrap_or_default().to_string_lossy()
        ));
        let mut file = File::create(&part)?;

        let mut child = match spawn_ssh(
            server,
            &format!("cat -- {}", quote(remote_path)),
            Stdio::null(),
        ) {
            Ok(c) => c,
            Err(e) => {
                drop(file);
                let _ = std::fs::remove_file(&part);
                return Err(e);
            }
        };
        let mut stdout = child.stdout.take().expect("stdout");
        let stderr = read_stderr(child.stderr.take());
        let info = self.new_info(
            server,
            Direction::Download,
            name.to_string(),
            remote_path.to_string(),
            target.display().to_string(),
            size,
        );
        let ctx = self.register(app, info.clone(), child)?;

        std::thread::spawn(move || {
            let mut buf = vec![0u8; CHUNK];
            let mut last = Instant::now();
            let mut local_err = None;
            loop {
                match stdout.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        if let Err(e) = file.write_all(&buf[..n]) {
                            local_err = Some(format!("écriture locale impossible : {e}"));
                            ctx.kill();
                            break;
                        }
                        ctx.progress.fetch_add(n as u64, Ordering::Relaxed);
                        if last.elapsed() >= EMIT_EVERY {
                            last = Instant::now();
                            ctx.update(|_| {});
                        }
                    }
                    Err(_) => break,
                }
            }
            if local_err.is_none()
                && let Err(e) = file.flush()
            {
                local_err = Some(format!("écriture locale impossible : {e}"));
            }
            drop(file);
            let status = wait_child(&ctx.child);
            let err_bytes = stderr.join().unwrap_or_default();
            // Pas de renommage si une annulation est arrivée entre-temps.
            let rename_err = if !ctx.cancel.load(Ordering::Relaxed)
                && local_err.is_none()
                && status.is_some_and(|s| s.success())
            {
                let dest = if target.exists() {
                    unique_path(target.parent().unwrap_or(Path::new(".")), &local_name)
                } else {
                    target.clone()
                };
                std::fs::rename(&part, &dest)
                    .err()
                    .map(|e| format!("renommage du fichier téléchargé impossible : {e}"))
            } else {
                None
            };
            let ok = ctx.finish(status, &err_bytes, local_err.or(rename_err));
            if !ok {
                let _ = std::fs::remove_file(&part);
            }
        });
        Ok(info)
    }

    /// Envoie le fichier local `local_path` dans le dossier distant `remote_dir` (écrase s'il existe).
    pub fn upload(
        &self,
        app: &AppHandle,
        server: &Server,
        local_path: &str,
        remote_dir: &str,
    ) -> AppResult<TransferInfo> {
        validate_path(remote_dir)?;
        let local = Path::new(local_path);
        let meta = std::fs::metadata(local)
            .map_err(|_| invalid(format!("fichier introuvable : {local_path}")))?;
        if meta.is_dir() {
            return Err(invalid(format!(
                "les dossiers ne peuvent pas être envoyés : {local_path}"
            )));
        }
        let name = local
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or_else(|| invalid(format!("nom de fichier non pris en charge : {local_path}")))?
            .to_string();
        validate_name(&name)?;
        let target = join(remote_dir, &name);
        validate_path(&target)?;
        let size = meta.len();
        let mut file = File::open(local)?;

        let mut child = spawn_ssh(
            server,
            &upload_script(remote_dir, &name, size),
            Stdio::piped(),
        )?;
        let mut stdin = child.stdin.take().expect("stdin");
        // stdout non utilisé : vidé pour ne jamais bloquer le processus distant.
        let mut stdout = child.stdout.take().expect("stdout");
        std::thread::spawn(move || {
            let _ = std::io::copy(&mut stdout, &mut std::io::sink());
        });
        let stderr = read_stderr(child.stderr.take());
        let info = self.new_info(
            server,
            Direction::Upload,
            name,
            target,
            local_path.to_string(),
            size,
        );
        let ctx = self.register(app, info.clone(), child)?;

        std::thread::spawn(move || {
            let mut buf = vec![0u8; CHUNK];
            let mut last = Instant::now();
            let mut local_err = None;
            loop {
                if ctx.cancel.load(Ordering::Relaxed) {
                    break;
                }
                match file.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        // Échec d'écriture = processus ssh terminé : le code de sortie dira pourquoi.
                        if stdin.write_all(&buf[..n]).is_err() {
                            break;
                        }
                        ctx.progress.fetch_add(n as u64, Ordering::Relaxed);
                        if last.elapsed() >= EMIT_EVERY {
                            last = Instant::now();
                            ctx.update(|_| {});
                        }
                    }
                    Err(e) => {
                        local_err = Some(format!("lecture locale impossible : {e}"));
                        ctx.kill();
                        break;
                    }
                }
            }
            drop(stdin); // fin de flux : `cat` distant se termine.
            let status = wait_child(&ctx.child);
            let err_bytes = stderr.join().unwrap_or_default();
            ctx.finish(status, &err_bytes, local_err);
        });
        Ok(info)
    }
}

/// Écrit d'abord dans un fichier temporaire caché, vérifie la taille reçue, puis renomme :
/// un envoi interrompu ne laisse jamais un fichier tronqué sous le nom final.
fn upload_script(dir: &str, name: &str, size: u64) -> String {
    let part = join(dir, &format!(".{name}.devcenter-part"));
    format!(
        "cat > {p} && [ $(wc -c < {p}) -eq {size} ] && mv -f -- {p} {t} || {{ rm -f -- {p}; echo 'transfert incomplet' >&2; exit 1; }}",
        p = quote(&part),
        t = quote(&join(dir, name)),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_listing() {
        let mut raw = b"/home/deploy\0".to_vec();
        raw.extend_from_slice(b"f\tf\t1234\t1700000000.5000000000\t-rw-r--r--\tnotes.txt\0");
        raw.extend_from_slice(b"d\td\t4096\t1700000100.0\tdrwxr-xr-x\tapp\0");
        raw.extend_from_slice(b"l\td\t7\t1700000200.0\tlrwxrwxrwx\tcurrent\0");
        raw.extend_from_slice(b"l\tN\t5\t1700000300.0\tlrwxrwxrwx\tbroken\0");
        // Nom avec tabulation, retour à la ligne et espaces : le nom est le dernier champ.
        raw.extend_from_slice(b"f\tf\t0\t1700000400.0\t-rw-------\tweird\tname\nwith  spaces\0");
        raw.extend_from_slice(b"garbage\0");
        let l = parse_listing(&raw).unwrap();
        assert_eq!(l.path, "/home/deploy");
        assert_eq!(l.entries.len(), 5);
        // Dossiers (y compris liens vers un dossier) en premier, puis tri par nom.
        assert_eq!(l.entries[0].name, "app");
        assert_eq!(l.entries[1].name, "current");
        assert!(l.entries[1].is_dir);
        assert_eq!(l.entries[1].kind, EntryKind::Link);
        let notes = l.entries.iter().find(|e| e.name == "notes.txt").unwrap();
        assert_eq!(notes.size, 1234);
        assert_eq!(notes.modified, 1_700_000_000);
        assert_eq!(notes.path, "/home/deploy/notes.txt");
        assert_eq!(notes.mode, "-rw-r--r--");
        let broken = l.entries.iter().find(|e| e.name == "broken").unwrap();
        assert!(!broken.is_dir);
        assert!(
            l.entries
                .iter()
                .any(|e| e.name == "weird\tname\nwith  spaces")
        );
    }

    #[test]
    fn parses_root_and_empty_listing() {
        let l = parse_listing(b"/\0d\td\t4096\t1.0\tdrwxr-xr-x\tetc\0").unwrap();
        assert_eq!(l.entries[0].path, "/etc");
        assert!(parse_listing(b"/srv\0").unwrap().entries.is_empty());
        assert!(parse_listing(b"").is_err());
        assert!(parse_listing(b"bash: find: command not found\0").is_err());
    }

    #[test]
    fn validates_paths_and_names() {
        assert!(validate_path("/home/deploy/a b").is_ok());
        assert!(validate_path("/").is_ok());
        assert!(validate_path("-rf").is_err());
        assert!(validate_path("relative/path").is_err());
        assert!(validate_path("~/x").is_err());
        assert!(validate_path("/home/../etc").is_err());
        assert!(validate_path("/a\0b").is_err());
        assert!(validate_name("file.txt").is_ok());
        assert!(validate_name("-rf").is_ok()); // toujours utilisé derrière un chemin absolu
        assert!(validate_name("a/b").is_err());
        assert!(validate_name("..").is_err());
        assert!(validate_name("").is_err());
    }

    #[test]
    fn path_helpers() {
        assert_eq!(join("/", "etc"), "/etc");
        assert_eq!(join("/home/u", "x"), "/home/u/x");
        assert_eq!(parent("/home/u/x"), "/home/u");
        assert_eq!(parent("/etc"), "/");
        assert_eq!(parent("/"), "/");
        assert_eq!(basename("/home/u/file.txt"), "file.txt");
    }

    #[test]
    fn quotes_remote_scripts() {
        // Le script entier est cité pour le shell de connexion, chaque chemin pour `sh`.
        assert_eq!(sh("echo 'a'"), r#"sh -c 'echo '\''a'\'''"#);
        assert_eq!(
            delete_script("/tmp/it's; rm -rf ~", true),
            r"rm -rf -- '/tmp/it'\''s; rm -rf ~'"
        );
        assert_eq!(delete_script("/tmp/f", false), "rm -f -- '/tmp/f'");
        let s = list_script(Some("/srv/$(id)"));
        assert!(s.starts_with("cd -- '/srv/$(id)' && "));
        assert!(list_script(None).starts_with("printf"));
        let r = rename_script("/a/x", "/a/y`z`");
        assert!(r.contains("mv -- '/a/x' '/a/y`z`'"));
        let u = upload_script("/data", "r'port.pdf", 42);
        assert!(u.contains(r"cat > '/data/.r'\''port.pdf.devcenter-part'"));
        assert!(u.contains("-eq 42"));
        assert!(
            u.contains(r"mv -f -- '/data/.r'\''port.pdf.devcenter-part' '/data/r'\''port.pdf'")
        );
    }

    #[test]
    fn sanitizes_local_names() {
        assert_eq!(sanitize_local_name("a:b*c?.txt"), "a_b_c_.txt");
        assert_eq!(sanitize_local_name("con.txt"), "_con.txt");
        assert_eq!(sanitize_local_name("COM1"), "_COM1");
        assert_eq!(sanitize_local_name("trailing. "), "trailing");
        assert_eq!(sanitize_local_name("ok.tar.gz"), "ok.tar.gz");
    }
}
