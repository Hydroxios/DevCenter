use std::sync::atomic::{AtomicBool, Ordering};

use rusqlite::params;
use serde::{Deserialize, Serialize};

use crate::database::Database;
use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Theme {
    Light,
    Dark,
    System,
}

/// Paramètres persistants de l'application.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub theme: Theme,
    /// Fermer la fenêtre la réduit dans la barre système au lieu de quitter.
    pub close_to_tray: bool,
    /// Éditeur utilisé pour ouvrir les projets ; `None` = détection automatique (Cursor, VS Code).
    pub editor_path: Option<String>,
    /// Tableau de bord mobile sur le réseau local (désactivé par défaut).
    pub remote_enabled: bool,
    pub remote_port: u16,
    /// Dossier où cloner les nouveaux projets (sinon : déduit des projets existants).
    pub projects_root: Option<String>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            theme: Theme::Dark,
            close_to_tray: true,
            editor_path: None,
            remote_enabled: false,
            remote_port: crate::modules::remote::DEFAULT_PORT,
            projects_root: None,
        }
    }
}

/// Service des paramètres : lecture/écriture SQLite + cache des valeurs utilisées côté Rust.
pub struct SettingsService {
    close_to_tray: AtomicBool,
}

impl SettingsService {
    pub fn new(db: &Database) -> AppResult<Self> {
        let settings = Self::load(db)?;
        Ok(Self {
            close_to_tray: AtomicBool::new(settings.close_to_tray),
        })
    }

    pub fn close_to_tray(&self) -> bool {
        self.close_to_tray.load(Ordering::Relaxed)
    }

    pub fn load(db: &Database) -> AppResult<Settings> {
        db.with(|conn| {
            let mut settings = Settings::default();
            let mut stmt = conn.prepare("SELECT key, value FROM settings")?;
            let rows =
                stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
            for row in rows {
                let (key, value) = row?;
                // Les valeurs inconnues ou corrompues sont ignorées (valeur par défaut conservée).
                match key.as_str() {
                    "theme" => {
                        if let Ok(t) = serde_json::from_str(&value) {
                            settings.theme = t;
                        }
                    }
                    "closeToTray" => {
                        if let Ok(b) = serde_json::from_str(&value) {
                            settings.close_to_tray = b;
                        }
                    }
                    "editorPath" => {
                        if let Ok(p) = serde_json::from_str(&value) {
                            settings.editor_path = p;
                        }
                    }
                    "remoteEnabled" => {
                        if let Ok(b) = serde_json::from_str(&value) {
                            settings.remote_enabled = b;
                        }
                    }
                    "remotePort" => {
                        if let Ok(p) = serde_json::from_str(&value) {
                            settings.remote_port = p;
                        }
                    }
                    "projectsRoot" => {
                        if let Ok(p) = serde_json::from_str(&value) {
                            settings.projects_root = p;
                        }
                    }
                    _ => {}
                }
            }
            Ok(settings)
        })
    }

    /// Met à jour un paramètre. Seules les clés connues sont acceptées et la valeur est validée.
    pub fn set(&self, db: &Database, key: &str, value: serde_json::Value) -> AppResult<Settings> {
        let invalid = |e: serde_json::Error| AppError::InvalidInput(format!("{key} : {e}"));
        match key {
            "theme" => {
                serde_json::from_value::<Theme>(value.clone()).map_err(invalid)?;
            }
            "closeToTray" => {
                let b = serde_json::from_value::<bool>(value.clone()).map_err(invalid)?;
                self.close_to_tray.store(b, Ordering::Relaxed);
            }
            "editorPath" => {
                let p = serde_json::from_value::<Option<String>>(value.clone()).map_err(invalid)?;
                if let Some(p) = &p {
                    crate::modules::editor::validate_editor_path(p)?;
                }
            }
            "remoteEnabled" => {
                serde_json::from_value::<bool>(value.clone()).map_err(invalid)?;
            }
            "remotePort" => {
                let port = serde_json::from_value::<u16>(value.clone()).map_err(invalid)?;
                if port < 1024 {
                    return Err(AppError::InvalidInput("port entre 1024 et 65535".into()));
                }
            }
            "projectsRoot" => {
                if let Some(p) =
                    serde_json::from_value::<Option<String>>(value.clone()).map_err(invalid)?
                {
                    let path = std::path::Path::new(&p);
                    if !path.is_absolute() || !path.is_dir() {
                        return Err(AppError::InvalidInput(format!("dossier introuvable : {p}")));
                    }
                }
            }
            other => return Err(AppError::InvalidInput(format!("clé inconnue « {other} »"))),
        }
        db.with(|conn| {
            conn.execute(
                "INSERT INTO settings (key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![key, value.to_string()],
            )?;
            Ok(())
        })?;
        Self::load(db)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_db() -> (Database, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("devcenter-test-{}", std::process::id()));
        let path = dir.join(format!("{}.db", rand_suffix()));
        (Database::open(&path).unwrap(), path)
    }

    fn rand_suffix() -> u128 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    }

    #[test]
    fn defaults_then_persist() {
        let (db, path) = temp_db();
        let svc = SettingsService::new(&db).unwrap();
        // Thème sombre (charte PowerBack) par défaut.
        assert_eq!(SettingsService::load(&db).unwrap().theme, Theme::Dark);

        let s = svc.set(&db, "theme", serde_json::json!("light")).unwrap();
        assert_eq!(s.theme, Theme::Light);
        svc.set(&db, "closeToTray", serde_json::json!(false))
            .unwrap();
        assert!(!svc.close_to_tray());

        // Réouverture : les valeurs et le schéma (migrations idempotentes) sont conservés.
        drop(db);
        let db = Database::open(&path).unwrap();
        let s = SettingsService::load(&db).unwrap();
        assert_eq!(s.theme, Theme::Light);
        assert!(!s.close_to_tray);
    }

    #[test]
    fn rejects_unknown_keys_and_bad_values() {
        let (db, _) = temp_db();
        let svc = SettingsService::new(&db).unwrap();
        assert!(svc.set(&db, "shell", serde_json::json!("rm -rf")).is_err());
        assert!(svc.set(&db, "theme", serde_json::json!("purple")).is_err());
        assert!(
            svc.set(&db, "closeToTray", serde_json::json!("yes"))
                .is_err()
        );
    }
}
