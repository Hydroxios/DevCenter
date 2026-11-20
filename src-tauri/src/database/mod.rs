use std::path::Path;
use std::sync::Mutex;

use rusqlite::Connection;

use crate::error::AppResult;

/// Migrations appliquées dans l'ordre. L'index (+1) correspond à `PRAGMA user_version`.
/// Ne jamais modifier une migration existante : en ajouter une nouvelle.
const MIGRATIONS: &[&str] = &[
    // 1 — paramètres clé/valeur
    "CREATE TABLE settings (
        key   TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL
    );",
    // 2 — raccourcis d'applications (System Manager)
    "CREATE TABLE app_shortcuts (
        id   INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        path TEXT NOT NULL
    );",
    // 3 — projets (Project Manager)
    "CREATE TABLE projects (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,
        name     TEXT NOT NULL,
        path     TEXT NOT NULL UNIQUE COLLATE NOCASE,
        added_at INTEGER NOT NULL
    );",
    // 4 — workspaces, étapes et historique des sessions (Workspace Manager)
    "CREATE TABLE workspaces (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        name        TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        favorite    INTEGER NOT NULL DEFAULT 0,
        created_at  INTEGER NOT NULL
    );
    CREATE TABLE workspace_steps (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        position     INTEGER NOT NULL,
        action       TEXT NOT NULL
    );
    CREATE INDEX idx_workspace_steps ON workspace_steps(workspace_id, position);
    CREATE TABLE workspace_sessions (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        workspace_id   INTEGER REFERENCES workspaces(id) ON DELETE SET NULL,
        workspace_name TEXT NOT NULL,
        started_at     INTEGER NOT NULL,
        ended_at       INTEGER,
        status         TEXT NOT NULL,
        results        TEXT NOT NULL DEFAULT '[]'
    );
    CREATE INDEX idx_workspace_sessions_started ON workspace_sessions(started_at);",
    // 5 — serveurs SSH (Server Manager). Aucun secret : seulement le chemin de la clé.
    "CREATE TABLE servers (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,
        name     TEXT NOT NULL,
        host     TEXT NOT NULL,
        port     INTEGER NOT NULL DEFAULT 22,
        user     TEXT,
        key_path TEXT
    );",
    // 6 — automatisations et historique des exécutions (Automation Engine)
    "CREATE TABLE automations (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        name            TEXT NOT NULL,
        description     TEXT NOT NULL DEFAULT '',
        enabled         INTEGER NOT NULL DEFAULT 1,
        trigger         TEXT NOT NULL,
        steps           TEXT NOT NULL,
        on_error        TEXT NOT NULL DEFAULT '\"stop\"',
        timeout_minutes INTEGER NOT NULL DEFAULT 30,
        created_at      INTEGER NOT NULL
    );
    CREATE TABLE automation_runs (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        automation_id   INTEGER REFERENCES automations(id) ON DELETE SET NULL,
        automation_name TEXT NOT NULL,
        origin          TEXT NOT NULL,
        started_at      INTEGER NOT NULL,
        ended_at        INTEGER,
        status          TEXT NOT NULL,
        log             TEXT NOT NULL DEFAULT '[]'
    );
    CREATE INDEX idx_automation_runs ON automation_runs(automation_id, started_at);",
    // 7 — appareils appairés pour l'accès à distance (empreinte SHA-256 du jeton uniquement)
    "CREATE TABLE remote_devices (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        name       TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        last_seen  INTEGER
    );",
    // 8 — notifications push : clés VAPID et abonnements des appareils appairés
    "CREATE TABLE app_secrets (
        key   TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL
    );
    CREATE TABLE push_subscriptions (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        device_id  INTEGER NOT NULL REFERENCES remote_devices(id) ON DELETE CASCADE,
        endpoint   TEXT NOT NULL UNIQUE,
        p256dh     TEXT NOT NULL,
        auth       TEXT NOT NULL,
        created_at INTEGER NOT NULL
    );",
    // 9 — profil .env actif par projet (injecté dans les scripts lancés depuis DevCenter)
    "ALTER TABLE projects ADD COLUMN env_file TEXT;",
    // 10 — santé des dépendances : dernier rapport par projet (JSON), relancé à la demande
    "CREATE TABLE IF NOT EXISTS dependency_reports (
        project_id INTEGER PRIMARY KEY NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        checked_at INTEGER NOT NULL,
        report     TEXT NOT NULL
    );",
    // 11 — historique des exécutions de scripts (statistiques de temps par projet)
    "CREATE TABLE IF NOT EXISTS script_runs (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        script     TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        ended_at   INTEGER,
        status     TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_script_runs_started ON script_runs(started_at);",
    // 12 — commandes enregistrées des serveurs (server_id NULL = disponible sur tous les serveurs)
    "CREATE TABLE IF NOT EXISTS server_snippets (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        name       TEXT NOT NULL,
        command    TEXT NOT NULL,
        server_id  INTEGER REFERENCES servers(id) ON DELETE CASCADE,
        confirm    INTEGER NOT NULL DEFAULT 0,
        sudo       INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_server_snippets_server ON server_snippets(server_id);",
    // 13 — tunnels SSH (redirections de ports -L / -R / -D) par serveur
    "CREATE TABLE IF NOT EXISTS ssh_tunnels (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        server_id    INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
        name         TEXT NOT NULL,
        kind         TEXT NOT NULL,
        bind_address TEXT NOT NULL DEFAULT '127.0.0.1',
        local_port   INTEGER NOT NULL,
        remote_host  TEXT,
        remote_port  INTEGER,
        auto_start   INTEGER NOT NULL DEFAULT 0,
        auto_restart INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_ssh_tunnels_server ON ssh_tunnels(server_id);",
    // 14 — contexte des exécutions déclenchées par un événement (projet, script, serveur…)
    "ALTER TABLE automation_runs ADD COLUMN context TEXT;",
];

