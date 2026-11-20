//! Import de projets à distance : dossiers de projets autorisés et clonage Git sécurisé.
//!
//! - Les dossiers explorables depuis le téléphone se limitent aux « dossiers de projets » :
//!   celui choisi dans les paramètres et les dossiers parents des projets déjà enregistrés.
//! - Clonage : `https://` uniquement, transports Git dangereux (`ext::`, `file://`…) interdits,
//!   aucune invite d'identifiants (pas de fenêtre qui s'ouvrirait sur le PC), dossier cible
//!   obligatoirement nouveau et situé dans le dossier de projets.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::database::Database;
use crate::error::{AppError, AppResult};
use crate::modules::settings::SettingsService;
use crate::modules::shell;
use crate::state::AppState;

pub const EVENT_CHANGED: &str = "projects://changed";
const CLONE_TIMEOUT: Duration = Duration::from_secs(15 * 60);

fn key(p: &Path) -> String {
    p.display()
        .to_string()
        .trim_end_matches(['\\', '/'])
        .to_lowercase()
}

/// Dossier où sont clonés les nouveaux projets.
pub fn default_root(db: &Database) -> AppResult<PathBuf> {
    if let Some(root) = SettingsService::load(db)?.projects_root {
        return Ok(PathBuf::from(root));
    }
    // Sinon : le dossier parent le plus fréquent parmi les projets enregistrés.
    let mut counts: Vec<(PathBuf, usize)> = Vec::new();
    for p in super::list(db)? {
        if let Some(parent) = Path::new(&p.path).parent() {
            match counts.iter_mut().find(|(d, _)| key(d) == key(parent)) {
                Some((_, n)) => *n += 1,
                None => counts.push((parent.to_path_buf(), 1)),
            }
        }
    }
    if let Some((dir, _)) = counts.into_iter().max_by_key(|(_, n)| *n) {
        return Ok(dir);
    }
    let home = std::env::var_os("USERPROFILE")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("C:\\"));
    Ok(home.join("Projects"))
}

/// Dossiers que le téléphone peut explorer.
pub fn roots(db: &Database) -> AppResult<Vec<String>> {
    let mut out: Vec<PathBuf> = vec![default_root(db)?];
    for p in super::list(db)? {
        if let Some(parent) = Path::new(&p.path).parent() {
            out.push(parent.to_path_buf());
        }
    }
    let mut seen = Vec::new();
    out.retain(|d| {
        let k = key(d);
        let fresh = d.is_dir() && !seen.contains(&k);
        seen.push(k);
        fresh
    });
    Ok(out.into_iter().map(|d| d.display().to_string()).collect())
}

/// Le chemin est-il dans un des dossiers de projets ?
pub fn within_roots(db: &Database, path: &str) -> AppResult<bool> {
    let target = key(Path::new(path));
    if target.contains("..") {
        return Ok(false);
    }
    Ok(roots(db)?.iter().any(|r| {
        let r = key(Path::new(r));
        target == r || target.starts_with(&format!("{r}\\")) || target.starts_with(&format!("{r}/"))
    }))
}

// ------------------------------------------------------------------ Clonage

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloneJob {
    pub id: u64,
    pub url: String,
    pub name: String,
    pub path: String,
    /// running | done | failed
    pub status: String,
    pub error: Option<String>,
    pub project_id: Option<i64>,
    pub started_at: i64,
}

#[derive(Default)]
pub struct CloneJobs {
    jobs: Mutex<Vec<CloneJob>>,
    next: AtomicU64,
}

/// URL de dépôt acceptée : https, hôte et chemin simples, sans identifiants intégrés.
pub fn validate_url(url: &str) -> AppResult<()> {
    let invalid = || {
        AppError::InvalidInput(
            "URL Git invalide : collez une adresse https://… (ex. https://github.com/moi/projet)"
                .into(),
        )
    };
    let rest = url.strip_prefix("https://").ok_or_else(invalid)?;
    let (host, path) = rest.split_once('/').ok_or_else(invalid)?;
    let host_ok = !host.is_empty()
        && !host.contains('@') // pas d'identifiants dans l'URL
        && host.chars().all(|c| c.is_ascii_alphanumeric() || ".-:".contains(c));
    let path_ok = !path.trim_matches('/').is_empty()
        && path
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "._-/~".contains(c))
        && !path.contains("..");
    if url.len() <= 300 && host_ok && path_ok {
        Ok(())
    } else {
        Err(invalid())
    }
}

