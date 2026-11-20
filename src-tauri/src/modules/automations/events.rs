//! Déclencheurs sur événement : script planté, serveur (in)joignable, conteneur Docker arrêté,
//! changement Git et webhook local.
//!
//! Règles communes : une seule exécution simultanée par workflow (voir `trigger_with`) et au
//! plus une exécution déclenchée par un événement toutes les `MIN_EVENT_GAP` par workflow
//! (une rafale d'événements ne lance pas le workflow en boucle).
//!
//! Serveurs et conteneurs sont interrogés toutes les `POLL_EVERY`, uniquement s'ils sont
//! utilisés par une automatisation active ; seuls les changements d'état déclenchent (le premier
//! relevé sert de référence).

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};

use super::{Trigger, list, trigger_with};
use crate::error::{AppError, AppResult};
use crate::modules::servers::{self, Server};
use crate::state::AppState;

/// Délai minimal entre deux exécutions déclenchées par un événement, par automatisation.
pub const MIN_EVENT_GAP: Duration = Duration::from_secs(30);
/// Intervalle de surveillance des serveurs et conteneurs.
const POLL_EVERY: Duration = Duration::from_secs(60);

// ------------------------------------------------------------------ Commun

pub fn valid_token(token: &str) -> bool {
    (32..=128).contains(&token.len()) && token.chars().all(|c| c.is_ascii_hexdigit())
}

/// Jeton de webhook : 256 bits aléatoires en hexadécimal.
pub fn new_token() -> AppResult<String> {
    let mut buf = [0u8; 32];
    getrandom::fill(&mut buf).map_err(|e| AppError::InvalidInput(format!("générateur aléatoire indisponible : {e}")))?;
    Ok(hex::encode(buf))
}

/// Comparaison en temps constant (le jeton ne se devine pas caractère par caractère).
fn constant_eq(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Réserve un créneau d'exécution sur événement : faux si le workflow a déjà été déclenché par
/// un événement il y a moins de `MIN_EVENT_GAP`.
fn claim(state: &AppState, id: i64) -> bool {
    let Ok(mut last) = state.automations.last_event.lock() else { return false };
    let now = Instant::now();
    if last.get(&id).is_some_and(|t| now.duration_since(*t) < MIN_EVENT_GAP) {
        return false;
    }
    last.insert(id, now);
    true
}

/// Lance les workflows actifs dont le déclencheur correspond à l'événement.
fn fire(app: &AppHandle, context: &str, matches: impl Fn(&Trigger) -> bool) {
    let state = app.state::<AppState>();
    let Ok(all) = list(&state.db, &state.automations) else { return };
    for a in all.iter().filter(|a| a.enabled && !a.running && matches(&a.trigger)) {
        if claim(&state, a.id) {
            if let Err(e) = trigger_with(app, a.id, "event", Some(context.to_string())) {
                log::warn!("automatisation « {} » non déclenchée : {e}", a.name);
            }
        }
    }
}

/// Vrai si au moins une automatisation active utilise un déclencheur de ce type.
fn any_uses(app: &AppHandle, pred: impl Fn(&Trigger) -> bool) -> bool {
    let state = app.state::<AppState>();
    list(&state.db, &state.automations).is_ok_and(|all| all.iter().any(|a| a.enabled && pred(&a.trigger)))
}

fn project_name(app: &AppHandle, id: i64) -> String {
    super::steps::name_of(&app.state::<AppState>().db, "projects", id)
}

// ------------------------------------------------------------------ Scripts

/// Appelé par le runner quand un script se termine avec un code non nul (sans arrêt demandé).
pub fn on_script_failed(app: &AppHandle, project_id: i64, script: &str, exit_code: Option<i32>) {
    let app = app.clone();
    let script = script.to_string();
    std::thread::spawn(move || {
        let matches = |t: &Trigger| {
            matches!(t, Trigger::ScriptFailed { project_id: p, script: s }
                if p.is_none_or(|p| p == project_id) && (s.trim().is_empty() || s.trim() == script))
        };
        if !any_uses(&app, matches) {
            return;
        }
        let code = exit_code.map(|c| c.to_string()).unwrap_or_else(|| "?".into());
        let context = format!("{} › {script} (code {code})", project_name(&app, project_id));
        fire(&app, &context, matches);
    });
}

// ------------------------------------------------------------------ Git

/// Branche et commit courants d'un dépôt, lus directement dans `.git` (sans lancer `git`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct GitHead {
    /// `None` en HEAD détachée.
    pub branch: Option<String>,
    /// `None` sur une branche sans commit.
    pub commit: Option<String>,
}

fn relative_to(base: &Path, p: &str) -> PathBuf {
    let p = PathBuf::from(p.trim());
    if p.is_absolute() { p } else { base.join(p) }
}

