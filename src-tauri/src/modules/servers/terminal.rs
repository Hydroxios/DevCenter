//! Terminal SSH interactif : `ssh.exe` dans un pseudo-terminal (ConPTY sous Windows),
//! relié à xterm.js via des événements Tauri.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use portable_pty::{Child, CommandBuilder, MasterPty, PtySize, native_pty_system};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::error::{AppError, AppResult};

use super::{Server, ssh};

pub const EVENT_DATA: &str = "terminal://data";
pub const EVENT_EXIT: &str = "terminal://exit";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DataEvent {
    id: u64,
    data: String,
}

struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

#[derive(Default)]
pub struct Terminals {
    sessions: Arc<Mutex<HashMap<u64, Session>>>,
    next_id: AtomicU64,
}

fn pty_err(e: impl std::fmt::Display) -> AppError {
    AppError::InvalidInput(format!("terminal : {e}"))
}

fn size(cols: u16, rows: u16) -> PtySize {
    PtySize { rows: rows.clamp(5, 500), cols: cols.clamp(10, 1000), pixel_width: 0, pixel_height: 0 }
}

/// Découpe un flux d'octets en texte UTF-8 sans casser les caractères à cheval sur deux lectures.
fn take_utf8(pending: &mut Vec<u8>) -> String {
    match std::str::from_utf8(pending) {
        Ok(s) => {
            let out = s.to_string();
            pending.clear();
            out
        }
        Err(e) => {
            let valid = e.valid_up_to();
            // Séquence invalide (et pas seulement incomplète) : on la remplace.
            if e.error_len().is_some() {
                let out = String::from_utf8_lossy(pending).into_owned();
                pending.clear();
                return out;
            }
            let out = String::from_utf8_lossy(&pending[..valid]).into_owned();
            pending.drain(..valid);
            out
        }
    }
}

impl Terminals {
    /// Session SSH interactive.
    pub fn open(&self, app: &AppHandle, server: &Server, cols: u16, rows: u16) -> AppResult<u64> {
        let mut cmd = CommandBuilder::new("ssh");
        // Interactif : pas de BatchMode (permet la phrase de passe de la clé), terminal forcé.
        cmd.arg("-t");
        for arg in ssh::base_args(server, false) {
            cmd.arg(arg);
        }
        self.spawn(app, cmd, cols, rows)
    }

    /// `ssh-add` interactif : l'utilisateur saisit la phrase de passe dans le terminal,
    /// elle va directement à l'agent SSH sans passer par DevCenter.
    pub fn open_ssh_add(&self, app: &AppHandle, key_path: Option<&str>, cols: u16, rows: u16) -> AppResult<u64> {
        let mut cmd = CommandBuilder::new("ssh-add");
        if let Some(k) = key_path {
            cmd.arg(k);
        }
        self.spawn(app, cmd, cols, rows)
    }

    /// Connexion GitHub interactive (`gh auth login` : code à usage unique + navigateur).
    pub fn open_gh_login(&self, app: &AppHandle, cols: u16, rows: u16) -> AppResult<u64> {
        let exe = crate::modules::github::exe().ok_or_else(|| AppError::InvalidInput("GitHub CLI (gh) n'est pas installé".into()))?;
        let mut cmd = CommandBuilder::new(exe);
        cmd.args(["auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--web"]);
        self.spawn(app, cmd, cols, rows)
    }

    fn spawn(&self, app: &AppHandle, mut cmd: CommandBuilder, cols: u16, rows: u16) -> AppResult<u64> {
        let pair = native_pty_system().openpty(size(cols, rows)).map_err(pty_err)?;
        if let Some(home) = std::env::var_os("USERPROFILE") {
            cmd.cwd(home);
        }
        let child = pair.slave.spawn_command(cmd).map_err(pty_err)?;
        drop(pair.slave);

        let mut reader = pair.master.try_clone_reader().map_err(pty_err)?;
        let writer = pair.master.take_writer().map_err(pty_err)?;
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        self.sessions.lock()?.insert(id, Session { master: pair.master, writer, child });

        let sessions = Arc::clone(&self.sessions);
        let app = app.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            let mut pending = Vec::new();
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        pending.extend_from_slice(&buf[..n]);
                        let data = take_utf8(&mut pending);
                        if !data.is_empty() {
                            let _ = app.emit(EVENT_DATA, DataEvent { id, data });
                        }
                    }
                }
            }
            // Retire la session sans garder le verrou pendant la fermeture du pseudo-terminal.
            let session = sessions.lock().ok().and_then(|mut s| s.remove(&id));
            if let Some(mut session) = session {
                let _ = session.child.kill();
                drop(session);
            }
            let _ = app.emit(EVENT_EXIT, id);
        });

        Ok(id)
    }

    pub fn write(&self, id: u64, data: &str) -> AppResult<()> {
        let mut sessions = self.sessions.lock()?;
        let s = sessions.get_mut(&id).ok_or_else(|| AppError::InvalidInput("terminal fermé".into()))?;
        s.writer.write_all(data.as_bytes())?;
        s.writer.flush()?;
        Ok(())
    }

    pub fn resize(&self, id: u64, cols: u16, rows: u16) -> AppResult<()> {
        let sessions = self.sessions.lock()?;
        if let Some(s) = sessions.get(&id) {
            s.master.resize(size(cols, rows)).map_err(pty_err)?;
        }
        Ok(())
    }

    /// Tue `ssh` : le thread de lecture reçoit la fin du flux, retire la session et prévient
    /// le frontend. Le pseudo-terminal est fermé hors verrou (ClosePseudoConsole peut bloquer
    /// tant que la sortie n'a pas été lue).
    pub fn close(&self, id: u64) -> AppResult<()> {
        let session = self.sessions.lock()?.remove(&id);
        if let Some(mut s) = session {
            let _ = s.child.kill();
            std::thread::spawn(move || drop(s));
        }
        Ok(())
    }

    pub fn close_all(&self) {
        let drained: Vec<Session> = match self.sessions.lock() {
            Ok(mut sessions) => sessions.drain().map(|(_, s)| s).collect(),
            Err(_) => return,
        };
        for mut s in drained {
            let _ = s.child.kill();
            std::thread::spawn(move || drop(s));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_split_utf8_sequences() {
        let bytes = "é✓".as_bytes();
        let mut pending = bytes[..1].to_vec(); // premier octet de « é »
        assert_eq!(take_utf8(&mut pending), "");
        pending.extend_from_slice(&bytes[1..3]);
        assert_eq!(take_utf8(&mut pending), "é");
        pending.extend_from_slice(&bytes[3..]);
        assert_eq!(take_utf8(&mut pending), "✓");
        assert!(pending.is_empty());
    }
}
