//! Project Manager : projets enregistrés (SQLite) + métadonnées calculées à la demande.

pub mod branches;
pub mod commit;
pub mod deps;
pub mod detect;
pub mod env;
pub mod git;
pub mod gitcache;
pub mod gradle;
pub mod history;
pub mod import;
pub mod scripts;
pub mod sync;
pub mod watcher;

use std::path::{Path, PathBuf};

use rusqlite::{OptionalExtension, params};
use serde::Serialize;

use crate::database::Database;
use crate::error::{AppError, AppResult};

pub use detect::ProjectMeta;
pub use git::GitStatus;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: i64,
    pub name: String,
    pub path: String,
    /// Faux si le dossier a été déplacé ou supprimé.
    pub exists: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDetails {
    pub id: i64,
    pub meta: ProjectMeta,
    /// `None` si le dossier n'est pas un dépôt Git ou si git est absent.
    pub git: Option<GitStatus>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanCandidate {
    pub path: String,
    pub name: String,
    pub languages: Vec<String>,
    pub frameworks: Vec<String>,
}

/// Dossiers jamais explorés pendant un scan.
const SKIP_DIRS: &[&str] = &[
    "node_modules",
    "target",
    "dist",
    "build",
    "out",
    "vendor",
    "venv",
    ".venv",
    "__pycache__",
    "AppData",
    "$RECYCLE.BIN",
    "System Volume Information",
    "Windows",
    "Program Files",
    "Program Files (x86)",
];
const SCAN_MAX_DEPTH: usize = 4;
const SCAN_MAX_RESULTS: usize = 500;

fn normalize(path: &str) -> String {
    let trimmed = path.trim().trim_end_matches(['\\', '/']);
    // Conserve « C:\ » pour une racine de lecteur.
    if trimmed.ends_with(':') {
        format!("{trimmed}\\")
    } else {
        trimmed.to_string()
    }
}

fn folder_name(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.display().to_string())
}