/// Nom de dossier déduit de l'URL (`…/projet.git` → `projet`).
pub fn name_from_url(url: &str) -> String {
    url.trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or("projet")
        .trim_end_matches(".git")
        .to_string()
}

pub fn validate_name(name: &str) -> AppResult<()> {
    let ok = !name.is_empty()
        && name.len() <= 100
        && !name.starts_with('.')
        && !name.starts_with('-')
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "._-".contains(c));
    if ok {
        Ok(())
    } else {
        Err(AppError::InvalidInput(format!(
            "nom de dossier invalide : {name}"
        )))
    }
}

impl CloneJobs {
    pub fn list(&self) -> Vec<CloneJob> {
        self.jobs.lock().map(|j| j.clone()).unwrap_or_default()
    }

    fn update(&self, id: u64, f: impl FnOnce(&mut CloneJob)) {
        if let Ok(mut jobs) = self.jobs.lock() {
            if let Some(j) = jobs.iter_mut().find(|j| j.id == id) {
                f(j);
            }
        }
    }

    /// Lance le clonage en arrière-plan.
    pub fn start(&self, app: &AppHandle, url: &str, name: Option<&str>) -> AppResult<CloneJob> {
        let url = url.trim().to_string();
        validate_url(&url)?;
        let name = name
            .map(str::trim)
            .filter(|n| !n.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| name_from_url(&url));
        validate_name(&name)?;
        let state = app.state::<AppState>();
        let root = default_root(&state.db)?;
        let dest = root.join(&name);
        if dest.exists() {
            return Err(AppError::InvalidInput(format!(
                "le dossier {} existe déjà",
                dest.display()
            )));
        }
        if self
            .list()
            .iter()
            .any(|j| j.status == "running" && key(Path::new(&j.path)) == key(&dest))
        {
            return Err(AppError::InvalidInput(
                "ce clonage est déjà en cours".into(),
            ));
        }
        std::fs::create_dir_all(&root)?;

        let job = CloneJob {
            id: self.next.fetch_add(1, Ordering::Relaxed) + 1,
            url: url.clone(),
            name: name.clone(),
            path: dest.display().to_string(),
            status: "running".into(),
            error: None,
            project_id: None,
            started_at: crate::modules::automations::now(),
        };
        {
            let mut jobs = self.jobs.lock()?;
            jobs.retain(|j| {
                j.status == "running" || crate::modules::automations::now() - j.started_at < 3600
            });
            jobs.push(job.clone());
        }

        let app = app.clone();
        let id = job.id;
        std::thread::spawn(move || {
            let state = app.state::<AppState>();
            let result = run_clone(&url, &dest);
            let outcome =
                result.and_then(|()| super::add(&state.db, &[dest.display().to_string()]));
            match outcome {
                Ok(list) => {
                    let project_id = list
                        .iter()
                        .find(|p| key(Path::new(&p.path)) == key(&dest))
                        .map(|p| p.id);
                    state.clones.update(id, |j| {
                        j.status = "done".into();
                        j.project_id = project_id;
                    });
                    crate::modules::notify::dispatch(
                        &app,
                        crate::modules::notify::Event {
                            category: crate::modules::notify::Category::Clone,
                            target: Some(crate::modules::notify::Target::Projects),
                            retry: None,
                            title: format!("Projet cloné · {name}"),
                            body: dest.display().to_string(),
                            tab: Some("projects".into()),
                            tag: Some(format!("clone-{id}")),
                        },
                    );
                }
                Err(e) => {
                    // Clonage interrompu : on ne laisse pas de dossier à moitié rempli.
                    if dest.exists() {
                        let _ = std::fs::remove_dir_all(&dest);
                    }
                    let msg = e.to_string();
                    state.clones.update(id, |j| {
                        j.status = "failed".into();
                        j.error = Some(msg.clone());
                    });
                    crate::modules::notify::dispatch(
                        &app,
                        crate::modules::notify::Event {
                            category: crate::modules::notify::Category::Clone,
                            target: Some(crate::modules::notify::Target::Projects),
                            retry: None,
                            title: format!("Échec du clonage · {name}"),
                            body: msg,
                            tab: Some("projects".into()),
                            tag: Some(format!("clone-{id}")),
                        },
                    );
                }
            }
            let _ = app.emit(EVENT_CHANGED, ());
        });
        Ok(job)
    }
}

