//! Compte GitHub via la CLI officielle `gh` : DevCenter ne manipule jamais le jeton
//! (il reste dans le gestionnaire d'identifiants Windows, géré par `gh`).

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::database::Database;
use crate::error::{AppError, AppResult};
use crate::modules::shell;

const CACHE_TTL: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GithubStatus {
    pub installed: bool,
    pub login: Option<String>,
    pub scopes: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Repo {
    pub full_name: String,
    pub name: String,
    pub owner: String,
    pub private: bool,
    pub fork: bool,
    pub archived: bool,
    pub description: Option<String>,
    pub language: Option<String>,
    pub pushed_at: Option<String>,
    pub clone_url: String,
    /// Projet DevCenter déjà lié à ce dépôt (même remote `origin`).
    #[serde(default)]
    pub project_id: Option<i64>,
}

#[derive(Default)]
pub struct GithubCache {
    repos: Mutex<Option<(Instant, String, Vec<Repo>)>>,
}

pub fn exe() -> Option<PathBuf> {
    let default = PathBuf::from(r"C:\Program Files\GitHub CLI\gh.exe");
    if default.is_file() {
        return Some(default);
    }
    shell::which(&["gh.exe", "gh"])
}

fn gh(args: &[&str]) -> AppResult<String> {
    let exe = exe().ok_or_else(|| AppError::InvalidInput("GitHub CLI (gh) n'est pas installé".into()))?;
    let out = shell::command(exe).args(args).env("GH_PROMPT_DISABLED", "1").env("NO_COLOR", "1").output()?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        Err(AppError::InvalidInput(String::from_utf8_lossy(&out.stderr).trim().chars().take(300).collect()))
    }
}

pub fn status() -> GithubStatus {
    if exe().is_none() {
        return GithubStatus::default();
    }
    let mut st = GithubStatus { installed: true, ..Default::default() };
    // `gh auth status` sort en erreur s'il n'y a aucun compte : on lit quand même le JSON.
    let Some(exe) = exe() else { return st };
    let Ok(out) = shell::command(exe).args(["auth", "status", "--json", "hosts"]).env("GH_PROMPT_DISABLED", "1").output() else { return st };
    if let Ok(json) = serde_json::from_slice::<serde_json::Value>(&out.stdout) {
        if let Some(acc) = json["hosts"]["github.com"].as_array().and_then(|a| a.iter().find(|h| h["active"].as_bool() == Some(true) && h["state"] == "success")) {
            st.login = acc["login"].as_str().map(str::to_string);
            st.scopes = acc["scopes"].as_str().map(str::to_string);
        }
    }
    st
}

/// Normalise une URL de dépôt GitHub en « propriétaire/nom » (https, ssh, avec ou sans .git).
pub fn full_name_from_remote(url: &str) -> Option<String> {
    let u = url.trim().trim_end_matches('/').trim_end_matches(".git");
    let rest = u
        .strip_prefix("https://github.com/")
        .or_else(|| u.strip_prefix("http://github.com/"))
        .or_else(|| u.strip_prefix("git@github.com:"))
        .or_else(|| u.strip_prefix("ssh://git@github.com/"))?;
    let mut parts = rest.split('/');
    let (owner, name) = (parts.next()?, parts.next()?);
    (!owner.is_empty() && !name.is_empty()).then(|| format!("{owner}/{name}").to_lowercase())
}

fn origin_of(path: &Path) -> Option<String> {
    let out = shell::command("git").arg("-C").arg(path).args(["config", "--get", "remote.origin.url"]).output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

#[derive(Deserialize)]
struct ApiRepo {
    full_name: String,
    name: String,
    owner: ApiOwner,
    private: bool,
    fork: bool,
    archived: bool,
    description: Option<String>,
    language: Option<String>,
    pushed_at: Option<String>,
    clone_url: String,
}

#[derive(Deserialize)]
struct ApiOwner {
    login: String,
}

impl GithubCache {
    /// Dépôts accessibles au compte connecté (personnels, collaborations, organisations).
    pub fn repos(&self, db: &Database, refresh: bool) -> AppResult<(String, Vec<Repo>)> {
        let login = status().login.ok_or_else(|| AppError::InvalidInput("aucun compte GitHub connecté".into()))?;
        let cached = {
            let cache = self.repos.lock()?;
            cache.as_ref().filter(|(at, who, _)| !refresh && at.elapsed() < CACHE_TTL && *who == login).map(|(_, _, r)| r.clone())
        };
        let mut repos = match cached {
            Some(r) => r,
            None => {
                let text = gh(&[
                    "api",
                    "--paginate",
                    "user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member",
                    "--jq",
                    ".[] | {full_name, name, owner: {login: .owner.login}, private, fork, archived, description, language, pushed_at, clone_url}",
                ])?;
                let list: Vec<Repo> = text
                    .lines()
                    .filter_map(|l| serde_json::from_str::<ApiRepo>(l).ok())
                    .map(|r| Repo {
                        full_name: r.full_name,
                        name: r.name,
                        owner: r.owner.login,
                        private: r.private,
                        fork: r.fork,
                        archived: r.archived,
                        description: r.description,
                        language: r.language,
                        pushed_at: r.pushed_at,
                        clone_url: r.clone_url,
                        project_id: None,
                    })
                    .collect();
                *self.repos.lock()? = Some((Instant::now(), login.clone(), list.clone()));
                list
            }
        };

        // Dépôts déjà importés : comparaison avec le remote `origin` de chaque projet.
        let projects = crate::modules::projects::list(db)?;
        let remotes: Vec<(i64, String)> = std::thread::scope(|s| {
            let handles: Vec<_> = projects
                .iter()
                .filter(|p| p.exists)
                .map(|p| s.spawn(move || origin_of(Path::new(&p.path)).and_then(|u| full_name_from_remote(&u)).map(|n| (p.id, n))))
                .collect();
            handles.into_iter().filter_map(|h| h.join().ok().flatten()).collect()
        });
        for r in &mut repos {
            let key = r.full_name.to_lowercase();
            r.project_id = remotes.iter().find(|(_, n)| *n == key).map(|(id, _)| *id);
        }
        Ok((login, repos))
    }

    pub fn invalidate(&self) {
        if let Ok(mut c) = self.repos.lock() {
            *c = None;
        }
    }
}

/// Pull request ou issue renvoyée par l'API de recherche GitHub.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxItem {
    pub number: u64,
    pub title: String,
    /// « propriétaire/nom ».
    pub repo: String,
    pub url: String,
    pub updated_at: String,
    #[serde(default)]
    pub draft: bool,
}

