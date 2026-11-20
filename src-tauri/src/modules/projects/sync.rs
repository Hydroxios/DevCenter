//! Synchronisation Git : `fetch`, `pull` (avance rapide par défaut), remises (`stash`) et
//! récupération périodique en arrière-plan pour garder les compteurs ↑/↓ à jour.
//!
//! Les commandes réseau ne sont jamais interactives : pas de terminal (`GIT_TERMINAL_PROMPT=0`),
//! entrée standard fermée et délai maximal. En arrière-plan, aucune fenêtre d'identification
//! (Git Credential Manager, phrase de passe SSH) ne doit s'ouvrir : le fetch échoue en silence.

use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::error::{AppError, AppResult};
use crate::modules::shell;
use crate::state::AppState;

/// Délai maximal d'un fetch / pull lancé par l'utilisateur.
const MANUAL_TIMEOUT: Duration = Duration::from_secs(180);
/// Délai maximal d'un fetch d'arrière-plan.
const BACKGROUND_TIMEOUT: Duration = Duration::from_secs(60);
/// Premier passage du fetch périodique après le lancement de l'app.
const STARTUP_DELAY: Duration = Duration::from_secs(90);
/// Fréquence à laquelle le planificateur regarde s'il y a des dépôts à récupérer.
const TICK: Duration = Duration::from_secs(30);
/// Pause entre deux fetchs d'arrière-plan (un seul à la fois, jamais en rafale).
const GAP: Duration = Duration::from_secs(3);

// ---------------------------------------------------------------- Exécution

#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    /// Lancé par l'utilisateur : le gestionnaire d'identifiants peut afficher sa fenêtre.
    Manual,
    /// Arrière-plan : aucune invite, aucune fenêtre.
    Quiet,
}

fn base(dir: &Path) -> Command {
    let mut cmd = shell::command("git");
    cmd.args(["-c", "core.quotepath=off", "-C"]).arg(dir);
    cmd.stdin(Stdio::null())
        .env("GIT_TERMINAL_PROMPT", "0")
        // Messages de git en anglais : les erreurs sont reconnues puis traduites.
        .env("LC_ALL", "C")
        .env("LANGUAGE", "en");
    cmd
}

fn configure_quiet(dir: &Path, cmd: &mut Command) {
    cmd.args(["-c", "credential.interactive=false"])
        // Git Credential Manager : identifiants enregistrés seulement, jamais de fenêtre.
        .env("GCM_INTERACTIVE", "never")
        .env("SSH_ASKPASS_REQUIRE", "never");
    // SSH sans invite (phrase de passe, empreinte d'hôte inconnue), sauf commande SSH personnalisée.
    let custom = std::env::var_os("GIT_SSH").is_some()
        || std::env::var_os("GIT_SSH_COMMAND").is_some()
        || run(dir, &["config", "--get", "core.sshCommand"]).is_ok_and(|s| !s.trim().is_empty());
    if !custom {
        cmd.env(
            "GIT_SSH_COMMAND",
            "ssh -o BatchMode=yes -o ConnectTimeout=15",
        );
    }
}

/// Lance une commande réseau avec délai maximal ; le processus est tué s'il le dépasse.
fn run_network(dir: &Path, args: &[&str], mode: Mode) -> AppResult<Output> {
    let mut cmd = base(dir);
    if mode == Mode::Quiet {
        configure_quiet(dir, &mut cmd);
    }
    let mut child = cmd
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    // Les sorties sont lues dans des threads : un tampon plein bloquerait git.
    let mut out_pipe = child.stdout.take();
    let mut err_pipe = child.stderr.take();
    let out_t = std::thread::spawn(move || {
        let mut v = Vec::new();
        if let Some(p) = out_pipe.as_mut() {
            let _ = p.read_to_end(&mut v);
        }
        v
    });
    let err_t = std::thread::spawn(move || {
        let mut v = Vec::new();
        if let Some(p) = err_pipe.as_mut() {
            let _ = p.read_to_end(&mut v);
        }
        v
    });
    let timeout = if mode == Mode::Quiet {
        BACKGROUND_TIMEOUT
    } else {
        MANUAL_TIMEOUT
    };
    let start = Instant::now();
    let status = loop {
        if let Some(s) = child.try_wait()? {
            break s;
        }
        if start.elapsed() > timeout {
            let _ = child.kill();
            let _ = child.wait();
            return Err(AppError::InvalidInput(format!(
                "le dépôt distant ne répond pas (délai de {} s dépassé)",
                timeout.as_secs()
            )));
        }
        std::thread::sleep(Duration::from_millis(100));
    };
    Ok(Output {
        status,
        stdout: out_t.join().unwrap_or_default(),
        stderr: err_t.join().unwrap_or_default(),
    })
}

