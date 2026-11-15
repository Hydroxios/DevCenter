//! Monitoring, services systemd et conteneurs Docker sur un serveur Linux distant.

use std::time::{Duration, Instant};

use serde::Serialize;

use crate::error::{AppError, AppResult};

use super::Server;
use super::ssh::{self, quote};

const TIMEOUT: Duration = Duration::from_secs(15);

// ------------------------------------------------------------------ Monitoring

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteDisk {
    pub mount: String,
    pub total_bytes: u64,
    pub used_bytes: u64,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteMetrics {
    pub hostname: String,
    pub os: String,
    pub kernel: String,
    pub uptime_secs: u64,
    pub load: [f32; 3],
    pub cpu_cores: u32,
    pub cpu_usage: f32,
    pub memory_total: u64,
    pub memory_used: u64,
    pub swap_total: u64,
    pub swap_used: u64,
    pub disks: Vec<RemoteDisk>,
    /// Docker installé et accessible par cet utilisateur.
    pub docker: bool,
    /// systemd présent.
    pub systemd: bool,
    pub latency_ms: u64,
}

/// Script POSIX unique (un seul aller-retour SSH) ; sections séparées par des marqueurs.
const METRICS_SCRIPT: &str = r#"LC_ALL=C; export LC_ALL
echo '@@host'; hostname
echo '@@os'; (. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME") || uname -s
echo '@@kernel'; uname -r
echo '@@uptime'; cat /proc/uptime
echo '@@load'; cat /proc/loadavg
echo '@@cores'; nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo
echo '@@stat1'; head -1 /proc/stat
sleep 0.5
echo '@@stat2'; head -1 /proc/stat
echo '@@mem'; grep -E '^(MemTotal|MemAvailable|SwapTotal|SwapFree):' /proc/meminfo
echo '@@df'; df -kP -x tmpfs -x devtmpfs -x overlay -x squashfs 2>/dev/null || df -kP
echo '@@docker'; docker info >/dev/null 2>&1 && echo yes || echo no
echo '@@systemd'; command -v systemctl >/dev/null 2>&1 && echo yes || echo no
"#;

fn sections(text: &str) -> Vec<(&str, Vec<&str>)> {
    let mut out: Vec<(&str, Vec<&str>)> = Vec::new();
    for line in text.lines() {
        if let Some(name) = line.strip_prefix("@@") {
            out.push((name.trim(), Vec::new()));
        } else if let Some(last) = out.last_mut() {
            last.1.push(line);
        }
    }
    out
}

fn cpu_times(line: &str) -> Option<(u64, u64)> {
    let nums: Vec<u64> = line.split_whitespace().skip(1).filter_map(|n| n.parse().ok()).collect();
    if nums.len() < 4 {
        return None;
    }
    let idle = nums[3] + nums.get(4).copied().unwrap_or(0); // idle + iowait
    Some((nums.iter().sum(), idle))
}

pub fn parse_metrics(text: &str) -> RemoteMetrics {
    let mut m = RemoteMetrics::default();
    let mut stat1 = None;
    let mut stat2 = None;
    let (mut mem_avail, mut swap_free) = (0u64, 0u64);
    for (name, lines) in sections(text) {
        let first = lines.first().copied().unwrap_or("").trim();
        match name {
            "host" => m.hostname = first.into(),
            "os" => m.os = first.trim_matches('"').into(),
            "kernel" => m.kernel = first.into(),
            "uptime" => m.uptime_secs = first.split_whitespace().next().and_then(|v| v.parse::<f64>().ok()).unwrap_or(0.0) as u64,
            "load" => {
                for (i, v) in first.split_whitespace().take(3).enumerate() {
                    m.load[i] = v.parse().unwrap_or(0.0);
                }
            }
            "cores" => m.cpu_cores = first.parse().unwrap_or(0),
            "stat1" => stat1 = cpu_times(first),
            "stat2" => stat2 = cpu_times(first),
            "mem" => {
                for l in &lines {
                    let mut parts = l.split_whitespace();
                    let key = parts.next().unwrap_or("");
                    let kb: u64 = parts.next().and_then(|v| v.parse().ok()).unwrap_or(0);
                    match key {
                        "MemTotal:" => m.memory_total = kb * 1024,
                        "MemAvailable:" => mem_avail = kb * 1024,
                        "SwapTotal:" => m.swap_total = kb * 1024,
                        "SwapFree:" => swap_free = kb * 1024,
                        _ => {}
                    }
                }
            }
            "df" => {
                for l in lines.iter().skip(1) {
                    let cols: Vec<&str> = l.split_whitespace().collect();
                    if cols.len() >= 6 && cols[0].starts_with('/') {
                        let total: u64 = cols[1].parse().unwrap_or(0);
                        let used: u64 = cols[2].parse().unwrap_or(0);
                        let mount = cols[5..].join(" ");
                        if total > 0 && !m.disks.iter().any(|d| d.mount == mount) {
                            m.disks.push(RemoteDisk { mount, total_bytes: total * 1024, used_bytes: used * 1024 });
                        }
                    }
                }
            }
            "docker" => m.docker = first == "yes",
            "systemd" => m.systemd = first == "yes",
            _ => {}
        }
    }
    m.memory_used = m.memory_total.saturating_sub(mem_avail);
    m.swap_used = m.swap_total.saturating_sub(swap_free);
    if let (Some((t1, i1)), Some((t2, i2))) = (stat1, stat2) {
        let total = t2.saturating_sub(t1);
        if total > 0 {
            m.cpu_usage = 100.0 * (total - i2.saturating_sub(i1).min(total)) as f32 / total as f32;
        }
    }
    m
}

pub fn metrics(server: &Server) -> AppResult<RemoteMetrics> {
    let start = Instant::now();
    let text = ssh::exec_ok(server, METRICS_SCRIPT, TIMEOUT).map_err(|e| explain_auth(server, e))?;
    let mut m = parse_metrics(&text);
    // Le script contient une pause de 0,5 s : on la retire de la latence affichée.
    m.latency_ms = (start.elapsed().as_millis() as u64).saturating_sub(500);
    Ok(m)
}

/// Test de connexion rapide : retourne la latence en ms.
pub fn ping(server: &Server) -> AppResult<u64> {
    let start = Instant::now();
    ssh::exec_ok(server, "true", Duration::from_secs(12)).map_err(|e| explain_auth(server, e))?;
    Ok(start.elapsed().as_millis() as u64)
}

/// Remplace « authentification refusée » par la vraie cause quand la clé est protégée par
/// une phrase de passe (le mode non interactif ne peut pas la demander).
fn explain_auth(server: &Server, err: AppError) -> AppError {
    if !err.to_string().contains("authentification refusée") {
        return err;
    }
    let st = super::agent::status(server.key_path.as_deref());
    if !st.encrypted || st.key_loaded {
        return err;
    }
    AppError::InvalidInput(match st.agent {
        super::agent::AgentState::Unavailable => "clé protégée par une phrase de passe : activez l'agent SSH de Windows puis déverrouillez la clé (une seule fois)".into(),
        super::agent::AgentState::Running => "clé protégée par une phrase de passe : déverrouillez-la dans l'agent SSH (une seule fois)".into(),
    })
}

// ------------------------------------------------------------------ Services systemd

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteService {
    pub name: String,
    pub load: String,
    pub active: String,
    pub sub: String,
    pub description: String,
}

/// Noms de services / conteneurs : caractères sûrs uniquement.
fn validate_name(kind: &str, name: &str) -> AppResult<()> {
    let ok = !name.is_empty()
        && name.len() <= 128
        && !name.starts_with('-')
        && name.chars().all(|c| c.is_ascii_alphanumeric() || "@._:-".contains(c));
    if ok { Ok(()) } else { Err(AppError::InvalidInput(format!("nom de {kind} invalide : {name}"))) }
}

pub fn services(server: &Server) -> AppResult<Vec<RemoteService>> {
    let text = ssh::exec_ok(
        server,
        "LC_ALL=C systemctl list-units --type=service --all --no-pager --no-legend --plain",
        TIMEOUT,
    )?;
    Ok(parse_services(&text))
}

pub fn parse_services(text: &str) -> Vec<RemoteService> {
    text.lines()
        .filter_map(|l| {
            let l = l.trim_start_matches(['●', '*', ' ']);
            let mut parts = l.split_whitespace();
            let name = parts.next()?.to_string();
            if !name.ends_with(".service") {
                return None;
            }
            Some(RemoteService {
                name,
                load: parts.next()?.into(),
                active: parts.next()?.into(),
                sub: parts.next()?.into(),
                description: parts.collect::<Vec<_>>().join(" "),
            })
        })
        .collect()
}

pub fn service_action(server: &Server, name: &str, action: &str) -> AppResult<()> {
    validate_name("service", name)?;
    if !["start", "stop", "restart"].contains(&action) {
        return Err(AppError::InvalidInput(format!("action inconnue : {action}")));
    }
    // `sudo -n` : échoue immédiatement au lieu d'attendre un mot de passe.
    ssh::exec_ok(server, &format!("sudo -n systemctl {action} -- {}", quote(name)), TIMEOUT).map(|_| ())
}

pub fn service_logs(server: &Server, name: &str, lines: u32) -> AppResult<String> {
    validate_name("service", name)?;
    let n = lines.clamp(10, 2000);
    let cmd = format!(
        "journalctl -u {q} -n {n} --no-pager -o short-iso 2>&1 || sudo -n journalctl -u {q} -n {n} --no-pager -o short-iso",
        q = quote(name)
    );
    ssh::exec_ok(server, &cmd, TIMEOUT)
}

// ------------------------------------------------------------------ Docker

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Container {
    pub id: String,
    pub name: String,
    pub image: String,
    pub state: String,
    pub status: String,
    pub ports: String,
}

pub fn containers(server: &Server) -> AppResult<Vec<Container>> {
    let text = ssh::exec_ok(
        server,
        r"docker ps -a --no-trunc --format '{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.State}}\t{{.Status}}\t{{.Ports}}'",
        TIMEOUT,
    )?;
    Ok(parse_containers(&text))
}

pub fn parse_containers(text: &str) -> Vec<Container> {
    text.lines()
        .filter_map(|l| {
            let c: Vec<&str> = l.split('\t').collect();
            (c.len() >= 5).then(|| Container {
                id: c[0].chars().take(12).collect(),
                name: c[1].into(),
                image: c[2].into(),
                state: c[3].into(),
                status: c[4].into(),
                ports: c.get(5).copied().unwrap_or("").into(),
            })
        })
        .collect()
}

pub fn container_action(server: &Server, id: &str, action: &str) -> AppResult<()> {
    validate_name("conteneur", id)?;
    if !["start", "stop", "restart"].contains(&action) {
        return Err(AppError::InvalidInput(format!("action inconnue : {action}")));
    }
    ssh::exec_ok(server, &format!("docker {action} {}", quote(id)), Duration::from_secs(40)).map(|_| ())
}

pub fn container_logs(server: &Server, id: &str, lines: u32) -> AppResult<String> {
    validate_name("conteneur", id)?;
    let n = lines.clamp(10, 2000);
    ssh::exec_ok(server, &format!("docker logs --tail {n} --timestamps {} 2>&1", quote(id)), TIMEOUT)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "@@host\nvps-1\n@@os\nUbuntu 24.04.1 LTS\n@@kernel\n6.8.0-45-generic\n@@uptime\n86400.52 170000.00\n\
@@load\n0.52 0.40 0.31 1/234 5678\n@@cores\n4\n@@stat1\ncpu  100 0 100 800 0 0 0 0 0 0\n@@stat2\ncpu  150 0 150 900 0 0 0 0 0 0\n\
@@mem\nMemTotal:        8000000 kB\nMemAvailable:    6000000 kB\nSwapTotal:       1000000 kB\nSwapFree:         750000 kB\n\
@@df\nFilesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 100000 25000 75000 25% /\n/dev/sdb1 200000 100000 100000 50% /mnt/data disk\n\
@@docker\nyes\n@@systemd\nyes\n";

    #[test]
    fn parses_metrics() {
        let m = parse_metrics(SAMPLE);
        assert_eq!(m.hostname, "vps-1");
        assert_eq!(m.uptime_secs, 86400);
        assert_eq!(m.cpu_cores, 4);
        assert!((m.cpu_usage - 50.0).abs() < 0.01); // 100 actifs sur 200
        assert_eq!(m.memory_used, 2_000_000 * 1024);
        assert_eq!(m.swap_used, 250_000 * 1024);
        assert_eq!(m.disks.len(), 2);
        assert_eq!(m.disks[1].mount, "/mnt/data disk");
        assert!(m.docker && m.systemd);
        assert_eq!(m.load, [0.52, 0.40, 0.31]);
    }

    #[test]
    fn parses_services_and_containers() {
        let s = parse_services("● nginx.service loaded active running A high performance web server\nssh.service loaded active running OpenBSD Secure Shell server\nfoo.socket loaded active listening x\n");
        assert_eq!(s.len(), 2);
        assert_eq!(s[0].name, "nginx.service");
        assert_eq!(s[1].description, "OpenBSD Secure Shell server");

        let c = parse_containers("0123456789abcdef0123\tweb\tnginx:alpine\trunning\tUp 3 hours\t0.0.0.0:80->80/tcp\n");
        assert_eq!(c[0].id, "0123456789ab");
        assert_eq!(c[0].state, "running");
    }

    #[test]
    fn rejects_unsafe_names() {
        assert!(validate_name("service", "nginx.service").is_ok());
        assert!(validate_name("service", "getty@tty1.service").is_ok());
        assert!(validate_name("service", "x; rm -rf /").is_err());
        assert!(validate_name("service", "--help").is_err());
        assert!(validate_name("conteneur", "$(id)").is_err());
    }
}
