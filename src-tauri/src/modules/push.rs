//! Notifications push (Web Push) vers les appareils appairés — iPhone (iOS 16.4+, appli ajoutée
//! à l'écran d'accueil), Android, navigateurs de bureau.
//!
//! - Clés VAPID (ECDSA P-256) générées une fois et stockées localement.
//! - Contenu chiffré de bout en bout (RFC 8291, aes128gcm) : le service de push (Apple, Google…)
//!   ne voit pas le texte des notifications.
//! - Envoi via `curl.exe` (fourni avec Windows) : pas de pile TLS supplémentaire à compiler.
//! - Les points d'envoi sont limités aux services de push connus (pas d'URL arbitraire).

use std::io::Write;
use std::process::Stdio;

use aes_gcm::aead::Aead;
use aes_gcm::{Aes128Gcm, KeyInit, Nonce};
use hkdf::Hkdf;
use p256::ecdsa::signature::Signer;
use p256::ecdsa::{Signature, SigningKey};
use p256::elliptic_curve::sec1::ToEncodedPoint;
use p256::{PublicKey, SecretKey};
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use sha2::Sha256;

use crate::database::Database;
use crate::error::{AppError, AppResult};
use crate::modules::shell;

/// Services de push acceptés (suffixes d'hôte).
const ALLOWED_HOSTS: &[&str] = &[
    "push.apple.com",
    "fcm.googleapis.com",
    "push.services.mozilla.com",
    "notify.windows.com",
];

// ------------------------------------------------------------------ base64url

const B64: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

pub fn b64url(data: &[u8]) -> String {
    let mut out = String::with_capacity(data.len() * 4 / 3 + 2);
    for chunk in data.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        for i in 0..=chunk.len() {
            out.push(B64[((n >> (18 - 6 * i)) & 63) as usize] as char);
        }
    }
    out
}

