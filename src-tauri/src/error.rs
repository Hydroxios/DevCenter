use serde::{Serialize, Serializer};

/// Erreur unique remontée au frontend via IPC.
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("Erreur base de données : {0}")]
    Database(#[from] rusqlite::Error),

    #[error("Erreur Tauri : {0}")]
    Tauri(#[from] tauri::Error),

    #[error("Erreur d'entrée/sortie : {0}")]
    Io(#[from] std::io::Error),

    #[error("Erreur système : {0}")]
    System(#[from] sysinfo::Error),

    #[error("Paramètre invalide : {0}")]
    InvalidInput(String),

    #[error("Service indisponible : {0}")]
    Unavailable(&'static str),

    #[error("Verrou interne empoisonné")]
    LockPoisoned,
}

impl<T> From<std::sync::PoisonError<T>> for AppError {
    fn from(_: std::sync::PoisonError<T>) -> Self {
        AppError::LockPoisoned
    }
}

// Les erreurs sont envoyées au frontend sous forme de message lisible ; chacune est aussi
// écrite dans le journal (c'est le seul endroit où passent toutes les erreurs de commande).
impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let message = self.to_string();
        match self {
            AppError::InvalidInput(_) => log::warn!(target: "commande", "{message}"),
            _ => log::error!(target: "commande", "{message}"),
        }
        serializer.serialize_str(&message)
    }
}

pub type AppResult<T> = Result<T, AppError>;
