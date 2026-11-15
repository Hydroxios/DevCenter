//! HTTPS via Tailscale : `tailscale serve` publie le tableau de bord mobile en HTTPS
//! (certificat valide) sur le réseau privé Tailscale uniquement — requis par iOS pour
//! installer l'appli et recevoir des notifications.

use std::path::PathBuf;

use serde::Serialize;

use crate::error::{AppError, AppResult};
use crate::modules::shell;

const HTTPS_PORT: &str = "443";

#[derive(Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TailscaleStatus {
    pub installed: bool,
    pub online: bool,
    /// Nom MagicDNS du PC (ex. hxpc.tailnet.ts.net).
    pub dns_name: Option<String>,
    /// Certificats HTTPS activés dans la console Tailscale.
    pub https_enabled: bool,
    /// Adresse HTTPS publiée par DevCenter, si active.
    pub serve_url: Option<String>,
}

fn exe() -> Option<PathBuf> {
    let default = PathBuf::from(r"C:\Program Files\Tailscale\tailscale.exe");
    if default.is_file() {
        return Some(default);
    }
    shell::which(&["tailscale.exe", "tailscale"])
}

fn run(args: &[&str]) -> AppResult<String> {
    let exe = exe().ok_or_else(|| AppError::InvalidInput("Tailscale n'est pas installé".into()))?;
    let out = shell::command(exe).args(args).output()?;
    let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
    if out.status.success() {
        Ok(stdout)
    } else {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        Err(AppError::InvalidInput(if err.is_empty() { stdout.trim().to_string() } else { err }))
    }
}

pub fn status(local_port: u16) -> TailscaleStatus {
    if exe().is_none() {
        return TailscaleStatus::default();
    }
    let mut st = TailscaleStatus { installed: true, ..Default::default() };
    if let Ok(json) = run(&["status", "--json"]).and_then(|s| serde_json::from_str::<serde_json::Value>(&s).map_err(|e| AppError::InvalidInput(e.to_string()))) {
        st.online = json["Self"]["Online"].as_bool().unwrap_or(false);
        st.dns_name = json["Self"]["DNSName"].as_str().map(|s| s.trim_end_matches('.').to_string()).filter(|s| !s.is_empty());
        st.https_enabled = json["CertDomains"].as_array().is_some_and(|a| !a.is_empty());
    }
    // `tailscale serve status --json` : la configuration pointe-t-elle vers notre port ?
    if let (Some(dns), Ok(serve)) = (&st.dns_name, run(&["serve", "status", "--json"])) {
        if serve.contains(&format!("127.0.0.1:{local_port}")) || serve.contains(&format!("localhost:{local_port}")) {
            st.serve_url = Some(format!("https://{dns}"));
        }
    }
    st
}

/// Active ou retire la publication HTTPS du port local de l'accès à distance.
pub fn set_serve(enabled: bool, local_port: u16) -> AppResult<()> {
    if enabled {
        let target = format!("http://127.0.0.1:{local_port}");
        run(&["serve", "--bg", &format!("--https={HTTPS_PORT}"), &target]).map_err(|e| {
            let msg = e.to_string();
            if msg.to_lowercase().contains("https") && msg.to_lowercase().contains("enable") {
                AppError::InvalidInput("activez « HTTPS Certificates » dans la console Tailscale (DNS), puis réessayez".into())
            } else {
                e
            }
        })?;
    } else {
        run(&["serve", &format!("--https={HTTPS_PORT}"), "off"])?;
    }
    Ok(())
}