pub fn b64url_decode(s: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    let (mut buf, mut bits) = (0u32, 0);
    for c in s.trim_end_matches('=').bytes() {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'-' | b'+' => 62,
            b'_' | b'/' => 63,
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

fn random<const N: usize>() -> AppResult<[u8; N]> {
    let mut b = [0u8; N];
    getrandom::fill(&mut b).map_err(|e| AppError::InvalidInput(format!("aléa indisponible : {e}")))?;
    Ok(b)
}

fn new_secret() -> AppResult<SecretKey> {
    loop {
        if let Ok(k) = SecretKey::from_slice(&random::<32>()?) {
            return Ok(k);
        }
    }
}

fn public_bytes(pk: &PublicKey) -> Vec<u8> {
    pk.to_encoded_point(false).as_bytes().to_vec()
}

// ------------------------------------------------------------------ Clés VAPID

fn vapid_secret(db: &Database) -> AppResult<SecretKey> {
    let stored: Option<String> = db.with(|c| {
        Ok(c.query_row("SELECT value FROM app_secrets WHERE key = 'vapid_private'", [], |r| r.get(0)).optional()?)
    })?;
    if let Some(k) = stored.and_then(|s| b64url_decode(&s)).and_then(|b| SecretKey::from_slice(&b).ok()) {
        return Ok(k);
    }
    let key = new_secret()?;
    db.with(|c| {
        c.execute(
            "INSERT OR REPLACE INTO app_secrets (key, value) VALUES ('vapid_private', ?1)",
            params![b64url(&key.to_bytes())],
        )?;
        Ok(())
    })?;
    Ok(key)
}

/// Clé publique VAPID (« applicationServerKey » côté navigateur).
pub fn public_key(db: &Database) -> AppResult<String> {
    Ok(b64url(&public_bytes(&vapid_secret(db)?.public_key())))
}

fn vapid_header(secret: &SecretKey, endpoint: &str) -> AppResult<String> {
    let origin = endpoint.splitn(4, '/').take(3).collect::<Vec<_>>().join("/");
    let exp = crate::modules::automations::now() + 12 * 3600;
    let header = b64url(br#"{"typ":"JWT","alg":"ES256"}"#);
    let claims = b64url(
        serde_json::json!({ "aud": origin, "exp": exp, "sub": "mailto:devcenter@example.com" }).to_string().as_bytes(),
    );
    let signing_input = format!("{header}.{claims}");
    let signature: Signature = SigningKey::from(secret).sign(signing_input.as_bytes());
    let jwt = format!("{signing_input}.{}", b64url(&signature.to_bytes()));
    Ok(format!("vapid t={jwt}, k={}", b64url(&public_bytes(&secret.public_key()))))
}

// ------------------------------------------------------------------ Chiffrement RFC 8291

/// Chiffre `payload` pour un abonnement (clé publique `p256dh` + secret `auth` du navigateur).
pub fn encrypt(payload: &[u8], ua_public: &[u8], auth: &[u8]) -> AppResult<Vec<u8>> {
    let invalid = |m: &str| AppError::InvalidInput(format!("abonnement push invalide : {m}"));
    let ua = PublicKey::from_sec1_bytes(ua_public).map_err(|_| invalid("clé p256dh"))?;
    if auth.len() != 16 {
        return Err(invalid("secret auth"));
    }
    let as_secret = new_secret()?;
    let as_public = public_bytes(&as_secret.public_key());
    let shared = p256::ecdh::diffie_hellman(as_secret.to_nonzero_scalar(), ua.as_affine());

    // IKM = HKDF(auth, ecdh, "WebPush: info\0" || ua_public || as_public)
    let mut key_info = b"WebPush: info\0".to_vec();
    key_info.extend_from_slice(ua_public);
    key_info.extend_from_slice(&as_public);
    let mut ikm = [0u8; 32];
    Hkdf::<Sha256>::new(Some(auth), shared.raw_secret_bytes())
        .expand(&key_info, &mut ikm)
        .map_err(|_| invalid("hkdf"))?;

    let salt = random::<16>()?;
    let hk = Hkdf::<Sha256>::new(Some(&salt), &ikm);
    let mut cek = [0u8; 16];
    let mut nonce = [0u8; 12];
    hk.expand(b"Content-Encoding: aes128gcm\0", &mut cek).map_err(|_| invalid("hkdf"))?;
    hk.expand(b"Content-Encoding: nonce\0", &mut nonce).map_err(|_| invalid("hkdf"))?;

    let mut plaintext = payload.to_vec();
    plaintext.push(0x02); // délimiteur du dernier enregistrement
    let ciphertext = Aes128Gcm::new_from_slice(&cek)
        .map_err(|_| invalid("aes"))?
        .encrypt(Nonce::from_slice(&nonce), plaintext.as_slice())
        .map_err(|_| invalid("chiffrement"))?;

    let mut body = Vec::with_capacity(86 + ciphertext.len());
    body.extend_from_slice(&salt);
    body.extend_from_slice(&4096u32.to_be_bytes());
    body.push(as_public.len() as u8);
    body.extend_from_slice(&as_public);
    body.extend_from_slice(&ciphertext);
    Ok(body)
}

// ------------------------------------------------------------------ Abonnements

#[derive(Debug, Deserialize)]
pub struct SubscriptionInput {
    pub endpoint: String,
    pub keys: SubscriptionKeys,
}

#[derive(Debug, Deserialize)]
pub struct SubscriptionKeys {
    pub p256dh: String,
    pub auth: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Notification {
    pub title: String,
    pub body: String,
    /// Onglet de la page mobile à ouvrir au toucher (home, scripts, auto…).
    pub tab: Option<String>,
    /// Regroupe les notifications d'un même sujet (la nouvelle remplace l'ancienne).
    pub tag: Option<String>,
}

fn validate_endpoint(endpoint: &str) -> AppResult<()> {
    let rest = endpoint
        .strip_prefix("https://")
        .ok_or_else(|| AppError::InvalidInput("point d'envoi push non HTTPS".into()))?;
    let host = rest.split(['/', ':']).next().unwrap_or("").to_ascii_lowercase();
    let ok = endpoint.len() <= 1024
        && !endpoint.contains(char::is_whitespace)
        && ALLOWED_HOSTS.iter().any(|h| host == *h || host.ends_with(&format!(".{h}")));
    if ok { Ok(()) } else { Err(AppError::InvalidInput(format!("service de push non reconnu : {host}"))) }
}

pub fn subscribe(db: &Database, device_id: i64, input: &SubscriptionInput) -> AppResult<()> {
    validate_endpoint(&input.endpoint)?;
    let p256dh = b64url_decode(&input.keys.p256dh).filter(|k| PublicKey::from_sec1_bytes(k).is_ok());
    let auth = b64url_decode(&input.keys.auth).filter(|a| a.len() == 16);
    if p256dh.is_none() || auth.is_none() {
        return Err(AppError::InvalidInput("clés d'abonnement invalides".into()));
    }
    db.with(|c| {
        c.execute(
            "INSERT INTO push_subscriptions (device_id, endpoint, p256dh, auth, created_at) VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(endpoint) DO UPDATE SET device_id = excluded.device_id, p256dh = excluded.p256dh, auth = excluded.auth",
            params![device_id, input.endpoint, input.keys.p256dh, input.keys.auth, crate::modules::automations::now()],
        )?;
        Ok(())
    })
}

pub fn unsubscribe(db: &Database, device_id: i64) -> AppResult<()> {
    db.with(|c| {
        c.execute("DELETE FROM push_subscriptions WHERE device_id = ?1", params![device_id])?;
        Ok(())
    })
}

pub fn is_subscribed(db: &Database, device_id: i64) -> AppResult<bool> {
    db.with(|c| Ok(c.query_row("SELECT 1 FROM push_subscriptions WHERE device_id = ?1", params![device_id], |_| Ok(())).optional()?.is_some()))
}

pub fn subscribed_devices(db: &Database) -> AppResult<Vec<i64>> {
    db.with(|c| {
        let mut stmt = c.prepare("SELECT DISTINCT device_id FROM push_subscriptions")?;
        let rows = stmt.query_map([], |r| r.get(0))?;
        Ok(rows.collect::<Result<_, _>>()?)
    })
}

/// Envoie une requête au service de push ; retourne le code HTTP.
fn post(endpoint: &str, authorization: &str, body: &[u8]) -> AppResult<u16> {
    let mut child = shell::command("curl.exe")
        .args(["-sS", "-o", "NUL", "-w", "%{http_code}", "--max-time", "15", "-X", "POST"])
        .args(["-H", &format!("Authorization: {authorization}")])
        .args(["-H", "Content-Encoding: aes128gcm", "-H", "Content-Type: application/octet-stream"])
        .args(["-H", "TTL: 86400", "-H", "Urgency: normal"])
        .args(["--data-binary", "@-", endpoint])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| AppError::InvalidInput(format!("curl indisponible : {e}")))?;
    child.stdin.take().expect("stdin").write_all(body)?;
    let out = child.wait_with_output()?;
    let code = String::from_utf8_lossy(&out.stdout).trim().parse().unwrap_or(0);
    if code == 0 {
        return Err(AppError::InvalidInput(format!("envoi push impossible : {}", String::from_utf8_lossy(&out.stderr).trim())));
    }
    Ok(code)
}

/// Envoie une notification à tous les appareils abonnés (ou à un seul). Bloquant : à appeler
/// hors du thread principal (voir `notify_all`). Retourne le nombre d'envois réussis.
pub fn send(db: &Database, device: Option<i64>, notification: &Notification) -> AppResult<usize> {
    let subs: Vec<(i64, String, String, String)> = db.with(|c| {
        let mut stmt = c.prepare("SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE (?1 IS NULL OR device_id = ?1)")?;
        let rows = stmt.query_map(params![device], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?;
        Ok(rows.collect::<Result<_, _>>()?)
    })?;
    if subs.is_empty() {
        return Ok(0);
    }
    let secret = vapid_secret(db)?;
    let payload = serde_json::to_vec(notification).map_err(|e| AppError::InvalidInput(e.to_string()))?;
    let mut sent = 0;
    for (id, endpoint, p256dh, auth) in subs {
        let (Some(ua), Some(auth)) = (b64url_decode(&p256dh), b64url_decode(&auth)) else { continue };
        let body = encrypt(&payload, &ua, &auth)?;
        match post(&endpoint, &vapid_header(&secret, &endpoint)?, &body) {
            Ok(code) if (200..300).contains(&code) => sent += 1,
            // Abonnement expiré ou révoqué côté téléphone : on le supprime.
            Ok(404 | 410) => {
                let _ = db.with(|c| {
                    c.execute("DELETE FROM push_subscriptions WHERE id = ?1", params![id])?;
                    Ok(())
                });
            }
            Ok(_) | Err(_) => {}
        }
    }
    Ok(sent)
}

/// Envoi en arrière-plan, sans bloquer l'appelant ; les erreurs sont ignorées.
pub fn notify_all(app: &tauri::AppHandle, notification: Notification) {
    use tauri::Manager;
    let app = app.clone();
    std::thread::spawn(move || {
        let state = app.state::<crate::state::AppState>();
        let _ = send(&state.db, None, &notification);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64url_round_trip() {
        for data in [&b""[..], b"f", b"fo", b"foo", b"foob", &[0xfb, 0xff, 0xfe]] {
            assert_eq!(b64url_decode(&b64url(data)).unwrap(), data);
        }
        assert_eq!(b64url(&[0xfb, 0xff]), "-_8");
    }

    #[test]
    fn endpoints_are_restricted() {
        assert!(validate_endpoint("https://web.push.apple.com/QGuQyavXut").is_ok());
        assert!(validate_endpoint("https://fcm.googleapis.com/fcm/send/abc").is_ok());
        assert!(validate_endpoint("http://web.push.apple.com/x").is_err());
        assert!(validate_endpoint("https://evil.example/push.apple.com").is_err());
        assert!(validate_endpoint("https://push.apple.com.evil.example/x").is_err());
        assert!(validate_endpoint("https://192.168.1.1/x").is_err());
    }

    /// Déchiffre comme le ferait le navigateur (RFC 8291) pour vérifier l'implémentation.
    #[test]
    fn encryption_decrypts_like_a_browser() {
        let ua_secret = new_secret().unwrap();
        let ua_public = public_bytes(&ua_secret.public_key());
        let auth = random::<16>().unwrap();
        let body = encrypt(b"{\"title\":\"Salut\"}", &ua_public, &auth).unwrap();

        let salt = &body[..16];
        assert_eq!(u32::from_be_bytes(body[16..20].try_into().unwrap()), 4096);
        let idlen = body[20] as usize;
        let as_public = &body[21..21 + idlen];
        let ciphertext = &body[21 + idlen..];

        let shared = p256::ecdh::diffie_hellman(ua_secret.to_nonzero_scalar(), PublicKey::from_sec1_bytes(as_public).unwrap().as_affine());
        let mut key_info = b"WebPush: info\0".to_vec();
        key_info.extend_from_slice(&ua_public);
        key_info.extend_from_slice(as_public);
        let mut ikm = [0u8; 32];
        Hkdf::<Sha256>::new(Some(&auth), shared.raw_secret_bytes()).expand(&key_info, &mut ikm).unwrap();
        let hk = Hkdf::<Sha256>::new(Some(salt), &ikm);
        let (mut cek, mut nonce) = ([0u8; 16], [0u8; 12]);
        hk.expand(b"Content-Encoding: aes128gcm\0", &mut cek).unwrap();
        hk.expand(b"Content-Encoding: nonce\0", &mut nonce).unwrap();
        let plain = Aes128Gcm::new_from_slice(&cek).unwrap().decrypt(Nonce::from_slice(&nonce), ciphertext).unwrap();
        assert_eq!(&plain[..plain.len() - 1], b"{\"title\":\"Salut\"}");
        assert_eq!(*plain.last().unwrap(), 0x02);
    }

    #[test]
    fn vapid_jwt_verifies() {
        use p256::ecdsa::VerifyingKey;
        use p256::ecdsa::signature::Verifier;
        let secret = new_secret().unwrap();
        let header = vapid_header(&secret, "https://web.push.apple.com/abc").unwrap();
        let jwt = header.strip_prefix("vapid t=").unwrap().split(", k=").next().unwrap();
        let parts: Vec<&str> = jwt.split('.').collect();
        let claims: serde_json::Value = serde_json::from_slice(&b64url_decode(parts[1]).unwrap()).unwrap();
        assert_eq!(claims["aud"], "https://web.push.apple.com");
        let sig = Signature::from_slice(&b64url_decode(parts[2]).unwrap()).unwrap();
        VerifyingKey::from(&secret.public_key()).verify(format!("{}.{}", parts[0], parts[1]).as_bytes(), &sig).unwrap();
    }

    /// Envoi réel via curl.exe vers un mini-serveur local : en-têtes et corps binaire intacts.
    #[test]
    fn posts_with_curl() {
        use std::io::{Read, Write as _};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (mut sock, _) = listener.accept().unwrap();
            sock.set_read_timeout(Some(std::time::Duration::from_secs(5))).unwrap();
            let mut buf = Vec::new();
            let mut chunk = [0u8; 4096];
            loop {
                let n = sock.read(&mut chunk).unwrap_or(0);
                if n == 0 {
                    break;
                }
                buf.extend_from_slice(&chunk[..n]);
                if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                    let head = String::from_utf8_lossy(&buf[..pos]).to_lowercase();
                    let len: usize = head.lines().find_map(|l| l.strip_prefix("content-length: ")).and_then(|v| v.trim().parse().ok()).unwrap_or(0);
                    if buf.len() >= pos + 4 + len {
                        break;
                    }
                }
            }
            sock.write_all(b"HTTP/1.1 201 Created\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
            buf
        });
        let body = [0u8, 1, 2, 255, 13, 10, 0];
        let code = post(&format!("http://127.0.0.1:{port}/push/abc"), "vapid t=x, k=y", &body).unwrap();
        assert_eq!(code, 201);
        let req = server.join().unwrap();
        let text = String::from_utf8_lossy(&req).to_lowercase();
        assert!(text.starts_with("post /push/abc"));
        assert!(text.contains("authorization: vapid t=x, k=y"));
        assert!(text.contains("content-encoding: aes128gcm"));
        assert!(text.contains("ttl: 86400"));
        assert!(req.ends_with(&body));
    }
}