pub fn list(db: &Database) -> AppResult<Vec<Project>> {
    db.with(|conn| {
        let mut stmt =
            conn.prepare("SELECT id, name, path FROM projects ORDER BY name COLLATE NOCASE")?;
        let rows = stmt.query_map([], |r| {
            let path: String = r.get(2)?;
            Ok(Project {
                id: r.get(0)?,
                name: r.get(1)?,
                exists: Path::new(&path).is_dir(),
                path,
            })
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    })
}

/// Ajoute des dossiers. Les doublons (insensibles à la casse) sont ignorés silencieusement.
pub fn add(db: &Database, paths: &[String]) -> AppResult<Vec<Project>> {
    let mut valid = Vec::new();
    for raw in paths {
        let path = normalize(raw);
        let p = Path::new(&path);
        if !p.is_absolute() || !p.is_dir() {
            return Err(AppError::InvalidInput(format!(
                "dossier introuvable : {raw}"
            )));
        }
        valid.push((folder_name(p), path));
    }
    db.with(|conn| {
        for (name, path) in &valid {
            conn.execute(
                "INSERT OR IGNORE INTO projects (name, path, added_at) VALUES (?1, ?2, strftime('%s','now'))",
                params![name, path],
            )?;
        }
        Ok(())
    })?;
    list(db)
}

pub fn remove(db: &Database, id: i64) -> AppResult<Vec<Project>> {
    db.with(|conn| {
        conn.execute("DELETE FROM projects WHERE id = ?1", params![id])?;
        Ok(())
    })?;
    list(db)
}

pub fn rename(db: &Database, id: i64, name: &str) -> AppResult<Vec<Project>> {
    let name = name.trim();
    if name.is_empty() || name.len() > 100 {
        return Err(AppError::InvalidInput(
            "le nom doit faire entre 1 et 100 caractères".into(),
        ));
    }
    db.with(|conn| {
        conn.execute(
            "UPDATE projects SET name = ?1 WHERE id = ?2",
            params![name, id],
        )?;
        Ok(())
    })?;
    list(db)
}

/// Chemin d'un projet enregistré ; échoue si le dossier n'existe plus.
pub fn path_of(db: &Database, id: i64) -> AppResult<PathBuf> {
    let path: Option<String> = db.with(|conn| {
        Ok(conn
            .query_row(
                "SELECT path FROM projects WHERE id = ?1",
                params![id],
                |r| r.get(0),
            )
            .optional()?)
    })?;
    let path =
        PathBuf::from(path.ok_or_else(|| AppError::InvalidInput(format!("projet {id} inconnu")))?);
    if !path.is_dir() {
        return Err(AppError::InvalidInput(format!(
            "dossier introuvable : {}",
            path.display()
        )));
    }
    Ok(path)
}

/// Lance un script déclaré dans le package.json (même règle depuis le PC ou le téléphone).
pub fn run_script(
    app: &tauri::AppHandle,
    project_id: i64,
    script: &str,
) -> AppResult<crate::modules::runner::RunInfo> {
    use tauri::Manager;
    let state = app.state::<crate::state::AppState>();
    let path = path_of(&state.db, project_id)?;
    let meta = detect::detect(&path);
    let declared = meta
        .scripts
        .iter()
        .find(|s| s.name == script)
        .ok_or_else(|| {
            AppError::InvalidInput(format!("script « {script} » absent du package.json"))
        })?;
    let pm = meta.package_manager.as_deref().unwrap_or("npm");
    state.runner.start(
        app,
        project_id,
        &path,
        pm,
        &declared.name,
        &declared.command,
        false,
    )
}

/// Détails d'un projet ; le statut Git vient du cache (voir `gitcache`).
pub fn details(id: i64, path: &Path) -> ProjectDetails {
    ProjectDetails {
        id,
        meta: detect::detect(path),
        git: gitcache::status(path, false),
    }
}

/// Comme `details`, en relisant le dépôt (actualisation demandée par l'utilisateur).
pub fn details_fresh(id: i64, path: &Path) -> ProjectDetails {
    ProjectDetails {
        id,
        meta: detect::detect(path),
        git: gitcache::status(path, true),
    }
}

/// Parcourt `root` à la recherche de projets non encore enregistrés.
/// On ne descend pas dans un projet trouvé (les sous-dossiers d'un monorepo restent ajoutables à la main).
pub fn scan(db: &Database, root: &str) -> AppResult<Vec<ScanCandidate>> {
    let root = PathBuf::from(normalize(root));
    if !root.is_dir() {
        return Err(AppError::InvalidInput(format!(
            "dossier introuvable : {}",
            root.display()
        )));
    }
    let known: Vec<String> = list(db)?
        .into_iter()
        .map(|p| p.path.to_lowercase())
        .collect();

    let mut found = Vec::new();
    let mut stack = vec![(root, 0usize)];
    while let Some((dir, depth)) = stack.pop() {
        if found.len() >= SCAN_MAX_RESULTS {
            break;
        }
        if detect::is_project_dir(&dir) {
            let path = dir.display().to_string();
            if !known.contains(&path.to_lowercase()) {
                let meta = detect::detect(&dir);
                found.push(ScanCandidate {
                    name: folder_name(&dir),
                    path,
                    languages: meta.languages,
                    frameworks: meta.frameworks,
                });
            }
            continue;
        }
        if depth >= SCAN_MAX_DEPTH {
            continue;
        }
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(ft) = entry.file_type() else { continue };
            // Pas de liens symboliques / jonctions : évite les boucles.
            if !ft.is_dir() || ft.is_symlink() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') || SKIP_DIRS.iter().any(|s| s.eq_ignore_ascii_case(&name)) {
                continue;
            }
            stack.push((entry.path(), depth + 1));
        }
    }
    found.sort_by_key(|c| c.name.to_lowercase());
    Ok(found)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_paths() {
        assert_eq!(normalize("C:\\Dev\\app\\"), "C:\\Dev\\app");
        assert_eq!(normalize("D:\\"), "D:\\");
    }

    #[test]
    fn add_list_remove_and_dedupe() {
        let dir = std::env::temp_dir().join(format!("devcenter-proj-{}", std::process::id()));
        let project = dir.join("my-app");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::write(
            project.join("package.json"),
            r#"{"scripts":{"dev":"vite"}}"#,
        )
        .unwrap();
        let db = Database::open(&dir.join("t.db")).unwrap();

        let candidates = scan(&db, dir.to_str().unwrap()).unwrap();
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].name, "my-app");

        let p = project.display().to_string();
        add(&db, &[p.clone()]).unwrap();
        let listed = add(&db, &[p.to_uppercase()]).unwrap(); // doublon (casse différente)
        assert_eq!(listed.len(), 1);
        assert!(scan(&db, dir.to_str().unwrap()).unwrap().is_empty());

        assert!(add(&db, &["relative\\path".into()]).is_err());
        assert!(remove(&db, listed[0].id).unwrap().is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }
}