fn combined(out: &Output) -> String {
    format!(
        "{}\n{}",
        String::from_utf8_lossy(&out.stderr),
        String::from_utf8_lossy(&out.stdout)
    )
}

/// Message brut de git, sans les lignes d'aide.
fn raw_error(text: &str) -> String {
    let msg: Vec<&str> = text
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with("hint:"))
        .collect();
    if msg.is_empty() {
        "commande git en échec".into()
    } else {
        msg.join("\n")
    }
}

fn run(dir: &Path, args: &[&str]) -> AppResult<String> {
    let out = base(dir).args(args).output()?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        Err(AppError::InvalidInput(raw_error(&combined(&out))))
    }
}

fn has_remote(dir: &Path) -> AppResult<bool> {
    Ok(run(dir, &["remote"])?.lines().any(|l| !l.trim().is_empty()))
}

/// Explication en français des échecs réseau courants (identification, hôte injoignable).
fn network_error(text: &str) -> Option<&'static str> {
    let t = text.to_ascii_lowercase();
    if t.contains("authentication failed")
        || t.contains("could not read username")
        || t.contains("could not read password")
        || t.contains("permission denied (publickey")
        || t.contains("terminal prompts disabled")
    {
        Some(
            "identification refusée par le dépôt distant : vérifiez vos identifiants Git (ou votre clé SSH)",
        )
    } else if t.contains("could not resolve host")
        || t.contains("unable to access")
        || t.contains("connection timed out")
    {
        Some("dépôt distant injoignable : vérifiez la connexion réseau")
    } else if t.contains("repository not found")
        || t.contains("does not appear to be a git repository")
    {
        Some("dépôt distant introuvable (adresse incorrecte ou accès refusé)")
    } else {
        None
    }
}

// ---------------------------------------------------------------- Suivi des fetchs

#[derive(Default)]
struct Tracker {
    last: HashMap<PathBuf, Instant>,
    busy: HashSet<PathBuf>,
}

fn tracker() -> &'static Mutex<Tracker> {
    static T: OnceLock<Mutex<Tracker>> = OnceLock::new();
    T.get_or_init(Default::default)
}

/// Réserve le dépôt pour une opération réseau ; libéré à la fin (même en cas d'erreur).
struct Busy(PathBuf);

impl Busy {
    fn acquire(dir: &Path) -> Option<Self> {
        let mut t = tracker().lock().ok()?;
        t.busy
            .insert(dir.to_path_buf())
            .then(|| Busy(dir.to_path_buf()))
    }
}

impl Drop for Busy {
    fn drop(&mut self) {
        if let Ok(mut t) = tracker().lock() {
            t.busy.remove(&self.0);
        }
    }
}

fn mark_fetched(dir: &Path) {
    if let Ok(mut t) = tracker().lock() {
        t.last.insert(dir.to_path_buf(), Instant::now());
    }
}

// ---------------------------------------------------------------- Fetch / pull

fn fetch_inner(dir: &Path, mode: Mode) -> AppResult<()> {
    if !has_remote(dir)? {
        return Err(AppError::InvalidInput(
            "aucun dépôt distant configuré (git remote add origin …)".into(),
        ));
    }
    let out = run_network(dir, &["fetch", "--prune", "--no-progress"], mode)?;
    mark_fetched(dir);
    if out.status.success() {
        return Ok(());
    }
    let text = combined(&out);
    Err(AppError::InvalidInput(
        network_error(&text)
            .map(String::from)
            .unwrap_or_else(|| raw_error(&text)),
    ))
}