fn run_clone(url: &str, dest: &Path) -> AppResult<()> {
    let mut child = shell::command("git")
        .args(crate::modules::github::credential_args(url))
        .args([
            "-c",
            "protocol.allow=never",
            "-c",
            "protocol.https.allow=always",
            "-c",
            "credential.interactive=never",
            "-c",
            "core.askPass=",
            "clone",
            "--quiet",
            "--",
        ])
        .arg(url)
        .arg(dest)
        // Aucune invite : un dépôt privé sans identifiants enregistrés échoue proprement.
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "never")
        .env("GIT_ASKPASS", "")
        .env("SSH_ASKPASS", "")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| AppError::InvalidInput(format!("git introuvable : {e}")))?;

    let deadline = Instant::now() + CLONE_TIMEOUT;
    loop {
        if let Some(status) = child.try_wait()? {
            if status.success() {
                return Ok(());
            }
            let mut err = String::new();
            if let Some(mut s) = child.stderr.take() {
                use std::io::Read;
                let _ = s.read_to_string(&mut err);
            }
            let lower = err.to_lowercase();
            let msg = if lower.contains("authentication")
                || lower.contains("could not read username")
                || lower.contains("terminal prompts disabled")
            {
                "dépôt privé : connectez votre compte GitHub dans DevCenter (Paramètres › GitHub), puis réessayez".to_string()
            } else if lower.contains("not found")
                || lower.contains("repository") && lower.contains("does not exist")
            {
                "dépôt introuvable".to_string()
            } else {
                err.lines()
                    .filter(|l| !l.trim().is_empty())
                    .last()
                    .unwrap_or("échec du clonage")
                    .trim()
                    .chars()
                    .take(300)
                    .collect()
            };
            return Err(AppError::InvalidInput(msg));
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(AppError::InvalidInput(
                "clonage trop long (15 min) : interrompu".into(),
            ));
        }
        std::thread::sleep(Duration::from_millis(300));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_clone_urls() {
        assert!(validate_url("https://github.com/tauri-apps/tauri").is_ok());
        assert!(validate_url("https://gitlab.com/group/sub/projet.git").is_ok());
        for bad in [
            "http://github.com/a/b",
            "git@github.com:a/b.git",
            "ext::sh -c touch% /tmp/pwned",
            "file:///C:/Windows",
            "https://user:token@github.com/a/b",
            "https://github.com/",
            "https://github.com/a/../b",
            "https://github.com/a/b --upload-pack=calc",
        ] {
            assert!(validate_url(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn names() {
        assert_eq!(
            name_from_url("https://github.com/moi/mon-projet.git"),
            "mon-projet"
        );
        assert_eq!(name_from_url("https://github.com/moi/app/"), "app");
        assert!(validate_name("mon-projet").is_ok());
        assert!(validate_name("..").is_err());
        assert!(validate_name("a\\b").is_err());
        assert!(validate_name("-x").is_err());
    }

    #[test]
    fn roots_are_limited() {
        let dir = std::env::temp_dir().join(format!("devcenter-roots-{}", std::process::id()));
        let proj = dir.join("workspace").join("app");
        std::fs::create_dir_all(&proj).unwrap();
        let db = Database::open(&dir.join("t.db")).unwrap();
        crate::modules::projects::add(&db, &[proj.display().to_string()]).unwrap();
        let ws = dir.join("workspace").display().to_string();
        assert!(
            roots(&db)
                .unwrap()
                .iter()
                .any(|r| r.eq_ignore_ascii_case(&ws))
        );
        assert!(within_roots(&db, &proj.display().to_string()).unwrap());
        assert!(!within_roots(&db, "C:\\Windows").unwrap());
        assert!(!within_roots(&db, &format!("{ws}\\..\\..")).unwrap());
        std::fs::remove_dir_all(&dir).ok();
    }
}
