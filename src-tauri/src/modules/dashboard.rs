//! Données propres aux widgets du tableau de bord (notes rapides).
//! Rangées dans la table `settings` sous une clé dédiée (`dashboard.notes.<widget>`) : aucune
//! migration, et `SettingsService::load` ignore ces clés inconnues.

use rusqlite::{params, OptionalExtension};

use crate::database::Database;
use crate::error::{AppError, AppResult};

/// Taille maximale d'un bloc-notes sérialisé.
const MAX_LEN: usize = 64 * 1024;

fn key(widget: &str) -> AppResult<String> {
    let ok = !widget.is_empty() && widget.len() <= 64 && widget.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == ':');
    if !ok {
        return Err(AppError::InvalidInput(format!("identifiant de widget invalide : {widget}")));
    }
    Ok(format!("dashboard.notes.{widget}"))
}

/// Contenu enregistré (JSON libre côté interface), ou `None` si le widget n'a encore rien noté.
pub fn get_notes(db: &Database, widget: &str) -> AppResult<Option<serde_json::Value>> {
    let key = key(widget)?;
    let raw: Option<String> = db.with(|conn| Ok(conn.query_row("SELECT value FROM settings WHERE key = ?1", params![key], |r| r.get(0)).optional()?))?;
    Ok(raw.and_then(|v| serde_json::from_str(&v).ok()))
}

pub fn set_notes(db: &Database, widget: &str, value: &serde_json::Value) -> AppResult<()> {
    let key = key(widget)?;
    let text = serde_json::to_string(value).map_err(|e| AppError::InvalidInput(e.to_string()))?;
    if text.len() > MAX_LEN {
        return Err(AppError::InvalidInput("notes trop longues (64 Ko maximum)".into()));
    }
    db.with(|conn| {
        conn.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, text],
        )?;
        Ok(())
    })
}