/// `git fetch --prune` du dépôt distant de la branche courante (ou `origin`).
pub fn fetch(dir: &Path) -> AppResult<()> {
    let _busy = Busy::acquire(dir)
        .ok_or_else(|| AppError::InvalidInput("une récupération est déjà en cours".into()))?;
    fetch_inner(dir, Mode::Manual)
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PullMode {
    /// Avance rapide uniquement : échoue proprement si les branches ont divergé.
    #[default]
    FfOnly,
    Rebase,
    Merge,
}

/// Traduit l'échec d'un `git pull`.
fn pull_error(text: &str, mode: PullMode, upstream: &str) -> String {
    let t = text.to_ascii_lowercase();
    if let Some(net) = network_error(text) {
        return net.into();
    }
    if t.contains("would be overwritten") || t.contains("please commit your changes or stash them")
    {
        return "des modifications locales seraient écrasées : committez-les ou mettez-les de côté (remise) avant de récupérer".into();
    }
    if t.contains("unstaged changes") || t.contains("uncommitted changes") {
        return "le rebase exige un arbre de travail propre : committez vos modifications ou mettez-les de côté (remise)".into();
    }
    if t.contains("you have unmerged files")
        || t.contains("unmerged files")
        || t.contains("not concluded your merge")
    {
        return "des conflits ne sont pas résolus dans le dépôt : terminez ou annulez la fusion en cours avant de récupérer".into();
    }
    if t.contains("conflict") {
        return match mode {
            PullMode::Rebase => "conflits pendant le rebase : résolvez-les dans l'éditeur puis lancez `git rebase --continue` (ou `git rebase --abort` pour annuler)".into(),
            _ => "conflits pendant la fusion : résolvez-les dans l'éditeur puis committez (ou `git merge --abort` pour annuler)".into(),
        };
    }
    if t.contains("not possible to fast-forward")
        || t.contains("diverging branches")
        || t.contains("have diverged")
    {
        return format!(
            "avance rapide impossible : la branche locale et {upstream} ont divergé (des commits de chaque côté). Choisissez une fusion ou un rebase."
        );
    }
    raw_error(text)
}

/// `git pull` de la branche suivie ; avance rapide uniquement par défaut.
pub fn pull(dir: &Path, mode: PullMode) -> AppResult<()> {
    run(dir, &["symbolic-ref", "--quiet", "--short", "HEAD"]).map_err(|_| {
        AppError::InvalidInput("HEAD détachée : basculez sur une branche pour récupérer".into())
    })?;
    let upstream = run(
        dir,
        &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    )
    .map_err(|_| {
        AppError::InvalidInput("la branche courante ne suit aucune branche distante".into())
    })?;
    let upstream = upstream.trim().to_string();
    let _busy = Busy::acquire(dir)
        .ok_or_else(|| AppError::InvalidInput("une récupération est déjà en cours".into()))?;
    let flag = match mode {
        PullMode::FfOnly => "--ff-only",
        PullMode::Rebase => "--rebase",
        PullMode::Merge => "--no-rebase",
    };
    // Fusion : message par défaut, sans éditeur.
    let out = run_network(
        dir,
        &["-c", "core.editor=true", "pull", flag, "--no-progress"],
        Mode::Manual,
    )?;
    mark_fetched(dir);
    if out.status.success() {
        Ok(())
    } else {
        Err(AppError::InvalidInput(pull_error(
            &combined(&out),
            mode,
            &upstream,
        )))
    }
}

// ---------------------------------------------------------------- Remises (stash)

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StashEntry {
    /// Position dans la pile (`stash@{index}`), au moment de la lecture.
    pub index: u32,
    /// Identifiant stable : les opérations visent ce commit, pas la position.
    pub hash: String,
    /// Horodatage Unix.
    pub timestamp: i64,
    /// Branche sur laquelle la remise a été créée.
    pub branch: Option<String>,
    pub message: String,
}

pub fn stash_list(dir: &Path) -> AppResult<Vec<StashEntry>> {
    Ok(parse_stash_list(&run(
        dir,
        &["stash", "list", "--format=%gd%x1f%H%x1f%ct%x1f%gs"],
    )?))
}

fn parse_stash_list(text: &str) -> Vec<StashEntry> {
    text.lines()
        .filter_map(|line| {
            let parts: Vec<&str> = line.split('\u{1f}').collect();
            let [refname, hash, ts, subject] = parts[..] else {
                return None;
            };
            let index = refname
                .strip_prefix("stash@{")?
                .strip_suffix('}')?
                .parse()
                .ok()?;
            let (branch, message) = parse_stash_subject(subject);
            Some(StashEntry {
                index,
                hash: hash.to_string(),
                timestamp: ts.parse().unwrap_or(0),
                branch,
                message,
            })
        })
        .collect()
}

/// `WIP on main: abc1234 sujet` (sans message) ou `On main: message`.
fn parse_stash_subject(subject: &str) -> (Option<String>, String) {
    let rest = subject
        .strip_prefix("WIP on ")
        .or_else(|| subject.strip_prefix("On "));
    let Some((branch, msg)) = rest.and_then(|r| r.split_once(": ")) else {
        return (None, subject.to_string());
    };
    let branch = (branch != "(no branch)").then(|| branch.to_string());
    (branch, msg.to_string())
}

/// Position actuelle de la remise `hash` (la pile a pu bouger depuis l'affichage).
fn stash_ref(dir: &Path, hash: &str) -> AppResult<String> {
    if hash.is_empty() || !hash.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(AppError::InvalidInput("remise invalide".into()));
    }
    stash_list(dir)?
        .into_iter()
        .find(|s| s.hash.eq_ignore_ascii_case(hash))
        .map(|s| format!("stash@{{{}}}", s.index))
        .ok_or_else(|| AppError::InvalidInput("cette remise n'existe plus".into()))
}