impl GitHead {
    pub fn read(repo: &Path) -> Option<Self> {
        let dot = repo.join(".git");
        // Worktree ou sous-module : `.git` est un fichier « gitdir: … ».
        let git_dir = if dot.is_file() {
            let text = std::fs::read_to_string(&dot).ok()?;
            relative_to(repo, text.trim().strip_prefix("gitdir:")?)
        } else {
            dot
        };
        let common = std::fs::read_to_string(git_dir.join("commondir"))
            .ok()
            .map(|c| relative_to(&git_dir, &c))
            .unwrap_or_else(|| git_dir.clone());
        let head = std::fs::read_to_string(git_dir.join("HEAD")).ok()?;
        let head = head.trim();
        Some(match head.strip_prefix("ref:") {
            Some(r) => {
                let r = r.trim();
                Self { branch: Some(r.strip_prefix("refs/heads/").unwrap_or(r).to_string()), commit: resolve_ref(&git_dir, &common, r) }
            }
            None => Self { branch: None, commit: (!head.is_empty()).then(|| head.to_string()) },
        })
    }
}

fn resolve_ref(git_dir: &Path, common: &Path, r: &str) -> Option<String> {
    for dir in [git_dir, common] {
        if let Ok(s) = std::fs::read_to_string(dir.join(r)) {
            let s = s.trim();
            if !s.is_empty() {
                return Some(s.to_string());
            }
        }
    }
    let packed = std::fs::read_to_string(common.join("packed-refs")).ok()?;
    packed.lines().find_map(|l| {
        let (hash, name) = l.split_once(' ')?;
        (name.trim() == r).then(|| hash.to_string())
    })
}

/// Appelé par l'observateur Git quand la branche ou le commit courant d'un projet change.
pub fn on_git_change(app: &AppHandle, project_id: i64, before: &GitHead, after: &GitHead, subject: Option<String>) {
    let branch_changed = before.branch != after.branch;
    let commit_changed = !branch_changed && before.commit != after.commit && after.commit.is_some();
    if !branch_changed && !commit_changed {
        return;
    }
    let (app, before, after) = (app.clone(), before.clone(), after.clone());
    std::thread::spawn(move || {
        let matches = |t: &Trigger| {
            matches!(t, Trigger::GitChange { project_id: p, on_commit, on_branch }
                if p.is_none_or(|p| p == project_id) && ((branch_changed && *on_branch) || (commit_changed && *on_commit)))
        };
        if !any_uses(&app, matches) {
            return;
        }
        let project = project_name(&app, project_id);
        let branch = |b: &Option<String>| b.clone().unwrap_or_else(|| "HEAD détachée".into());
        let context = if branch_changed {
            format!("{project} : branche {} → {}", branch(&before.branch), branch(&after.branch))
        } else {
            let short: String = after.commit.as_deref().unwrap_or_default().chars().take(7).collect();
            let subject = subject.map(|s| format!(" {}", s.chars().take(120).collect::<String>())).unwrap_or_default();
            format!("{project} › {} : nouveau commit {short}{subject}", branch(&after.branch))
        };
        fire(&app, &context, matches);
    });
}

// ------------------------------------------------------------------ Webhook

/// `POST /hook/<token>` : lance le workflow correspondant. Erreur = (code HTTP, message).
pub fn webhook(app: &AppHandle, token: &str, peer: &str, body: &str) -> Result<i64, (u16, String)> {
    let unknown = || (404, "webhook inconnu".to_string());
    if !valid_token(token) {
        return Err(unknown());
    }
    let state = app.state::<AppState>();
    let all = list(&state.db, &state.automations).map_err(|_| (500, "erreur interne".to_string()))?;
    let a = all
        .into_iter()
        .find(|a| matches!(&a.trigger, Trigger::Webhook { token: t } if constant_eq(t, token)))
        .ok_or_else(unknown)?;
    if !a.enabled {
        return Err((409, "automatisation désactivée".into()));
    }
    if a.running {
        return Err((409, format!("« {} » est déjà en cours", a.name)));
    }
    if !claim(&state, a.id) {
        return Err((429, format!("déclenchée il y a moins de {} s : réessayez plus tard", MIN_EVENT_GAP.as_secs())));
    }
    let snippet: String = body.split_whitespace().collect::<Vec<_>>().join(" ").chars().filter(|c| !c.is_control()).take(200).collect();
    let context = if snippet.is_empty() { format!("appel depuis {peer}") } else { format!("appel depuis {peer} · {snippet}") };
    trigger_with(app, a.id, "webhook", Some(context)).map_err(|e| (409, e.to_string()))
}

// ------------------------------------------------------------------ Serveurs et conteneurs

/// Un conteneur qui tournait est considéré arrêté s'il n'est plus « running » (ni en pause),
/// ou s'il a disparu.
fn stopped(state: Option<&String>) -> bool {
    state.is_none_or(|s| s != "running" && s != "paused")
}

pub fn spawn_monitor(app: AppHandle) {
    std::thread::Builder::new()
        .name("automation-monitor".into())
        .spawn(move || {
            std::thread::sleep(Duration::from_secs(20));
            let mut reachable: HashMap<i64, bool> = HashMap::new();
            // serveur → nom du conteneur → état
            let mut containers: HashMap<i64, HashMap<String, String>> = HashMap::new();
            loop {
                poll(&app, &mut reachable, &mut containers);
                std::thread::sleep(POLL_EVERY);
            }
        })
        .expect("thread de surveillance des automatisations");
}

