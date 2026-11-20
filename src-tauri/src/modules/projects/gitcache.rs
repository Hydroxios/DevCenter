//! Cache des données Git : évite de relancer `git` pour chaque projet à chaque affichage.
//!
//! - Statut : invalidé dès qu'une métadonnée Git change (HEAD, index, refs : commit, checkout,
//!   ajout à l'index, fetch…). Les fichiers modifiés dans l'arbre de travail ne touchent pas
//!   `.git` : le statut est donc aussi relu au bout de `STATUS_TTL`.
//! - Historique (graphe) : ne dépend que des refs, invalidé exactement par leur empreinte.
//! - Détail d'un commit : immuable, gardé tel quel (nombre d'entrées borné).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime};

use crate::error::AppResult;

use super::git::{self, GitStatus};
use super::history::{self, CommitDetails, GitLog};

const STATUS_TTL: Duration = Duration::from_secs(30);
const MAX_COMMITS: usize = 200;

struct StatusEntry {
    fingerprint: u128,
    at: Instant,
    status: Option<GitStatus>,
}

struct LogEntry {
    fingerprint: u128,
    log: Arc<GitLog>,
}

#[derive(Default)]
struct Caches {
    status: HashMap<PathBuf, StatusEntry>,
    /// Par dépôt et par limite (le bureau et le téléphone n'affichent pas autant de commits).
    logs: HashMap<(PathBuf, usize), LogEntry>,
    commits: HashMap<(PathBuf, String), Arc<CommitDetails>>,
}

fn caches() -> &'static Mutex<Caches> {
    static C: OnceLock<Mutex<Caches>> = OnceLock::new();
    C.get_or_init(Default::default)
}

/// Dossier Git du dépôt : `.git`, ou la cible d'un fichier `.git` (worktree, sous-module).
fn git_dir(dir: &Path) -> Option<PathBuf> {
    let dot = dir.join(".git");
    if dot.is_dir() {
        return Some(dot);
    }
    let text = std::fs::read_to_string(&dot).ok()?;
    let target = PathBuf::from(text.strip_prefix("gitdir:")?.trim());
    Some(if target.is_absolute() {
        target
    } else {
        dir.join(target)
    })
}

fn mtime(path: &Path) -> u128 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_nanos())
}

/// Empreinte des refs : HEAD, refs empaquetées et fichiers de `refs/` (branches, distantes, tags).
fn refs_fingerprint(gd: &Path) -> u128 {
    let mut fp: u128 = 0;
    let mut mix = |v: u128| fp = fp.rotate_left(7) ^ v.wrapping_mul(0x9E37_79B9_7F4A_7C15);
    for f in [
        "HEAD",
        "packed-refs",
        "FETCH_HEAD",
        "ORIG_HEAD",
        "MERGE_HEAD",
    ] {
        mix(mtime(&gd.join(f)));
    }
    // Les worktrees partagent les refs du dépôt principal.
    let common = std::fs::read_to_string(gd.join("commondir"))
        .ok()
        .map(|c| gd.join(c.trim()));
    let refs_root = common.as_deref().unwrap_or(gd).join("refs");
    let mut stack = vec![refs_root];
    let mut seen = 0usize;
    while let Some(d) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&d) else {
            continue;
        };
        for e in entries.flatten() {
            seen += 1;
            if seen > 20_000 {
                return fp; // dépôt aux refs innombrables : empreinte partielle, suffisante
            }
            let p = e.path();
            if e.file_type().is_ok_and(|t| t.is_dir()) {
                stack.push(p);
            } else {
                mix(mtime(&p));
            }
        }
    }
    mix(seen as u128);
    fp
}

/// Statut Git en cache. `force` relit le dépôt (bouton « Actualiser »).
pub fn status(dir: &Path, force: bool) -> Option<GitStatus> {
    let gd = git_dir(dir)?;
    let fingerprint = refs_fingerprint(&gd) ^ mtime(&gd.join("index")).rotate_left(64);
    if !force
        && let Ok(c) = caches().lock()
        && let Some(e) = c.status.get(dir)
        && e.fingerprint == fingerprint
        && e.at.elapsed() < STATUS_TTL
    {
        return e.status.clone();
    }
    let fresh = git::status(dir);
    if let Ok(mut c) = caches().lock() {
        c.status.insert(
            dir.to_path_buf(),
            StatusEntry {
                fingerprint,
                at: Instant::now(),
                status: fresh.clone(),
            },
        );
    }
    fresh
}

/// Graphe de l'historique, relu seulement quand les refs changent.
pub fn log(dir: &Path, limit: usize) -> AppResult<Arc<GitLog>> {
    let fingerprint = git_dir(dir).map_or(0, |gd| refs_fingerprint(&gd));
    if fingerprint != 0
        && let Some(e) = caches().lock()?.logs.get(&(dir.to_path_buf(), limit))
        && e.fingerprint == fingerprint
    {
        return Ok(Arc::clone(&e.log));
    }
    let log = Arc::new(history::log(dir, limit)?);
    if fingerprint != 0 {
        caches().lock()?.logs.insert(
            (dir.to_path_buf(), limit),
            LogEntry {
                fingerprint,
                log: Arc::clone(&log),
            },
        );
    }
    Ok(log)
}

/// Détail d'un commit (immuable une fois créé).
pub fn commit(dir: &Path, hash: &str) -> AppResult<Arc<CommitDetails>> {
    let key = (dir.to_path_buf(), hash.to_ascii_lowercase());
    if let Some(d) = caches().lock()?.commits.get(&key) {
        return Ok(Arc::clone(d));
    }
    let details = Arc::new(history::commit(dir, hash)?);
    let mut c = caches().lock()?;
    if c.commits.len() >= MAX_COMMITS {
        c.commits.clear();
    }
    c.commits.insert(key, Arc::clone(&details));
    Ok(details)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Le dépôt DevCenter : deux lectures successives viennent du cache, à l'identique.
    #[test]
    fn caches_status_and_log() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        let Some(gd) = git_dir(root) else { return };
        assert_eq!(refs_fingerprint(&gd), refs_fingerprint(&gd));
        let a = status(root, true).map(|s| (s.branch, s.modified, s.untracked));
        let b = status(root, false).map(|s| (s.branch, s.modified, s.untracked));
        assert_eq!(a, b);
        let l1 = log(root, 50).unwrap();
        let l2 = log(root, 50).unwrap();
        assert!(Arc::ptr_eq(&l1, &l2), "le second appel doit venir du cache");
    }
}