/// Met de côté les modifications (non suivies comprises si demandé).
pub fn stash_push(dir: &Path, message: Option<&str>, include_untracked: bool) -> AppResult<()> {
    let mut args = vec!["stash", "push"];
    if include_untracked {
        args.push("--include-untracked");
    }
    let message = message.map(str::trim).filter(|m| !m.is_empty());
    if let Some(m) = message {
        args.extend(["-m", m]);
    }
    let out = run(dir, &args)?;
    if out.contains("No local changes to save") {
        return Err(AppError::InvalidInput(
            "aucune modification à mettre de côté".into(),
        ));
    }
    Ok(())
}

fn apply_error(text: &str, kept: bool) -> String {
    let t = text.to_ascii_lowercase();
    if t.contains("would be overwritten") || t.contains("already exists, no checkout") {
        return "des modifications locales seraient écrasées : committez-les ou mettez-les de côté avant d'appliquer cette remise".into();
    }
    if t.contains("conflict") {
        return if kept {
            "remise appliquée avec des conflits : résolvez-les dans l'éditeur. La remise est conservée.".into()
        } else {
            "remise appliquée avec des conflits : résolvez-les dans l'éditeur.".into()
        };
    }
    raw_error(text)
}

fn stash_apply_like(dir: &Path, hash: &str, op: &str) -> AppResult<()> {
    let r = stash_ref(dir, hash)?;
    let out = base(dir).args(["stash", op, &r]).output()?;
    if out.status.success() {
        Ok(())
    } else {
        // `pop` en conflit garde la remise ; `apply` la garde toujours.
        Err(AppError::InvalidInput(apply_error(&combined(&out), true)))
    }
}

pub fn stash_apply(dir: &Path, hash: &str) -> AppResult<()> {
    stash_apply_like(dir, hash, "apply")
}

pub fn stash_pop(dir: &Path, hash: &str) -> AppResult<()> {
    stash_apply_like(dir, hash, "pop")
}

pub fn stash_drop(dir: &Path, hash: &str) -> AppResult<()> {
    let r = stash_ref(dir, hash)?;
    run(dir, &["stash", "drop", &r]).map(|_| ())
}

// ---------------------------------------------------------------- Fetch périodique

/// Planificateur du fetch d'arrière-plan : un dépôt à la fois, chacun au plus une fois par
/// intervalle (réglage `gitFetchInterval`, en minutes ; 0 = désactivé). Le statut Git est
/// relu après chaque fetch et poussé à l'interface.
pub fn spawn_fetch_scheduler(app: AppHandle) {
    std::thread::Builder::new()
        .name("devcenter-git-fetch".into())
        .spawn(move || {
            std::thread::sleep(STARTUP_DELAY);
            loop {
                background_pass(&app);
                std::thread::sleep(TICK);
            }
        })
        .ok();
}