/// Ce qui attend l'utilisateur sur GitHub (widget du tableau de bord).
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GithubInbox {
    pub installed: bool,
    pub login: Option<String>,
    /// PR ouvertes dont l'utilisateur est l'auteur.
    pub authored: Vec<InboxItem>,
    /// PR ouvertes où une revue de l'utilisateur est demandée.
    pub review_requested: Vec<InboxItem>,
    /// Issues ouvertes assignées à l'utilisateur.
    pub assigned: Vec<InboxItem>,
}

fn search(query: &str) -> AppResult<Vec<InboxItem>> {
    let q = format!("q={query} archived:false");
    let text = gh(&[
        "api",
        "-X",
        "GET",
        "search/issues",
        "-f",
        &q,
        "-f",
        "sort=updated",
        "-f",
        "per_page=30",
        "--jq",
        r#".items[] | {number, title, url: .html_url, updatedAt: .updated_at, draft: (.draft // false), repo: (.repository_url | sub("^.*/repos/"; ""))}"#,
    ])?;
    Ok(text.lines().filter_map(|l| serde_json::from_str::<InboxItem>(l).ok()).collect())
}

/// PR et issues ouvertes qui concernent l'utilisateur connecté (trois recherches en parallèle).
/// Sans compte connecté, renvoie simplement `login: None` (pas d'erreur).
pub fn inbox() -> AppResult<GithubInbox> {
    let st = status();
    let mut inbox = GithubInbox { installed: st.installed, login: st.login, ..Default::default() };
    if inbox.login.is_none() {
        return Ok(inbox);
    }
    let (a, r, i) = std::thread::scope(|s| {
        let a = s.spawn(|| search("is:open is:pr author:@me"));
        let r = s.spawn(|| search("is:open is:pr review-requested:@me"));
        let i = s.spawn(|| search("is:open is:issue assignee:@me"));
        let join = |h: std::thread::ScopedJoinHandle<'_, AppResult<Vec<InboxItem>>>| {
            h.join().unwrap_or_else(|_| Err(AppError::InvalidInput("recherche GitHub interrompue".into())))
        };
        (join(a), join(r), join(i))
    });
    inbox.authored = a?;
    inbox.review_requested = r?;
    inbox.assigned = i?;
    Ok(inbox)
}

/// Options git pour cloner un dépôt GitHub avec le compte `gh`, sans modifier la configuration
/// globale de git (équivalent ponctuel de `gh auth setup-git`).
pub fn credential_args(url: &str) -> Vec<String> {
    let Some(exe) = exe() else { return Vec::new() };
    if !url.to_lowercase().starts_with("https://github.com/") || status().login.is_none() {
        return Vec::new();
    }
    let helper = format!("!'{}' auth git-credential", exe.display().to_string().replace('\\', "/"));
    vec![
        "-c".into(),
        "credential.https://github.com.helper=".into(),
        "-c".into(),
        format!("credential.https://github.com.helper={helper}"),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_remotes() {
        assert_eq!(full_name_from_remote("https://github.com/Hydroxios/HxNotes.git").as_deref(), Some("hydroxios/hxnotes"));
        assert_eq!(full_name_from_remote("git@github.com:Hydroxios/HxNotes.git").as_deref(), Some("hydroxios/hxnotes"));
        assert_eq!(full_name_from_remote("https://github.com/a/b/").as_deref(), Some("a/b"));
        assert_eq!(full_name_from_remote("https://gitlab.com/a/b"), None);
    }
}

#[cfg(test)]
mod live_tests {
    use super::*;

    /// Vérification manuelle sur le vrai compte : `cargo test --lib github::live -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn live_repos_and_private_access() {
        let dir = std::env::temp_dir().join(format!("devcenter-gh-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = Database::open(&dir.join("t.db")).unwrap();
        let (login, repos) = GithubCache::default().repos(&db, true).unwrap();
        let private: Vec<_> = repos.iter().filter(|r| r.private).collect();
        eprintln!("compte {login} : {} dépôts dont {} privés", repos.len(), private.len());
        if let Some(r) = private.first() {
            let out = shell::command("git")
                .args(credential_args(&r.clone_url))
                .args(["-c", "credential.interactive=never", "ls-remote", "--heads", &r.clone_url])
                .env("GIT_TERMINAL_PROMPT", "0")
                .env("GCM_INTERACTIVE", "never")
                .output()
                .unwrap();
            eprintln!("ls-remote {} : {}", r.full_name, if out.status.success() { "OK" } else { "ÉCHEC" });
            assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        }
        std::fs::remove_dir_all(&dir).ok();
    }
}
