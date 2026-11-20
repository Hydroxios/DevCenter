//! Commandes enregistrées (« snippets ») exécutées en un clic sur un serveur.
//!
//! Contrairement aux actions systemd / Docker (modèles fixes), la commande est saisie par
//! l'utilisateur lui-même : elle est transmise telle quelle au shell distant, comme s'il la
//! tapait dans le terminal. L'exécution reste non interactive (`BatchMode`, clé uniquement)
//! et bornée dans le temps ; `sudo -n` échoue au lieu d'attendre un mot de passe.

use std::time::{Duration, Instant};

use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::database::Database;
use crate::error::{AppError, AppResult};

use super::Server;
use super::ssh::{self, quote};

/// Délai d'une commande lancée depuis l'interface (une mise à jour apt peut être longue).
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(300);
/// Taille maximale conservée de chaque flux (stdout / stderr).
const MAX_OUTPUT: usize = 256 * 1024;
const MAX_COMMAND: usize = 4000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snippet {
    pub id: i64,
    pub name: String,
    pub command: String,
    /// `None` = commande globale, proposée sur tous les serveurs.
    pub server_id: Option<i64>,
    /// Demander une confirmation avant l'exécution (interface).
    pub confirm: bool,
    /// Exécuter via `sudo -n`.
    pub sudo: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnippetInput {
    pub id: Option<i64>,
    pub name: String,
    pub command: String,
    pub server_id: Option<i64>,
    #[serde(default)]
    pub confirm: bool,
    #[serde(default)]
    pub sudo: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandResult {
    pub stdout: String,
    pub stderr: String,
    /// `None` si le processus a été interrompu par un signal.
    pub exit_code: Option<i32>,
    pub duration_ms: u64,
    /// Une des sorties a été tronquée.
    pub truncated: bool,
}

pub fn validate_command(command: &str) -> AppResult<String> {
    let command = command.trim().to_string();
    if command.is_empty() {
        return Err(AppError::InvalidInput("commande manquante".into()));
    }
    if command.len() > MAX_COMMAND || command.contains('\0') {
        return Err(AppError::InvalidInput(format!("commande trop longue ({MAX_COMMAND} caractères maximum)")));
    }
    Ok(command)
}

fn row(r: &rusqlite::Row) -> rusqlite::Result<Snippet> {
    Ok(Snippet {
        id: r.get(0)?,
        name: r.get(1)?,
        command: r.get(2)?,
        server_id: r.get(3)?,
        confirm: r.get::<_, i64>(4)? != 0,
        sudo: r.get::<_, i64>(5)? != 0,
    })
}

const COLUMNS: &str = "id, name, command, server_id, confirm, sudo";

pub fn list(db: &Database) -> AppResult<Vec<Snippet>> {
    db.with(|conn| {
        let mut stmt = conn.prepare(&format!("SELECT {COLUMNS} FROM server_snippets ORDER BY name COLLATE NOCASE"))?;
        let rows = stmt.query_map([], row)?;
        Ok(rows.collect::<Result<_, _>>()?)
    })
}

pub fn get(db: &Database, id: i64) -> AppResult<Snippet> {
    db.with(|conn| Ok(conn.query_row(&format!("SELECT {COLUMNS} FROM server_snippets WHERE id = ?1"), params![id], row).optional()?))?
        .ok_or_else(|| AppError::InvalidInput(format!("commande {id} inconnue")))
}

/// La commande est-elle proposée sur ce serveur (globale ou propre au serveur) ?
pub fn available_on(snippet: &Snippet, server_id: i64) -> bool {
    snippet.server_id.is_none_or(|s| s == server_id)
}

pub fn save(db: &Database, input: &SnippetInput) -> AppResult<Vec<Snippet>> {
    let name = input.name.trim().to_string();
    if name.is_empty() || name.chars().count() > 80 {
        return Err(AppError::InvalidInput("le nom doit faire entre 1 et 80 caractères".into()));
    }
    let command = validate_command(&input.command)?;
    if let Some(server_id) = input.server_id {
        super::get(db, server_id)?;
    }
    db.with(|conn| {
        match input.id {
            Some(id) => {
                let n = conn.execute(
                    "UPDATE server_snippets SET name = ?1, command = ?2, server_id = ?3, confirm = ?4, sudo = ?5 WHERE id = ?6",
                    params![name, command, input.server_id, input.confirm as i64, input.sudo as i64, id],
                )?;
                if n == 0 {
                    return Err(AppError::InvalidInput(format!("commande {id} inconnue")));
                }
            }
            None => {
                conn.execute(
                    "INSERT INTO server_snippets (name, command, server_id, confirm, sudo, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    params![name, command, input.server_id, input.confirm as i64, input.sudo as i64, crate::modules::automations::now()],
                )?;
            }
        }
        Ok(())
    })?;
    list(db)
}

pub fn delete(db: &Database, id: i64) -> AppResult<Vec<Snippet>> {
    db.with(|conn| {
        conn.execute("DELETE FROM server_snippets WHERE id = ?1", params![id])?;
        Ok(())
    })?;
    list(db)
}

/// Commande distante finale : `sudo -n sh -c '…'` pour que sudo couvre toute la ligne
/// (tubes, `&&`…) et échoue immédiatement s'il faudrait un mot de passe.
pub fn remote_command(command: &str, sudo: bool) -> String {
    if sudo { format!("sudo -n sh -c {}", quote(command)) } else { command.to_string() }
}

fn clip(bytes: &[u8], truncated: &mut bool) -> String {
    let text = String::from_utf8_lossy(bytes);
    if text.len() <= MAX_OUTPUT {
        return text.into_owned();
    }
    *truncated = true;
    let mut end = MAX_OUTPUT;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n… (sortie tronquée)", &text[..end])
}

/// Exécute une commande et retourne ses sorties et son code, même non nul.
/// Seules les erreurs de connexion SSH (code 255 de `ssh`) sont remontées comme erreur.
pub fn execute(server: &Server, command: &str, sudo: bool, timeout: Duration) -> AppResult<CommandResult> {
    let command = validate_command(command)?;
    let start = Instant::now();
    let out = ssh::exec(server, &remote_command(&command, sudo), timeout)?;
    let duration_ms = start.elapsed().as_millis() as u64;
    let mut truncated = false;
    let stdout = clip(&out.stdout, &mut truncated);
    let stderr = clip(&out.stderr, &mut truncated)
        .lines()
        .filter(|l| !l.starts_with("Warning: Permanently added"))
        .collect::<Vec<_>>()
        .join("\n");
    let exit_code = out.status.code();
    if exit_code == Some(255) && ssh::is_connection_error(&stderr) {
        return Err(AppError::InvalidInput(ssh::explain(stderr.trim(), exit_code)));
    }
    Ok(CommandResult { stdout, stderr, exit_code, duration_ms, truncated })
}

pub fn run(db: &Database, server: &Server, snippet_id: i64, timeout: Duration) -> AppResult<CommandResult> {
    let snippet = get(db, snippet_id)?;
    if !available_on(&snippet, server.id) {
        return Err(AppError::InvalidInput(format!("la commande « {} » n'est pas disponible sur ce serveur", snippet.name)));
    }
    execute(server, &snippet.command, snippet.sudo, timeout)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_remote_command() {
        assert_eq!(remote_command("df -h", false), "df -h");
        assert_eq!(remote_command("apt-get update && apt-get -y upgrade", true), "sudo -n sh -c 'apt-get update && apt-get -y upgrade'");
        assert_eq!(remote_command("echo 'a'", true), r"sudo -n sh -c 'echo '\''a'\'''");
    }

    #[test]
    fn validates_commands() {
        assert!(validate_command("  ").is_err());
        assert_eq!(validate_command(" free -h \n").unwrap(), "free -h");
        assert!(validate_command(&"x".repeat(MAX_COMMAND + 1)).is_err());
    }

    #[test]
    fn clips_long_output() {
        let mut t = false;
        assert_eq!(clip(b"ok", &mut t), "ok");
        assert!(!t);
        let long = "é".repeat(MAX_OUTPUT);
        let out = clip(long.as_bytes(), &mut t);
        assert!(t && out.ends_with("(sortie tronquée)"));
    }
}