fn background_pass(app: &AppHandle) {
    let state = app.state::<AppState>();
    let minutes = state.settings.git_fetch_interval();
    if minutes == 0 {
        return;
    }
    let interval = Duration::from_secs(u64::from(minutes) * 60);
    let Ok(projects) = super::list(&state.db) else {
        return;
    };
    let mut due: Vec<(i64, PathBuf, Option<Instant>)> = {
        let Ok(t) = tracker().lock() else { return };
        projects
            .into_iter()
            .filter(|p| p.exists && Path::new(&p.path).join(".git").exists())
            .map(|p| {
                let path = PathBuf::from(p.path);
                let last = t.last.get(&path).copied();
                (p.id, path, last)
            })
            .filter(|(_, path, last)| {
                !t.busy.contains(path) && last.is_none_or(|l| l.elapsed() >= interval)
            })
            .collect()
    };
    // Les plus anciens d'abord (jamais récupérés en tête).
    due.sort_by_key(|(_, _, last)| *last);
    for (id, path, _) in due {
        // Le réglage a pu changer pendant le passage.
        if state.settings.git_fetch_interval() == 0 {
            return;
        }
        let Some(_busy) = Busy::acquire(&path) else {
            continue;
        };
        match fetch_inner(&path, Mode::Quiet) {
            Ok(()) => super::watcher::push_status(app, id, &path),
            Err(e) => log::debug!("fetch d'arrière-plan de {} : {e}", path.display()),
        }
        // Sans dépôt distant, `fetch_inner` échoue avant `mark_fetched` : ne pas réessayer à chaque passage.
        mark_fetched(&path);
        drop(_busy);
        std::thread::sleep(GAP);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_stash_list() {
        let s = parse_stash_list(
            "stash@{0}\u{1f}aaa111\u{1f}200\u{1f}On main: avant refacto\n\
             stash@{1}\u{1f}bbb222\u{1f}100\u{1f}WIP on feature/x: 1a2b3c4 ajoute le login\n\
             stash@{2}\u{1f}ccc333\u{1f}50\u{1f}WIP on (no branch): 9f8e7d6 détachée\n\
             ligne invalide\n",
        );
        assert_eq!(s.len(), 3);
        assert_eq!(
            s[0],
            StashEntry {
                index: 0,
                hash: "aaa111".into(),
                timestamp: 200,
                branch: Some("main".into()),
                message: "avant refacto".into()
            }
        );
        assert_eq!(s[1].branch.as_deref(), Some("feature/x"));
        assert_eq!(s[1].message, "1a2b3c4 ajoute le login");
        assert_eq!(s[2].index, 2);
        assert_eq!(s[2].branch, None);
    }

    #[test]
    fn parses_unknown_stash_subject() {
        assert_eq!(
            parse_stash_subject("autre chose"),
            (None, "autre chose".into())
        );
        assert_eq!(
            parse_stash_subject("On dev: a: b"),
            (Some("dev".into()), "a: b".into())
        );
    }

    #[test]
    fn translates_pull_errors() {
        let diverged = "hint: Diverging branches can't be fast-forwarded\nfatal: Not possible to fast-forward, aborting.";
        assert!(pull_error(diverged, PullMode::FfOnly, "origin/main").contains("divergé"));
        let dirty = "error: Your local changes to the following files would be overwritten by merge:\n\ta.txt";
        assert!(pull_error(dirty, PullMode::FfOnly, "origin/main").contains("écrasées"));
        let conflict = "CONFLICT (content): Merge conflict in a.txt\nAutomatic merge failed";
        assert!(pull_error(conflict, PullMode::Merge, "origin/main").contains("merge --abort"));
        assert!(
            pull_error(conflict, PullMode::Rebase, "origin/main").contains("rebase --continue")
        );
        let auth =
            "fatal: could not read Username for 'https://github.com': terminal prompts disabled";
        assert!(pull_error(auth, PullMode::FfOnly, "origin/main").contains("identification"));
    }

    #[test]
    fn rejects_bad_stash_hash() {
        let dir = std::env::temp_dir();
        assert!(stash_ref(&dir, "").is_err());
        assert!(stash_ref(&dir, "--all").is_err());
    }
}
