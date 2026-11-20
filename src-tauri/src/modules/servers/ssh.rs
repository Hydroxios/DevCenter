//! Exécution de commandes distantes via le client OpenSSH du système (`ssh.exe`).
//!
//! - Authentification par clé uniquement (`BatchMode=yes`) : aucun mot de passe n'est demandé
//!   ni stocké ; les clés, l'agent SSH et `~/.ssh/config` de l'utilisateur sont réutilisés.
//! - Les commandes distantes sont construites à partir de modèles fixes ; les seuls paramètres
//!   variables (nom de service, de conteneur) sont validés puis cités pour le shell distant.

use std::io::Read;
use std::process::{Output, Stdio};
use std::time::{Duration, Instant};

use crate::error::{AppError, AppResult};
use crate::modules::shell;

use super::Server;

pub const CONNECT_TIMEOUT_SECS: u32 = 8;

/// Options communes aux commandes et au terminal interactif.
pub fn base_args(server: &Server, batch: bool) -> Vec<String> {
    let mut args = vec![
        "-p".into(),
        server.port.to_string(),
        "-o".into(),
        format!("ConnectTimeout={CONNECT_TIMEOUT_SECS}"),
        "-o".into(),
        // Premier contact : l'empreinte est enregistrée ; un changement ultérieur est refusé.
        "StrictHostKeyChecking=accept-new".into(),
        "-o".into(),
        "ServerAliveInterval=15".into(),
    ];
    if batch {
        args.extend(["-o".into(), "BatchMode=yes".into()]);
    }
    if let Some(key) = &server.key_path {
        args.extend([
            "-i".into(),
            key.clone(),
            "-o".into(),
            "IdentitiesOnly=yes".into(),
        ]);
    }
    args.push(destination(server));
    args
}

pub fn destination(server: &Server) -> String {
    match &server.user {
        Some(user) => format!("{user}@{}", server.host),
        None => server.host.clone(),
    }
}

/// Cite une valeur pour un shell POSIX distant.
pub fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', r"'\''"))
}

/// Exécute `remote_cmd` sur le serveur avec un délai maximum.
pub fn exec(server: &Server, remote_cmd: &str, timeout: Duration) -> AppResult<Output> {
    let mut child = shell::command("ssh")
        .args(base_args(server, true))
        .arg(remote_cmd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| AppError::InvalidInput(format!("client ssh introuvable : {e}")))?;

    // Lecture en parallèle pour ne pas bloquer si la sortie remplit le tampon du pipe.
    let mut stdout = child.stdout.take().expect("stdout");
    let mut stderr = child.stderr.take().expect("stderr");
    let out_thread = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdout.read_to_end(&mut buf);
        buf
    });
    let err_thread = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stderr.read_to_end(&mut buf);
        buf
    });

    let deadline = Instant::now() + timeout;
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(AppError::InvalidInput(format!(
                "{} ne répond pas (délai de {} s dépassé)",
                server.host,
                timeout.as_secs()
            )));
        }
        std::thread::sleep(Duration::from_millis(40));
    };
    Ok(Output {
        status,
        stdout: out_thread.join().unwrap_or_default(),
        stderr: err_thread.join().unwrap_or_default(),
    })
}

/// Comme `exec`, mais transforme un code de sortie non nul en erreur lisible.
pub fn exec_ok(server: &Server, remote_cmd: &str, timeout: Duration) -> AppResult<String> {
    let out = exec(server, remote_cmd, timeout)?;
    if out.status.success() {
        return Ok(String::from_utf8_lossy(&out.stdout).into_owned());
    }
    let stderr = String::from_utf8_lossy(&out.stderr);
    let msg = stderr
        .lines()
        .filter(|l| !l.starts_with("Warning: Permanently added"))
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .to_string();
    Err(AppError::InvalidInput(explain(&msg, out.status.code())))
}

/// Traduit les erreurs SSH courantes.
fn explain(stderr: &str, code: Option<i32>) -> String {
    let lower = stderr.to_lowercase();
    if lower.contains("permission denied") {
        "authentification refusée : vérifiez l'utilisateur et la clé SSH (la connexion par mot de passe n'est pas utilisée)".into()
    } else if lower.contains("could not resolve hostname") {
        "nom d'hôte introuvable".into()
    } else if lower.contains("connection refused") {
        "connexion refusée (port SSH fermé ?)".into()
    } else if lower.contains("timed out") {
        "délai de connexion dépassé".into()
    } else if lower.contains("host key verification failed")
        || lower.contains("remote host identification has changed")
    {
        "l'empreinte du serveur a changé : vérifiez-la puis mettez à jour ~/.ssh/known_hosts".into()
    } else if lower.contains("a password is required") || lower.contains("sudo:") {
        "sudo demande un mot de passe : autorisez cette commande sans mot de passe (sudoers) ou utilisez le terminal".into()
    } else if stderr.is_empty() {
        format!(
            "la commande a échoué (code {})",
            code.map(|c| c.to_string()).unwrap_or_else(|| "?".into())
        )
    } else {
        stderr.chars().take(400).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quotes_for_posix_shell() {
        assert_eq!(quote("nginx"), "'nginx'");
        assert_eq!(quote("a'b"), r"'a'\''b'");
    }

    #[test]
    fn builds_args() {
        let s = Server {
            id: 1,
            name: "vps".into(),
            host: "example.org".into(),
            port: 2222,
            user: Some("deploy".into()),
            key_path: None,
        };
        let args = base_args(&s, true);
        assert_eq!(args.last().unwrap(), "deploy@example.org");
        assert!(args.contains(&"BatchMode=yes".to_string()));
        assert!(args.windows(2).any(|w| w == ["-p", "2222"]));
    }
}
