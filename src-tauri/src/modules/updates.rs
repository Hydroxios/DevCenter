//! Mises à jour automatiques : `latest.json` des Releases GitHub, paquets signés (minisign).
//!
//! La clé publique et l'adresse sont dans `tauri.conf.json` (`plugins.updater`) ; la clé privée
//! ne sert qu'à la CI de publication (secret GitHub), jamais à l'application.

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::UpdaterExt;

use crate::error::{AppError, AppResult};

pub const EVENT_PROGRESS: &str = "updater://progress";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub version: String,
    pub current_version: String,
    /// Notes de version (corps de la Release GitHub).
    pub notes: Option<String>,
    /// Date de publication (horodatage Unix).
    pub date: Option<i64>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
    downloaded: u64,
    total: Option<u64>,
}

fn err(e: tauri_plugin_updater::Error) -> AppError {
    let text = e.to_string();
    // Aucune Release publiée (ou pas encore de `latest.json`) : ce n'est pas une panne.
    if text.contains("valid release JSON") || text.contains("404") {
        return AppError::InvalidInput("aucune version publiée pour l'instant".into());
    }
    AppError::InvalidInput(format!("mise à jour : {text}"))
}

/// Cherche une version plus récente que celle installée.
pub async fn check(app: &AppHandle) -> AppResult<Option<UpdateInfo>> {
    let update = app.updater().map_err(err)?.check().await.map_err(err)?;
    Ok(update.map(|u| UpdateInfo {
        version: u.version.clone(),
        current_version: u.current_version.clone(),
        notes: u.body.clone().filter(|b| !b.trim().is_empty()),
        date: u.date.map(|d| d.unix_timestamp()),
    }))
}

/// Télécharge, vérifie la signature et installe la mise à jour, puis relance DevCenter.
/// Sous Windows, l'installeur ferme lui-même l'application.
pub async fn install(app: &AppHandle) -> AppResult<()> {
    let Some(update) = app.updater().map_err(err)?.check().await.map_err(err)? else {
        return Err(AppError::InvalidInput("DevCenter est déjà à jour".into()));
    };
    log::info!(
        "mise à jour vers {} (depuis {})",
        update.version,
        update.current_version
    );
    let mut downloaded: u64 = 0;
    let handle = app.clone();
    update
        .download_and_install(
            move |chunk, total| {
                downloaded += chunk as u64;
                let _ = handle.emit(EVENT_PROGRESS, Progress { downloaded, total });
            },
            || log::info!("mise à jour téléchargée, installation…"),
        )
        .await
        .map_err(err)?;
    app.restart();
}