fn poll(app: &AppHandle, reachable: &mut HashMap<i64, bool>, containers: &mut HashMap<i64, HashMap<String, String>>) {
    let state = app.state::<AppState>();
    let Ok(all) = list(&state.db, &state.automations) else { return };
    let mut ping_all = false;
    let mut ping: HashSet<i64> = HashSet::new();
    let mut docker: HashSet<i64> = HashSet::new();
    for a in all.iter().filter(|a| a.enabled) {
        match &a.trigger {
            Trigger::ServerDown { server_id } | Trigger::ServerUp { server_id } => match server_id {
                Some(id) => {
                    ping.insert(*id);
                }
                None => ping_all = true,
            },
            Trigger::ContainerStopped { server_id, .. } => {
                docker.insert(*server_id);
            }
            _ => {}
        }
    }
    // Plus utilisés : l'état est oublié (le prochain relevé resservira de référence).
    reachable.retain(|id, _| ping_all || ping.contains(id));
    containers.retain(|id, _| docker.contains(id));
    if !ping_all && ping.is_empty() && docker.is_empty() {
        return;
    }
    let Ok(servers) = servers::list(&state.db) else { return };

    let targets: Vec<&Server> = servers.iter().filter(|s| ping_all || ping.contains(&s.id)).collect();
    // Pings en parallèle : un serveur muet (12 s de délai) ne retarde pas les autres.
    let results: Vec<(&Server, Result<u64, String>)> = std::thread::scope(|scope| {
        let handles: Vec<_> = targets
            .iter()
            .map(|s| (*s, scope.spawn(move || servers::remote::ping(s).map_err(|e| e.to_string()))))
            .collect();
        handles.into_iter().map(|(s, h)| (s, h.join().unwrap_or_else(|_| Err("erreur interne".into())))).collect()
    });
    for (server, result) in results {
        let up = result.is_ok();
        let previous = reachable.insert(server.id, up);
        if previous.is_none_or(|p| p == up) {
            continue;
        }
        let id = server.id;
        if up {
            let latency = result.as_ref().map(|ms| format!(" ({ms} ms)")).unwrap_or_default();
            fire(app, &format!("{} joignable{latency}", server.name), |t| {
                matches!(t, Trigger::ServerUp { server_id } if server_id.is_none_or(|s| s == id))
            });
        } else {
            let reason = result.err().unwrap_or_default();
            fire(app, &format!("{} injoignable : {reason}", server.name), |t| {
                matches!(t, Trigger::ServerDown { server_id } if server_id.is_none_or(|s| s == id))
            });
        }
    }

    for id in docker {
        let Some(server) = servers.iter().find(|s| s.id == id) else { continue };
        // Serveur injoignable : on garde l'état précédent (comparé au prochain relevé réussi).
        let Ok(list) = servers::remote::containers(server) else { continue };
        let now: HashMap<String, String> = list.into_iter().map(|c| (c.name, c.state)).collect();
        if let Some(previous) = containers.get(&id) {
            for (name, st) in previous {
                if st != "running" || !stopped(now.get(name)) {
                    continue;
                }
                let new_state = now.get(name).cloned().unwrap_or_else(|| "supprimé".into());
                let context = format!("{} › {name} ({new_state})", server.name);
                fire(app, &context, |t| {
                    matches!(t, Trigger::ContainerStopped { server_id, container }
                        if *server_id == id && (container.trim().is_empty() || container.trim() == name))
                });
            }
        }
        containers.insert(id, now);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens() {
        let t = new_token().unwrap();
        assert_eq!(t.len(), 64);
        assert!(valid_token(&t));
        assert!(!valid_token("abc"));
        assert!(!valid_token(&"z".repeat(40)));
    }

    #[test]
    fn reads_git_head() {
        let dir = std::env::temp_dir().join(format!("devcenter-head-{}", std::process::id()));
        let git = dir.join(".git");
        std::fs::create_dir_all(git.join("refs").join("heads").join("feat")).unwrap();
        std::fs::write(git.join("HEAD"), "ref: refs/heads/feat/x\n").unwrap();
        assert_eq!(GitHead::read(&dir), Some(GitHead { branch: Some("feat/x".into()), commit: None }));
        std::fs::write(git.join("packed-refs"), "# pack-refs\nabc123 refs/heads/feat/x\n").unwrap();
        assert_eq!(GitHead::read(&dir).unwrap().commit.as_deref(), Some("abc123"));
        std::fs::write(git.join("refs").join("heads").join("feat").join("x"), "def456\n").unwrap();
        assert_eq!(GitHead::read(&dir).unwrap().commit.as_deref(), Some("def456"));
        std::fs::write(git.join("HEAD"), "0123abcd\n").unwrap();
        assert_eq!(GitHead::read(&dir), Some(GitHead { branch: None, commit: Some("0123abcd".into()) }));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn container_stop_detection() {
        assert!(stopped(None));
        assert!(stopped(Some(&"exited".to_string())));
        assert!(!stopped(Some(&"running".to_string())));
        assert!(!stopped(Some(&"paused".to_string())));
    }
}
