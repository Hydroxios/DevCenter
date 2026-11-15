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
];

pub struct Database {
    conn: Mutex<Connection>,
}

impl Database {
    pub fn open(path: &Path) -> AppResult<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        let db = Self { conn: Mutex::new(conn) };
        db.migrate()?;
        Ok(db)
    }

    fn migrate(&self) -> AppResult<()> {
        let mut conn = self.conn.lock()?;
        let current: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
        for (i, sql) in MIGRATIONS.iter().enumerate().skip(current.max(0) as usize) {
            let tx = conn.transaction()?;
            tx.execute_batch(sql)?;
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
