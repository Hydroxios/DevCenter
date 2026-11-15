//! Ouverture d'un projet dans l'éditeur (Cursor par défaut, puis VS Code).

use std::path::{Path, PathBuf};

use crate::error::{AppError, AppResult};
use crate::modules::shell;

const EDITOR_EXTENSIONS: &[&str] = &["exe", "cmd", "bat"];

pub fn validate_editor_path(path: &str) -> AppResult<()> {
    let p = Path::new(path);
    let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    if !p.is_absolute() || !p.is_file() || !EDITOR_EXTENSIONS.contains(&ext.as_str()) {
        return Err(AppError::InvalidInput(format!("éditeur invalide : {path} (un .exe ou .cmd est attendu)")));
    }
    Ok(())
}

/// Éditeur détecté automatiquement : Cursor puis VS Code, dans le PATH ou leurs dossiers d'installation.
pub fn detect() -> Option<PathBuf> {
    if let Some(p) = shell::which(&["cursor.cmd", "cursor.exe", "cursor", "code.cmd", "code.exe", "code"]) {
        return Some(p);
    }
    let local = std::env::var_os("LOCALAPPDATA").map(PathBuf::from)?;
    [
        local.join("Programs").join("cursor").join("Cursor.exe"),
        local.join("Programs").join("Microsoft VS Code").join("Code.exe"),
    ]
    .into_iter()
    .find(|p| p.is_file())
}

/// Ouvre `dir` avec l'éditeur configuré, ou celui détecté.
pub fn open(configured: Option<&str>, dir: &Path) -> AppResult<()> {
    let editor = match configured {
        Some(path) => {
            validate_editor_path(path)?;
            PathBuf::from(path)
        }
        None => detect().ok_or_else(|| {
            AppError::InvalidInput("aucun éditeur trouvé : choisissez-en un dans Paramètres".into())
        })?,
    };
    shell::command(&editor)
        .arg(dir)
        .spawn()
        .map(|_| ())
        .map_err(|e| AppError::InvalidInput(format!("impossible de lancer {} : {e}", editor.display())))
}
