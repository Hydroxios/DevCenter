//! Agent SSH : permet d'utiliser une clé protégée par une phrase de passe pour les commandes
//! en arrière-plan (monitoring, services…) sans que DevCenter ne voie jamais la phrase de passe.

use std::path::Path;

use serde::Serialize;

use crate::modules::shell;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AgentState {
    /// Agent joignable.
    Running,
    /// Service arrêté ou désactivé (cas par défaut sous Windows).
    Unavailable,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyStatus {
    pub agent: AgentState,
    /// Empreintes des clés chargées dans l'agent.
    pub loaded: Vec<String>,
    /// Clé du serveur (ou `None` = clés par défaut).
    pub key_path: Option<String>,
    /// La clé est chiffrée par une phrase de passe.
    pub encrypted: bool,
    /// La clé (ou une clé, si aucune n'est précisée) est chargée dans l'agent.
    pub key_loaded: bool,
}

fn base64_decode(input: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(input.len() * 3 / 4);
    let mut buf = 0u32;
    let mut bits = 0;
    for c in input.bytes() {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            b'=' | b'\r' | b'\n' | b' ' => continue,
            _ => return None,
        } as u32;
        buf = (buf << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buf >> bits) as u8);
        }
    }
    Some(out)
}

/// Lit l'en-tête d'une clé privée pour savoir si elle est chiffrée.
pub fn is_encrypted(path: &Path) -> bool {
    let Ok(text) = std::fs::read_to_string(path) else { return false };
    if text.contains("ENCRYPTED") {
        return true; // ancien format PEM (« Proc-Type: 4,ENCRYPTED » / « ENCRYPTED PRIVATE KEY »)
    }
    if !text.contains("BEGIN OPENSSH PRIVATE KEY") {
        return false;
    }
    let body: String = text.lines().filter(|l| !l.starts_with("-----")).collect();
    let Some(bytes) = base64_decode(&body) else { return false };
    // Format : "openssh-key-v1\0" puis chaîne (u32 longueur) du nom du chiffrement.
    const MAGIC: &[u8] = b"openssh-key-v1\0";
    let Some(rest) = bytes.strip_prefix(MAGIC) else { return false };
    if rest.len() < 4 {
        return false;
    }
    let len = u32::from_be_bytes([rest[0], rest[1], rest[2], rest[3]]) as usize;
    rest.get(4..4 + len).is_some_and(|cipher| cipher != b"none")
}

/// Empreinte SHA256 d'une clé (via `ssh-keygen -lf`, qui lit la clé publique associée).
fn fingerprint(path: &Path) -> Option<String> {
    let pub_path = format!("{}.pub", path.display());
    let target = if Path::new(&pub_path).is_file() { pub_path } else { path.display().to_string() };
    let out = shell::command("ssh-keygen").args(["-l", "-f", &target]).output().ok()?;
    if !out.status.success() {
        return None;
    }
    String::from_utf8_lossy(&out.stdout).split_whitespace().nth(1).map(str::to_string)
}

pub fn status(key_path: Option<&str>) -> KeyStatus {
    // `ssh-add -l` : 0 = clés listées, 1 = agent vide, 2 = agent injoignable.
    let out = shell::command("ssh-add").args(["-l", "-E", "sha256"]).output();
    let (agent, loaded) = match out {
        Ok(o) if o.status.code() == Some(0) => (
            AgentState::Running,
            String::from_utf8_lossy(&o.stdout).lines().filter_map(|l| l.split_whitespace().nth(1).map(str::to_string)).collect(),
        ),
        Ok(o) if o.status.code() == Some(1) => (AgentState::Running, Vec::new()),
        _ => (AgentState::Unavailable, Vec::new()),
    };

    let (encrypted, key_loaded) = match key_path {
        Some(k) => {
            let p = Path::new(k);
            let loaded_now = fingerprint(p).is_some_and(|fp| loaded.contains(&fp));
            (is_encrypted(p), loaded_now)
        }
        None => (false, !loaded.is_empty()),
    };
    KeyStatus { agent, loaded, key_path: key_path.map(str::to_string), encrypted, key_loaded }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_base64() {
        assert_eq!(base64_decode("b3BlbnNzaA==").unwrap(), b"openssh");
    }

    #[test]
    fn detects_cipher_in_openssh_keys() {
        let dir = std::env::temp_dir().join(format!("devcenter-key-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        // En-têtes minimaux : magic + nom du chiffrement.
        let make = |cipher: &[u8]| {
            let mut raw = b"openssh-key-v1\0".to_vec();
            raw.extend_from_slice(&(cipher.len() as u32).to_be_bytes());
            raw.extend_from_slice(cipher);
            raw.extend_from_slice(&[0, 0, 0, 0]);
            let b64 = encode(&raw);
            format!("-----BEGIN OPENSSH PRIVATE KEY-----\n{b64}\n-----END OPENSSH PRIVATE KEY-----\n")
        };
        let plain = dir.join("plain");
        let enc = dir.join("enc");
        std::fs::write(&plain, make(b"none")).unwrap();
        std::fs::write(&enc, make(b"aes256-ctr")).unwrap();
        assert!(!is_encrypted(&plain));
        assert!(is_encrypted(&enc));
        std::fs::remove_dir_all(&dir).ok();
    }

    fn encode(data: &[u8]) -> String {
        const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut s = String::new();
        for chunk in data.chunks(3) {
            let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
            let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
            for i in 0..4 {
                if i <= chunk.len() {
                    s.push(T[((n >> (18 - 6 * i)) & 63) as usize] as char);
                } else {
                    s.push('=');
                }
            }
        }
        s
    }
}
