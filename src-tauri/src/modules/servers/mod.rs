//! Server Manager : serveurs SSH enregistrés, monitoring, services, Docker et terminal.

pub mod agent;
pub mod remote;
pub mod ssh;
pub mod terminal;

use std::path::Path;

use rusqlite::params;
use serde::{Deserialize, Serialize};

use crate::database::Database;
use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Server {
    pub id: i64,
    pub name: String,
    pub host: String,
    pub port: u16,
    /// `None` = utilisateur défini par `~/.ssh/config` ou utilisateur Windows courant.
    pub user: Option<String>,
    /// `None` = clés par défaut, agent SSH ou `~/.ssh/config`.
    pub key_path: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerInput {
    pub id: Option<i64>,
    pub name: String,
    pub host: String,
    pub port: Option<u16>,
    pub user: Option<String>,
    pub key_path: Option<String>,
}

fn empty_to_none(v: &Option<String>) -> Option<String> {
    v.as_ref()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn validate(
    input: &ServerInput,
) -> AppResult<(String, String, u16, Option<String>, Option<String>)> {
    let name = input.name.trim().to_string();
    if name.is_empty() || name.len() > 80 {
        return Err(AppError::InvalidInput(
            "le nom doit faire entre 1 et 80 caractères".into(),
        ));
    }
    let host = input.host.trim().to_string();
    // Nom d'hôte, alias ~/.ssh/config, IPv4 ou IPv6 : jamais d'option déguisée (« -oProxyCommand=… »).
    let host_ok = !host.is_empty()
        && host.len() <= 253
        && !host.starts_with('-')
        && host
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || ".-_:[]".contains(c));
    if !host_ok {
        return Err(AppError::InvalidInput(format!("hôte invalide : {host}")));
    }
    let port = input.port.unwrap_or(22);
    if port == 0 {
        return Err(AppError::InvalidInput("port invalide".into()));
    }
    let user = empty_to_none(&input.user);
    if let Some(u) = &user {
        let ok = u.len() <= 64
            && !u.starts_with('-')
            && u.chars()
                .all(|c| c.is_ascii_alphanumeric() || "._-".contains(c));
        if !ok {
            return Err(AppError::InvalidInput(format!(
                "utilisateur invalide : {u}"
            )));
        }
    }
    let key_path = empty_to_none(&input.key_path);
    if let Some(k) = &key_path {
        let p = Path::new(k);
        if !p.is_absolute() || !p.is_file() {
            return Err(AppError::InvalidInput(format!("clé introuvable : {k}")));
        }
        if k.to_lowercase().ends_with(".ppk") {
            return Err(AppError::InvalidInput(
                "clé PuTTY (.ppk) non prise en charge par OpenSSH : convertissez-la avec PuTTYgen (Conversions › Export OpenSSH key)".into(),
            ));
        }
        if k.to_lowercase().ends_with(".pub") {
            return Err(AppError::InvalidInput(
                "choisissez la clé privée, pas le fichier .pub".into(),
            ));
        }
    }
    Ok((name, host, port, user, key_path))
}

pub fn list(db: &Database) -> AppResult<Vec<Server>> {
    db.with(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id, name, host, port, user, key_path FROM servers ORDER BY name COLLATE NOCASE",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(Server {
                id: r.get(0)?,
                name: r.get(1)?,
                host: r.get(2)?,
                port: r.get::<_, i64>(3)? as u16,
                user: r.get(4)?,
                key_path: r.get(5)?,
            })
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    })
}

pub fn get(db: &Database, id: i64) -> AppResult<Server> {
    list(db)?
        .into_iter()
        .find(|s| s.id == id)
        .ok_or_else(|| AppError::InvalidInput(format!("serveur {id} inconnu")))
}

pub fn save(db: &Database, input: &ServerInput) -> AppResult<Vec<Server>> {
    let (name, host, port, user, key_path) = validate(input)?;
    db.with(|conn| {
        match input.id {
            Some(id) => {
                let n = conn.execute(
                    "UPDATE servers SET name = ?1, host = ?2, port = ?3, user = ?4, key_path = ?5 WHERE id = ?6",
                    params![name, host, port, user, key_path, id],
                )?;
                if n == 0 {
                    return Err(AppError::InvalidInput(format!("serveur {id} inconnu")));
                }
            }
            None => {
                conn.execute(
                    "INSERT INTO servers (name, host, port, user, key_path) VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![name, host, port, user, key_path],
                )?;
            }
        }
        Ok(())
    })?;
    list(db)
}

pub fn delete(db: &Database, id: i64) -> AppResult<Vec<Server>> {
    db.with(|conn| {
        conn.execute("DELETE FROM servers WHERE id = ?1", params![id])?;
        Ok(())
    })?;
    list(db)
}

/// Clés privées trouvées dans `~/.ssh` (proposées dans le formulaire).
pub fn find_keys() -> Vec<String> {
    let Some(home) = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")) else {
        return Vec::new();
    };
    let dir = Path::new(&home).join(".ssh");
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut keys: Vec<String> = entries
        .flatten()
        .filter(|e| e.path().is_file())
        .filter_map(|e| {
            let path = e.path();
            let name = path.file_name()?.to_string_lossy().to_lowercase();
            let skip = name.ends_with(".pub")
                || name.ends_with(".ppk")
                || name.starts_with("known_hosts")
                || name == "config"
                || name == "authorized_keys";
            if skip {
                return None;
            }
            // Une clé privée OpenSSH commence par « -----BEGIN ».
            let head = std::fs::read(&path).ok()?;
            head.starts_with(b"-----BEGIN")
                .then(|| path.display().to_string())
        })
        .collect();
    keys.sort();
    keys
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(host: &str) -> ServerInput {
        ServerInput {
            id: None,
            name: "vps".into(),
            host: host.into(),
            port: None,
            user: Some("deploy".into()),
            key_path: None,
        }
    }

    #[test]
    fn validates_hosts_and_users() {
        assert!(validate(&input("example.org")).is_ok());
        assert!(validate(&input("192.168.1.10")).is_ok());
        assert!(validate(&input("[::1]")).is_ok());
        assert!(validate(&input("-oProxyCommand=calc")).is_err());
        assert!(validate(&input("host;rm")).is_err());
        let mut bad_user = input("example.org");
        bad_user.user = Some("-l root".into());
        assert!(validate(&bad_user).is_err());
        let mut ppk = input("example.org");
        ppk.key_path = Some("C:\\keys\\a.ppk".into());
        assert!(validate(&ppk).is_err());
    }
}