pub struct Database {
    conn: Mutex<Connection>,
}

/// Applique une migration. Les migrations 9 et suivantes sont idempotentes : elles ont été
/// développées en parallèle sur des branches qui portaient toutes le numéro 9, si bien qu'une base
/// peut déjà contenir une partie de ce schéma. Les tables et index utilisent `IF NOT EXISTS` ;
/// un `ALTER TABLE … ADD COLUMN` (qui n'a pas d'équivalent) est ignoré si la colonne existe.
fn apply(conn: &Connection, sql: &str) -> rusqlite::Result<()> {
    if let Some((table, column)) = add_column_target(sql) {
        let exists = conn
            .prepare(&format!(
                "SELECT 1 FROM pragma_table_info('{table}') WHERE name = ?1"
            ))?
            .exists([column])?;
        if exists {
            return Ok(());
        }
    }
    conn.execute_batch(sql)
}

/// `ALTER TABLE t ADD COLUMN c …` → (`t`, `c`), pour une migration réduite à cette instruction.
fn add_column_target(sql: &str) -> Option<(&str, &str)> {
    let words: Vec<&str> = sql.split_whitespace().collect();
    match words.as_slice() {
        ["ALTER", "TABLE", table, "ADD", "COLUMN", column, ..]
            if !sql.trim_end().trim_end_matches(';').contains(';') =>
        {
            let ok =
                |w: &str| !w.is_empty() && w.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
            (ok(table) && ok(column)).then_some((*table, *column))
        }
        _ => None,
    }
}

impl Database {
    pub fn open(path: &Path) -> AppResult<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        let db = Self {
            conn: Mutex::new(conn),
        };
        db.migrate()?;
        Ok(db)
    }

    fn migrate(&self) -> AppResult<()> {
        let mut conn = self.conn.lock()?;
        let current: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
        for (i, sql) in MIGRATIONS.iter().enumerate().skip(current.max(0) as usize) {
            let tx = conn.transaction()?;
            apply(&tx, sql)?;
            tx.pragma_update(None, "user_version", (i + 1) as i64)?;
            tx.commit()?;
        }
        Ok(())
    }

    /// Exécute une fonction avec la connexion verrouillée.
    pub fn with<T>(&self, f: impl FnOnce(&Connection) -> AppResult<T>) -> AppResult<T> {
        let conn = self.conn.lock()?;
        f(&conn)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Une base déjà en version 9 qui contient tout le schéma des branches parallèles (le cas d'un
    /// poste de développement) doit migrer sans erreur jusqu'à la dernière version.
    #[test]
    fn migrations_from_9_are_idempotent() {
        let path =
            std::env::temp_dir().join(format!("devcenter-migrate-{}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        {
            let db = Database::open(&path).unwrap();
            db.with(|c| Ok(c.pragma_update(None, "user_version", 9)?))
                .unwrap();
        }
        let db = Database::open(&path).unwrap();
        let version: i64 = db
            .with(|c| Ok(c.pragma_query_value(None, "user_version", |r| r.get(0))?))
            .unwrap();
        assert_eq!(version, MIGRATIONS.len() as i64);
        let has = |sql: &str| db.with(|c| Ok(c.prepare(sql)?.exists([])?)).unwrap();
        assert!(has(
            "SELECT 1 FROM pragma_table_info('projects') WHERE name = 'env_file'"
        ));
        assert!(has(
            "SELECT 1 FROM pragma_table_info('automation_runs') WHERE name = 'context'"
        ));
        drop(db);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn detects_add_column() {
        assert_eq!(
            add_column_target("ALTER TABLE projects ADD COLUMN env_file TEXT;"),
            Some(("projects", "env_file"))
        );
        assert_eq!(add_column_target("CREATE TABLE x (a INT);"), None);
        assert_eq!(
            add_column_target("ALTER TABLE a ADD COLUMN b INT; DROP TABLE c;"),
            None
        );
    }
}
