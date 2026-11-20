//! Sauvegarde / synchronisation de la configuration via un fichier JSON.
//!
//! Le fichier peut être placé dans un dossier synchronisé (OneDrive, Dropbox…) pour retrouver
//! sa configuration sur un autre PC. Il ne contient aucun secret : chemins de clés SSH oui,
//! clés elles-mêmes non ; les appareils appairés ne sont pas exportés.
//!
//! À l'import (fusion) : projets et applications sont dédoublonnés par chemin, serveurs par
//! hôte/port/utilisateur, commandes serveur par nom et serveur, tunnels SSH par serveur et nom, workspaces et automatisations par nom. Les identifiants internes
//! référencés dans les étapes sont réécrits vers ceux de la machine cible.

use std::collections::HashMap;
use std::path::Path;

use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::database::Database;
use crate::error::{AppError, AppResult};

const FORMAT: &str = "devcenter-config";
const VERSION: u32 = 1;

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Bundle {
    pub format: String,
    pub version: u32,
    pub exported_at: i64,
    #[serde(default)]
    pub settings: Vec<(String, String)>,
    #[serde(default)]
    pub apps: Vec<AppRow>,
    #[serde(default)]
    pub projects: Vec<ProjectRow>,
    #[serde(default)]
    pub servers: Vec<ServerRow>,
    #[serde(default)]
    pub snippets: Vec<SnippetRow>,
    pub tunnels: Vec<TunnelRow>,
    #[serde(default)]
    pub workspaces: Vec<WorkspaceRow>,
    #[serde(default)]
    pub automations: Vec<AutomationRow>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppRow {
    pub id: i64,
    pub name: String,
    pub path: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRow {
    pub id: i64,
    pub name: String,
    pub path: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerRow {
    pub id: i64,
    pub name: String,
    pub host: String,
    pub port: i64,
    pub user: Option<String>,
    pub key_path: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnippetRow {
    pub id: i64,
    pub name: String,
    pub command: String,
    /// `None` = commande globale.
    pub server_id: Option<i64>,
    pub confirm: bool,
    pub sudo: bool,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelRow {
    pub id: i64,
    pub server_id: i64,
    pub name: String,
    pub kind: String,
    pub bind_address: String,
    pub local_port: i64,
    pub remote_host: Option<String>,
    pub remote_port: Option<i64>,
    pub auto_start: bool,
    pub auto_restart: bool,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRow {
    pub id: i64,
    pub name: String,
    pub description: String,
    pub favorite: bool,
    pub steps: Vec<Value>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationRow {
    pub name: String,
    pub description: String,
    pub enabled: bool,
    pub trigger: Value,
    pub steps: Vec<Value>,
    pub on_error: Value,
    pub timeout_minutes: i64,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ImportSummary {
    pub added: HashMap<String, u32>,
    pub skipped: HashMap<String, u32>,
}

impl ImportSummary {
    fn add(&mut self, kind: &str) {
        *self.added.entry(kind.into()).or_default() += 1;
    }
    fn skip(&mut self, kind: &str) {
        *self.skipped.entry(kind.into()).or_default() += 1;
    }
}

fn check_json_path(path: &str) -> AppResult<&Path> {
    let p = Path::new(path);
    let ext_ok = p.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case("json"));
    if !p.is_absolute() || !ext_ok {
        return Err(AppError::InvalidInput("choisissez un fichier .json".into()));
    }
    Ok(p)
}

pub fn build(db: &Database) -> AppResult<Bundle> {
    db.with(|conn| {
        let collect = |sql: &str| -> rusqlite::Result<Vec<Vec<Value>>> {
            let mut stmt = conn.prepare(sql)?;
            let n = stmt.column_count();
            let rows = stmt.query_map([], |r| {
                (0..n)
                    .map(|i| {
                        Ok(match r.get_ref(i)? {
                            rusqlite::types::ValueRef::Null => Value::Null,
                            rusqlite::types::ValueRef::Integer(v) => Value::from(v),
                            rusqlite::types::ValueRef::Real(v) => Value::from(v),
                            rusqlite::types::ValueRef::Text(t) => Value::from(String::from_utf8_lossy(t).into_owned()),
                            rusqlite::types::ValueRef::Blob(_) => Value::Null,
                        })
                    })
                    .collect()
            })?;
            rows.collect()
        };
        let s = |v: &Value| v.as_str().unwrap_or_default().to_string();
        let i = |v: &Value| v.as_i64().unwrap_or_default();
        let parse = |v: &Value| serde_json::from_str::<Value>(v.as_str().unwrap_or("null")).unwrap_or(Value::Null);

        let mut bundle = Bundle {
            format: FORMAT.into(),
            version: VERSION,
            exported_at: crate::modules::automations::now(),
            ..Default::default()
        };
        // Paramètres : l'éditeur et le thème ; pas les réglages propres à la machine (accès distant).
        bundle.settings = collect("SELECT key, value FROM settings WHERE key IN ('theme', 'closeToTray', 'editorPath')")?
            .iter()
            .map(|r| (s(&r[0]), s(&r[1])))
            .collect();
        bundle.apps = collect("SELECT id, name, path FROM app_shortcuts")?.iter().map(|r| AppRow { id: i(&r[0]), name: s(&r[1]), path: s(&r[2]) }).collect();
        bundle.projects = collect("SELECT id, name, path FROM projects")?.iter().map(|r| ProjectRow { id: i(&r[0]), name: s(&r[1]), path: s(&r[2]) }).collect();
        bundle.servers = collect("SELECT id, name, host, port, user, key_path FROM servers")?
            .iter()
            .map(|r| ServerRow { id: i(&r[0]), name: s(&r[1]), host: s(&r[2]), port: i(&r[3]), user: r[4].as_str().map(str::to_string), key_path: r[5].as_str().map(str::to_string) })
            .collect();
        bundle.snippets = collect("SELECT id, name, command, server_id, confirm, sudo FROM server_snippets")?
            .iter()
            .map(|r| SnippetRow { id: i(&r[0]), name: s(&r[1]), command: s(&r[2]), server_id: r[3].as_i64(), confirm: i(&r[4]) != 0, sudo: i(&r[5]) != 0 })
            .collect();
        bundle.tunnels = collect(
            "SELECT id, server_id, name, kind, bind_address, local_port, remote_host, remote_port, auto_start, auto_restart FROM ssh_tunnels",
        )?
        .iter()
        .map(|r| TunnelRow {
            id: i(&r[0]),
            server_id: i(&r[1]),
            name: s(&r[2]),
            kind: s(&r[3]),
            bind_address: s(&r[4]),
            local_port: i(&r[5]),
            remote_host: r[6].as_str().map(str::to_string),
            remote_port: r[7].as_i64(),
            auto_start: i(&r[8]) != 0,
            auto_restart: i(&r[9]) != 0,
        })
        .collect();
        let steps_of = |ws_id: i64| -> rusqlite::Result<Vec<Value>> {
            let mut stmt = conn.prepare("SELECT action FROM workspace_steps WHERE workspace_id = ?1 ORDER BY position")?;
            let rows = stmt.query_map(params![ws_id], |r| r.get::<_, String>(0))?;
            Ok(rows.filter_map(|r| r.ok()).filter_map(|j| serde_json::from_str(&j).ok()).collect())
        };
        for r in collect("SELECT id, name, description, favorite FROM workspaces")? {
            bundle.workspaces.push(WorkspaceRow { id: i(&r[0]), name: s(&r[1]), description: s(&r[2]), favorite: i(&r[3]) != 0, steps: steps_of(i(&r[0]))? });
        }
        bundle.automations = collect("SELECT name, description, enabled, trigger, steps, on_error, timeout_minutes FROM automations")?
            .iter()
            .map(|r| AutomationRow {
                name: s(&r[0]),
                description: s(&r[1]),
                enabled: i(&r[2]) != 0,
                trigger: parse(&r[3]),
                steps: parse(&r[4]).as_array().cloned().unwrap_or_default(),
                on_error: parse(&r[5]),
                timeout_minutes: i(&r[6]),
            })
            .collect();
        Ok(bundle)
    })
}

pub fn export(db: &Database, path: &str) -> AppResult<()> {
    let p = check_json_path(path)?;
    let bundle = build(db)?;
    let json = serde_json::to_string_pretty(&bundle).map_err(|e| AppError::InvalidInput(e.to_string()))?;
    std::fs::write(p, json)?;
    Ok(())
}

/// Réécrit récursivement les identifiants (`projectId`, `appId`, `workspaceId`, `serverId`,
/// `snippetId`, `tunnelId`). Une référence `null` (facultative) est conservée telle quelle.
fn remap(value: &mut Value, maps: &HashMap<&str, HashMap<i64, i64>>) -> bool {
    let mut ok = true;
    match value {
        Value::Object(obj) => {
            for (key, v) in obj.iter_mut() {
                if let Some(map) = maps.get(key.as_str()) {
                    if v.is_null() {
                        continue;
                    }
                    match v.as_i64().and_then(|old| map.get(&old)) {
                        Some(new) => *v = Value::from(*new),
                        None => ok = false, // référence vers un élément absent du fichier
                    }
                } else {
                    ok &= remap(v, maps);
                }
            }
        }
        Value::Array(arr) => {
            for v in arr {
                ok &= remap(v, maps);
            }
        }
        _ => {}
    }
    ok
}

pub fn import(db: &Database, path: &str) -> AppResult<ImportSummary> {
    let p = check_json_path(path)?;
    let meta = std::fs::metadata(p)?;
    if meta.len() > 10 * 1024 * 1024 {
        return Err(AppError::InvalidInput("fichier trop volumineux".into()));
    }
    let bundle: Bundle = serde_json::from_str(&std::fs::read_to_string(p)?)
        .map_err(|e| AppError::InvalidInput(format!("fichier invalide : {e}")))?;
    if bundle.format != FORMAT || bundle.version > VERSION {
        return Err(AppError::InvalidInput("ce fichier n'est pas une sauvegarde DevCenter compatible".into()));
    }

    let mut summary = ImportSummary::default();
    db.with(|conn| {
        let tx = conn.unchecked_transaction()?;
        let find = |sql: &str, args: &[&dyn rusqlite::ToSql]| -> rusqlite::Result<Option<i64>> {
            tx.query_row(sql, args, |r| r.get(0)).optional()
        };

        for (key, value) in &bundle.settings {
            if ["theme", "closeToTray", "editorPath"].contains(&key.as_str()) {
                tx.execute("INSERT OR IGNORE INTO settings (key, value) VALUES (?1, ?2)", params![key, value])?;
            }
        }

        let mut apps = HashMap::new();
        for a in &bundle.apps {
            let id = match find("SELECT id FROM app_shortcuts WHERE path = ?1 COLLATE NOCASE", &[&a.path])? {
                Some(id) => {
                    summary.skip("applications");
                    id
                }
                None => {
                    tx.execute("INSERT INTO app_shortcuts (name, path) VALUES (?1, ?2)", params![a.name, a.path])?;
                    summary.add("applications");
                    tx.last_insert_rowid()
                }
            };
            apps.insert(a.id, id);
        }

        let mut projects = HashMap::new();
        for pr in &bundle.projects {
            let id = match find("SELECT id FROM projects WHERE path = ?1", &[&pr.path])? {
                Some(id) => {
                    summary.skip("projets");
                    id
                }
                None => {
                    tx.execute(
                        "INSERT INTO projects (name, path, added_at) VALUES (?1, ?2, ?3)",
                        params![pr.name, pr.path, crate::modules::automations::now()],
                    )?;
                    summary.add("projets");
                    tx.last_insert_rowid()
                }
            };
            projects.insert(pr.id, id);
        }

        let mut servers = HashMap::new();
        for s in &bundle.servers {
            let existing = find(
                "SELECT id FROM servers WHERE host = ?1 AND port = ?2 AND COALESCE(user, '') = COALESCE(?3, '')",
                &[&s.host, &s.port, &s.user],
            )?;
            let id = match existing {
                Some(id) => {
                    summary.skip("serveurs");
                    id
                }
                None => {
                    tx.execute(
                        "INSERT INTO servers (name, host, port, user, key_path) VALUES (?1, ?2, ?3, ?4, ?5)",
                        params![s.name, s.host, s.port, s.user, s.key_path],
                    )?;
                    summary.add("serveurs");
                    tx.last_insert_rowid()
                }
            };
            servers.insert(s.id, id);
        }

        let mut snippets = HashMap::new();
        for sn in &bundle.snippets {
            let server_id = match sn.server_id {
                Some(old) => match servers.get(&old) {
                    Some(new) => Some(*new),
                    None => {
                        summary.skip("commandes");
                        continue;
                    }
                },
                None => None,
            };
            let existing = find(
                "SELECT id FROM server_snippets WHERE name = ?1 AND COALESCE(server_id, -1) = COALESCE(?2, -1)",
                &[&sn.name, &server_id],
            )?;
            let id = match existing {
                Some(id) => {
                    summary.skip("commandes");
                    id
                }
                None => {
                    tx.execute(
                        "INSERT INTO server_snippets (name, command, server_id, confirm, sudo, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                        params![sn.name, sn.command, server_id, sn.confirm as i64, sn.sudo as i64, crate::modules::automations::now()],
                    )?;
                    summary.add("commandes");
                    tx.last_insert_rowid()
                }
            };
            snippets.insert(sn.id, id);
        }

        // Tunnels : rattachés au serveur importé, dédoublonnés par serveur + nom. Les valeurs sont
        // revalidées (le fichier a pu être modifié à la main) : ssh ne reçoit jamais d'option déguisée.
        let mut tunnels = HashMap::new();
        for t in &bundle.tunnels {
            let Some(&server_id) = servers.get(&t.server_id) else {
                summary.skip("tunnels");
                continue;
            };
            let kind = match t.kind.as_str() {
                k @ ("local" | "remote" | "dynamic") => k,
                _ => {
                    summary.skip("tunnels");
                    continue;
                }
            };
            let port_ok = |p: i64| (1..=65535).contains(&p);
            let valid = !t.name.trim().is_empty()
                && t.name.len() <= 80
                && port_ok(t.local_port)
                && crate::modules::servers::tunnels::validate_host(&t.bind_address, "adresse").is_ok()
                && (kind == "dynamic"
                    || (t.remote_port.is_some_and(port_ok)
                        && t.remote_host.as_deref().is_some_and(|h| crate::modules::servers::tunnels::validate_host(h, "hôte").is_ok())));
            if !valid {
                summary.skip("tunnels");
                continue;
            }
            let (remote_host, remote_port) = if kind == "dynamic" { (None, None) } else { (t.remote_host.clone(), t.remote_port) };
            let id = match find("SELECT id FROM ssh_tunnels WHERE server_id = ?1 AND name = ?2", &[&server_id, &t.name])? {
                Some(id) => {
                    summary.skip("tunnels");
                    id
                }
                None => {
                    tx.execute(
                        "INSERT INTO ssh_tunnels (server_id, name, kind, bind_address, local_port, remote_host, remote_port, auto_start, auto_restart)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                        params![server_id, t.name.trim(), kind, t.bind_address, t.local_port, remote_host, remote_port, t.auto_start as i64, t.auto_restart as i64],
                    )?;
                    summary.add("tunnels");
                    tx.last_insert_rowid()
                }
            };
            tunnels.insert(t.id, id);
        }

        let mut maps: HashMap<&str, HashMap<i64, i64>> = HashMap::new();
        maps.insert("appId", apps);
        maps.insert("projectId", projects);
        maps.insert("serverId", servers);
        maps.insert("snippetId", snippets);
        maps.insert("tunnelId", tunnels);

        let mut workspaces = HashMap::new();
        for w in &bundle.workspaces {
            if let Some(id) = find("SELECT id FROM workspaces WHERE name = ?1", &[&w.name])? {
                workspaces.insert(w.id, id);
                summary.skip("workspaces");
                continue;
            }
            let mut steps = w.steps.clone();
            let ok = steps.iter_mut().all(|s| remap(s, &maps));
            if !ok {
                summary.skip("workspaces");
                continue;
            }
            tx.execute(
                "INSERT INTO workspaces (name, description, favorite, created_at) VALUES (?1, ?2, ?3, ?4)",
                params![w.name, w.description, w.favorite as i64, crate::modules::automations::now()],
            )?;
            let id = tx.last_insert_rowid();
            for (pos, step) in steps.iter().enumerate() {
                tx.execute(
                    "INSERT INTO workspace_steps (workspace_id, position, action) VALUES (?1, ?2, ?3)",
                    params![id, pos as i64, step.to_string()],
                )?;
            }
            workspaces.insert(w.id, id);
            summary.add("workspaces");
        }
        maps.insert("workspaceId", workspaces);

        for a in &bundle.automations {
            if find("SELECT id FROM automations WHERE name = ?1", &[&a.name])?.is_some() {
                summary.skip("automatisations");
                continue;
            }
            let mut steps = Value::Array(a.steps.clone());
            if !remap(&mut steps, &maps) {
                summary.skip("automatisations");
                continue;
            }
            // Désactivée à l'import : l'utilisateur la vérifie avant qu'elle ne se déclenche.
            tx.execute(
                "INSERT INTO automations (name, description, enabled, trigger, steps, on_error, timeout_minutes, created_at)
                 VALUES (?1, ?2, 0, ?3, ?4, ?5, ?6, ?7)",
                params![a.name, a.description, a.trigger.to_string(), steps.to_string(), a.on_error.to_string(), a.timeout_minutes.clamp(1, 1440), crate::modules::automations::now()],
            )?;
            summary.add("automatisations");
        }

        tx.commit()?;
        Ok(())
    })?;
    Ok(summary)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_db(tag: &str) -> (Database, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("devcenter-backup-{tag}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        (Database::open(&dir.join(format!("{tag}.db"))).unwrap(), dir)
    }

    #[test]
    fn export_import_round_trip_remaps_ids() {
        let (src, dir) = temp_db("src");
        let proj = dir.join("proj");
        std::fs::create_dir_all(&proj).unwrap();
        let p = proj.display().to_string();
        src.with(|c| {
            // Décale les identifiants pour vérifier la réécriture.
            c.execute("INSERT INTO projects (id, name, path, added_at) VALUES (7, 'proj', ?1, 0)", params![p])?;
            c.execute("INSERT INTO workspaces (id, name, description, favorite, created_at) VALUES (3, 'Front', '', 1, 0)", [])?;
            c.execute("INSERT INTO servers (id, name, host, port) VALUES (5, 'vps', 'example.org', 22)", [])?;
            c.execute("INSERT INTO server_snippets (id, name, command, server_id, confirm, sudo, created_at) VALUES (9, 'Disque', 'df -h', 5, 0, 0, 0)", [])?;
            c.execute("INSERT INTO server_snippets (id, name, command, server_id, confirm, sudo, created_at) VALUES (11, 'Mémoire', 'free -h', NULL, 1, 1, 0)", [])?;
            c.execute("INSERT INTO workspace_steps (workspace_id, position, action) VALUES (3, 0, '{\"kind\":\"editor\",\"projectId\":7}')", [])?;
            c.execute("INSERT INTO servers (id, name, host, port) VALUES (4, 'vps', 'example.org', 22)", [])?;
            c.execute("INSERT INTO ssh_tunnels (id, server_id, name, kind, local_port, remote_host, remote_port) VALUES (9, 4, 'db', 'local', 5433, 'localhost', 5432)", [])?;
            c.execute("INSERT INTO workspace_steps (workspace_id, position, action) VALUES (3, 1, '{\"kind\":\"tunnelOpen\",\"tunnelId\":9}')", [])?;
            c.execute(
                "INSERT INTO automations (name, description, enabled, trigger, steps, on_error, timeout_minutes, created_at)
                 VALUES ('Matin', '', 1, '{\"kind\":\"manual\"}', '[{\"kind\":\"startWorkspace\",\"workspaceId\":3},{\"kind\":\"sshCommand\",\"serverId\":5,\"snippetId\":9},{\"kind\":\"sshCommand\",\"serverId\":5,\"snippetId\":null,\"command\":\"uptime\"}]', '\"stop\"', 30, 0)",
                [],
            )?;
            Ok(())
        })
        .unwrap();
        let file = dir.join("backup.json");
        export(&src, file.to_str().unwrap()).unwrap();

        let (dst, _) = temp_db("dst");
        let summary = import(&dst, file.to_str().unwrap()).unwrap();
        assert_eq!(summary.added.get("projets"), Some(&1));
        assert_eq!(summary.added.get("workspaces"), Some(&1));
        assert_eq!(summary.added.get("automatisations"), Some(&1));
        assert_eq!(summary.added.get("commandes"), Some(&2));

        let (pid, wid): (i64, i64) = dst
            .with(|c| Ok((c.query_row("SELECT id FROM projects", [], |r| r.get(0))?, c.query_row("SELECT id FROM workspaces", [], |r| r.get(0))?)))
            .unwrap();
        let step: String = dst.with(|c| Ok(c.query_row("SELECT action FROM workspace_steps WHERE position = 0", [], |r| r.get(0))?)).unwrap();
        assert!(step.contains(&format!("\"projectId\":{pid}")));
        assert_eq!(summary.added.get("tunnels"), Some(&1));
        let tid: i64 = dst.with(|c| Ok(c.query_row("SELECT id FROM ssh_tunnels", [], |r| r.get(0))?)).unwrap();
        let tstep: String = dst.with(|c| Ok(c.query_row("SELECT action FROM workspace_steps WHERE position = 1", [], |r| r.get(0))?)).unwrap();
        assert!(tstep.contains(&format!("\"tunnelId\":{tid}")));
        let (steps, enabled): (String, i64) = dst.with(|c| Ok(c.query_row("SELECT steps, enabled FROM automations", [], |r| Ok((r.get(0)?, r.get(1)?)))?)).unwrap();
        assert!(steps.contains(&format!("\"workspaceId\":{wid}")));
        let (sid, snid): (i64, i64) = dst
            .with(|c| Ok((c.query_row("SELECT id FROM servers", [], |r| r.get(0))?, c.query_row("SELECT id FROM server_snippets WHERE name = 'Disque'", [], |r| r.get(0))?)))
            .unwrap();
        assert!(steps.contains(&format!("\"snippetId\":{snid}")));
        assert!(steps.contains(&format!("\"serverId\":{sid}")));
        assert!(steps.contains("\"snippetId\":null"));
        let global: Option<i64> = dst.with(|c| Ok(c.query_row("SELECT server_id FROM server_snippets WHERE name = 'Mémoire'", [], |r| r.get(0))?)).unwrap();
        assert_eq!(global, None);
        assert_eq!(enabled, 0);

        // Second import : tout est déjà présent.
        let again = import(&dst, file.to_str().unwrap()).unwrap();
        assert!(again.added.is_empty());
        assert!(import(&dst, "relatif.json").is_err());
        std::fs::remove_dir_all(&dir).ok();
    }
}
