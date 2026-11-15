//! Raccourcis d'applications. Pour éviter l'exécution arbitraire de commandes, le frontend
//! ne peut lancer qu'un raccourci enregistré (par son id), jamais un chemin libre.

use std::path::Path;

use rusqlite::params;
use serde::Serialize;

use crate::database::Database;
use crate::error::{AppError, AppResult};

const ALLOWED_EXTENSIONS: &[&str] = &["exe", "lnk", "appref-ms"];

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppShortcut {
    pub id: i64,
    pub name: String,
    pub path: String,
    /// Faux si le fichier a été déplacé ou supprimé depuis l'enregistrement.
    pub exists: bool,
}

fn validate_path(path: &str) -> AppResult<()> {
    let p = Path::new(path);
    if !p.is_absolute() || !p.is_file() {
        return Err(AppError::InvalidInput(format!("fichier introuvable : {path}")));
    }
    let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    if !ALLOWED_EXTENSIONS.contains(&ext.as_str()) {
        return Err(AppError::InvalidInput(format!(
            "type de fichier non pris en charge (.{ext}) : choisissez un .exe ou un raccourci .lnk"
        )));
    }
    Ok(())
}

pub fn list(db: &Database) -> AppResult<Vec<AppShortcut>> {
    db.with(|conn| {
        let mut stmt = conn.prepare("SELECT id, name, path FROM app_shortcuts ORDER BY name COLLATE NOCASE")?;
        let rows = stmt.query_map([], |r| {
            let path: String = r.get(2)?;
            Ok(AppShortcut { id: r.get(0)?, name: r.get(1)?, exists: Path::new(&path).is_file(), path })
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    })
}

pub fn add(db: &Database, name: &str, path: &str) -> AppResult<Vec<AppShortcut>> {
    let name = name.trim();
    if name.is_empty() || name.len() > 100 {
        return Err(AppError::InvalidInput("le nom doit faire entre 1 et 100 caractères".into()));
    }
    validate_path(path)?;
    db.with(|conn| {
        conn.execute("INSERT INTO app_shortcuts (name, path) VALUES (?1, ?2)", params![name, path])?;
        Ok(())
    })?;
    list(db)
}

pub fn remove(db: &Database, id: i64) -> AppResult<Vec<AppShortcut>> {
    db.with(|conn| {
        conn.execute("DELETE FROM app_shortcuts WHERE id = ?1", params![id])?;
        Ok(())
    })?;
    list(db)
}

/// Lance une application. Retourne le PID pour un `.exe` (permet de la fermer à l'arrêt d'une
/// session) ; les raccourcis `.lnk` passent par le shell Windows et n'ont pas de PID suivi.
pub fn launch(path: &str) -> AppResult<Option<u32>> {
    let p = Path::new(path);
    let is_exe = p.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case("exe"));
    if is_exe {
        let mut cmd = std::process::Command::new(p);
        if let Some(dir) = p.parent() {
            cmd.current_dir(dir);
        }
        let child = cmd.spawn().map_err(|e| AppError::InvalidInput(format!("impossible de lancer {path} : {e}")))?;
        return Ok(Some(child.id()));
    }
    tauri_plugin_opener::open_path(path, None::<&str>)
        .map_err(|e| AppError::InvalidInput(format!("impossible de lancer {path} : {e}")))?;
    Ok(None)
}

/// Nom d'un raccourci (pour l'affichage des résultats).
pub fn name_of(db: &Database, id: i64) -> Option<String> {
    db.with(|conn| Ok(conn.query_row("SELECT name FROM app_shortcuts WHERE id = ?1", params![id], |r| r.get(0))?)).ok()
}

/// Retourne le chemin validé du raccourci à lancer.
pub fn resolve(db: &Database, id: i64) -> AppResult<String> {
    let path: String = db
        .with(|conn| Ok(conn.query_row("SELECT path FROM app_shortcuts WHERE id = ?1", params![id], |r| r.get(0))?))
        .map_err(|_| AppError::InvalidInput(format!("raccourci {id} inconnu")))?;
    validate_path(&path)?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_non_executables_and_relative_paths() {
        assert!(validate_path("notepad.exe").is_err());
        assert!(validate_path("C:\\Windows\\win.ini").is_err());
        assert!(validate_path("C:\\Windows\\notepad.exe").is_ok());
    }
}
