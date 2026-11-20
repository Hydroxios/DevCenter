//! Statut Git poussé à l'interface : un observateur de fichiers suit chaque dépôt enregistré et,
//! quand l'arbre de travail ou les métadonnées Git changent (édition, commit, checkout, fetch…),
//! relit le statut et l'envoie (`projects://git`) seulement s'il a changé.
//!
//! Les rafales d'événements (sauvegarde d'un éditeur, `git pull`) sont regroupées : le statut est
//! relu une fois l'activité retombée, et au plus une fois toutes les `MIN_INTERVAL` par dépôt
//! (un build qui écrit en continu ne relance pas `git status` en boucle).

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use super::git::GitStatus;
use super::gitcache;
use crate::modules::automations::{self, GitHead};
use crate::state::AppState;

pub const EVENT_GIT: &str = "projects://git";

/// Activité retombée depuis ce délai : le statut peut être relu.
const QUIET: Duration = Duration::from_millis(400);
/// Intervalle minimal entre deux relectures d'un même dépôt.
const MIN_INTERVAL: Duration = Duration::from_millis(1500);
const TICK: Duration = Duration::from_millis(200);

/// Dossiers dont les changements n'affectent pas le statut (ignorés par Git en pratique) ou
/// produisent un flot d'événements (dépendances, sorties de build).
const IGNORED_DIRS: &[&str] = &[
    "node_modules",
    "target",
    "dist",
    "build",
    "out",
    ".gradle",
    ".next",
    ".nuxt",
    ".turbo",
    ".cache",
    ".svelte-kit",
    ".parcel-cache",
    "coverage",
    "__pycache__",
    ".venv",
    "venv",
    ".idea",
];

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct GitEvent {
    id: i64,
    git: Option<GitStatus>,
}

struct Repo {
    id: i64,
    path: PathBuf,
    /// Dernier événement reçu, si une relecture est en attente.
    dirty_since: Option<Instant>,
    last_read: Option<Instant>,
    last_sent: Option<Option<GitStatus>>,
    /// Branche et commit courants (automatisations « changement Git »).
    head: Option<GitHead>,
}

#[derive(Default)]
struct Inner {
    watcher: Option<RecommendedWatcher>,
    repos: Vec<Repo>,
}

/// Observateur partagé (dans `AppState`). Inactif tant que `start` n'a pas été appelé.
#[derive(Default)]
pub struct GitWatcher {
    inner: Arc<Mutex<Inner>>,
}

/// Vrai si le changement peut modifier le statut Git du dépôt `root`.
fn relevant(root: &Path, path: &Path) -> bool {
    let Ok(rel) = path.strip_prefix(root) else {
        return false;
    };
    let mut parts = rel.components().filter_map(|c| match c {
        Component::Normal(s) => s.to_str(),
        _ => None,
    });
    match parts.next() {
        None => false,
        // Dans `.git` : seuls l'index, HEAD et les refs comptent (pas les objets, journaux ni verrous).
        Some(".git") => {
            let rest: Vec<&str> = parts.collect();
            match rest.as_slice() {
                [f] => matches!(
                    *f,
                    "index" | "HEAD" | "packed-refs" | "FETCH_HEAD" | "ORIG_HEAD" | "MERGE_HEAD"
                ),
                ["refs", ..] => !rest.last().is_some_and(|f| f.ends_with(".lock")),
                _ => false,
            }
        }
        Some(first) => {
            !IGNORED_DIRS.contains(&first)
                && !rel
                    .components()
                    .any(|c| matches!(c, Component::Normal(s) if s == "node_modules"))
        }
    }
}

impl GitWatcher {
    /// Démarre l'observateur et le thread de relecture, puis suit les projets enregistrés.
    pub fn start(&self, app: &AppHandle) {
        let (tx, rx) = mpsc::channel::<notify::Result<notify::Event>>();
        let watcher = match notify::recommended_watcher(tx) {
            Ok(w) => w,
            Err(e) => {
                log::warn!("observateur Git indisponible : {e}");
                return;
            }
        };
        self.inner
            .lock()
            .map(|mut i| i.watcher = Some(watcher))
            .ok();

        let inner = Arc::clone(&self.inner);
        let handle = app.clone();
        std::thread::Builder::new()
            .name("devcenter-git-watch".into())
            .spawn(move || {
                loop {
                    match rx.recv_timeout(TICK) {
                        Ok(Ok(event)) => {
                            if matches!(event.kind, EventKind::Access(_)) {
                                continue;
                            }
                            let Ok(mut inner) = inner.lock() else { return };
                            let now = Instant::now();
                            for repo in inner.repos.iter_mut() {
                                if event.paths.iter().any(|p| relevant(&repo.path, p)) {
                                    repo.dirty_since = Some(now);
                                }
                            }
                            continue;
                        }
                        Ok(Err(_)) | Err(RecvTimeoutError::Timeout) => {}
                        Err(RecvTimeoutError::Disconnected) => return,
                    }
                    flush(&handle, &inner);
                }
            })
            .ok();

        self.sync(&app.state::<AppState>().db);
    }

    /// Aligne les dossiers suivis sur la liste des projets (ajout, retrait, clonage).
    pub fn sync(&self, db: &crate::database::Database) {
        let Ok(projects) = super::list(db) else {
            return;
        };
        let Ok(mut inner) = self.inner.lock() else {
            return;
        };
        let Inner { watcher, repos } = &mut *inner;
        let Some(watcher) = watcher.as_mut() else {
            return;
        };

        let wanted: HashMap<i64, PathBuf> = projects
            .into_iter()
            .filter(|p| p.exists && Path::new(&p.path).join(".git").exists())
            .map(|p| (p.id, PathBuf::from(p.path)))
            .collect();

        repos.retain(|r| {
            let keep = wanted.get(&r.id) == Some(&r.path);
            if !keep {
                let _ = watcher.unwatch(&r.path);
            }
            keep
        });
        for (id, path) in wanted {
            if repos.iter().any(|r| r.id == id) {
                continue;
            }
            match watcher.watch(&path, RecursiveMode::Recursive) {
                Ok(()) => {
                    let head = GitHead::read(&path);
                    repos.push(Repo {
                        id,
                        path,
                        dirty_since: None,
                        last_read: None,
                        last_sent: None,
                        head,
                    })
                }
                Err(e) => log::warn!("observation impossible de {} : {e}", path.display()),
            }
        }
    }
}

/// Relit le statut d'un dépôt (cache rafraîchi) et l'envoie à l'interface, par exemple après un
/// fetch d'arrière-plan qui a changé les compteurs ↑/↓.
pub fn push_status(app: &AppHandle, id: i64, path: &Path) {
    let git = gitcache::status(path, true);
    let _ = app.emit(EVENT_GIT, GitEvent { id, git });
}

/// Relit les dépôts dont l'activité est retombée et envoie les statuts qui ont changé.
fn flush(app: &AppHandle, inner: &Arc<Mutex<Inner>>) {
    let now = Instant::now();
    let due: Vec<(i64, PathBuf)> = {
        let Ok(mut inner) = inner.lock() else { return };
        inner
            .repos
            .iter_mut()
            .filter(|r| {
                r.dirty_since
                    .is_some_and(|t| now.duration_since(t) >= QUIET)
                    && r.last_read
                        .is_none_or(|t| now.duration_since(t) >= MIN_INTERVAL)
            })
            .map(|r| {
                r.dirty_since = None;
                r.last_read = Some(now);
                (r.id, r.path.clone())
            })
            .collect()
    };
    // `git status` hors du verrou : les événements continuent d'être enregistrés pendant ce temps.
    for (id, path) in due {
        let git = gitcache::status(&path, true);
        let head = GitHead::read(&path);
        let (changed, previous_head) = {
            let Ok(mut inner) = inner.lock() else { return };
            let Some(repo) = inner.repos.iter_mut().find(|r| r.id == id) else {
                continue;
            };
            let changed = repo.last_sent.as_ref() != Some(&git);
            repo.last_sent = Some(git.clone());
            let previous = if head.is_some() {
                std::mem::replace(&mut repo.head, head.clone())
            } else {
                None
            };
            (changed, previous)
        };
        if let (Some(before), Some(after)) = (&previous_head, &head)
            && before != after
        {
            let subject = git
                .as_ref()
                .and_then(|g| g.last_commit.as_ref())
                .map(|c| c.subject.clone());
            automations::on_git_change(app, id, before, after, subject);
        }
        if changed {
            let _ = app.emit(EVENT_GIT, GitEvent { id, git });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filters_irrelevant_paths() {
        let root = Path::new(r"C:\dev\app");
        assert!(relevant(root, &root.join("src").join("main.rs")));
        assert!(relevant(root, &root.join(".git").join("index")));
        assert!(relevant(
            root,
            &root.join(".git").join("refs").join("heads").join("main")
        ));
        assert!(!relevant(
            root,
            &root
                .join(".git")
                .join("refs")
                .join("heads")
                .join("main.lock")
        ));
        assert!(!relevant(
            root,
            &root.join(".git").join("objects").join("ab").join("cdef")
        ));
        assert!(!relevant(root, &root.join(".git").join("index.lock")));
        assert!(!relevant(
            root,
            &root.join("node_modules").join("x").join("index.js")
        ));
        assert!(!relevant(
            root,
            &root
                .join("packages")
                .join("a")
                .join("node_modules")
                .join("y.js")
        ));
        assert!(!relevant(
            root,
            &root.join("target").join("debug").join("app.exe")
        ));
        assert!(!relevant(root, Path::new(r"C:\autre\fichier.txt")));
    }
}
