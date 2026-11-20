//! Ports en écoute : lecture de `netstat -ano` (aucune dépendance supplémentaire) puis
//! rattachement de chaque socket à son processus et, le cas échéant, au script DevCenter
//! qui l'a lancé (le serveur `node` est un descendant du `pnpm` démarré par le runner).

use std::collections::{BTreeMap, HashMap};

use serde::Serialize;
use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System};

use crate::error::{AppError, AppResult};
use crate::modules::runner::{RunInfo, RunStatus};
use crate::modules::shell;

use super::processes::is_protected;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Protocol {
    Tcp,
    Udp,
}

/// Une ligne utile de `netstat -ano`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawSocket {
    pub protocol: Protocol,
    /// Adresse locale sans crochets (`0.0.0.0`, `::1`, …).
    pub address: String,
    pub port: u16,
    pub pid: u32,
}

/// Script DevCenter propriétaire du port.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortRun {
    pub run_id: u64,
    pub project_id: i64,
    pub script: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListeningPort {
    pub protocol: Protocol,
    pub port: u16,
    /// Adresses locales (IPv4 et IPv6 regroupées pour un même port et un même processus).
    pub addresses: Vec<String>,
    pub pid: u32,
    pub process_name: Option<String>,
    /// Horodatage de démarrage du processus : requis pour l'arrêter sans risque (`kill_process`).
    pub start_time: Option<u64>,
    pub protected: bool,
    pub run: Option<PortRun>,
}

/// États TCP d'écoute (netstat les traduit sur certaines versions localisées de Windows).
const LISTEN_STATES: &[&str] = &[
    "LISTENING",
    "LISTEN",
    "ABHÖREN",
    "EN ESCUCHA",
    "IN ASCOLTO",
    "ESCUTANDO",
    "ÉCOUTE",
];
/// États TCP anglais connus autres que l'écoute.
const OTHER_STATES: &[&str] = &[
    "ESTABLISHED",
    "TIME_WAIT",
    "CLOSE_WAIT",
    "FIN_WAIT_1",
    "FIN_WAIT_2",
    "SYN_SENT",
    "SYN_RECEIVED",
    "LAST_ACK",
    "CLOSING",
    "CLOSED",
    "BOUND",
    "DELETE_TCB",
];

/// Sépare `127.0.0.1:3000` / `[::1]:3000` en adresse et port.
fn split_endpoint(endpoint: &str) -> Option<(String, &str)> {
    let (addr, port) = endpoint.rsplit_once(':')?;
    let addr = addr.trim_start_matches('[').trim_end_matches(']');
    // Identifiant de zone IPv6 (`fe80::1%12`) : inutile à l'affichage.
    let addr = addr.split('%').next().unwrap_or(addr);
    if addr.is_empty() {
        return None;
    }
    Some((addr.to_string(), port))
}

/// Analyse une ligne de `netstat -ano`. Seules les sockets en écoute sont retenues :
/// TCP à l'état d'écoute, UDP non connecté (adresse distante `*:*`).
pub fn parse_line(line: &str) -> Option<RawSocket> {
    let cols: Vec<&str> = line.split_whitespace().collect();
    let proto = cols.first()?.to_ascii_uppercase();
    let protocol = match proto.as_str() {
        "TCP" | "TCPV6" => Protocol::Tcp,
        "UDP" | "UDPV6" => Protocol::Udp,
        _ => return None,
    };
    let (address, port) = split_endpoint(cols.get(1)?)?;
    let port: u16 = port.parse().ok()?;
    let remote = *cols.get(2)?;
    let pid: u32 = cols.last()?.parse().ok()?;

    match protocol {
        Protocol::Tcp => {
            // Proto, local, distante, état (éventuellement en plusieurs mots), PID.
            if cols.len() < 5 {
                return None;
            }
            let state = cols[3..cols.len() - 1].join(" ").to_uppercase();
            let listening = LISTEN_STATES.contains(&state.as_str())
                // État traduit inconnu : une écoute n'a pas de port distant.
                || (!OTHER_STATES.contains(&state.as_str()) && remote.ends_with(":0"));
            if !listening {
                return None;
            }
        }
        Protocol::Udp => {
            if cols.len() != 4 || remote != "*:*" {
                return None;
            }
        }
    }
    if pid == 0 {
        return None;
    }
    Some(RawSocket {
        protocol,
        address,
        port,
        pid,
    })
}

/// Analyse la sortie complète de `netstat -ano`.
pub fn parse_netstat(output: &str) -> Vec<RawSocket> {
    output.lines().filter_map(parse_line).collect()
}

/// Regroupe les sockets par (protocole, port, PID) en fusionnant les adresses.
pub fn group(sockets: Vec<RawSocket>) -> Vec<(Protocol, u16, u32, Vec<String>)> {
    let mut map: BTreeMap<(Protocol, u16, u32), Vec<String>> = BTreeMap::new();
    for s in sockets {
        let addrs = map.entry((s.protocol, s.port, s.pid)).or_default();
        if !addrs.contains(&s.address) {
            addrs.push(s.address);
        }
    }
    map.into_iter()
        .map(|((p, port, pid), addrs)| (p, port, pid, addrs))
        .collect()
}

fn run_netstat() -> AppResult<String> {
    let out = shell::command("netstat").arg("-ano").output()?;
    if !out.status.success() {
        return Err(AppError::InvalidInput(format!(
            "netstat a échoué (code {:?})",
            out.status.code()
        )));
    }
    // Sortie en page de code OEM : seules les lignes ASCII (TCP/UDP) sont exploitées.
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Cherche, en remontant les parents, le script DevCenter en cours dont descend `pid`.
fn owning_run(
    pid: u32,
    parents: &HashMap<u32, u32>,
    runs: &HashMap<u32, &RunInfo>,
) -> Option<PortRun> {
    let mut current = pid;
    // Profondeur bornée : protège d'un cycle (PID parent réattribué).
    for _ in 0..32 {
        if let Some(run) = runs.get(&current) {
            return Some(PortRun {
                run_id: run.id,
                project_id: run.project_id,
                script: run.script.clone(),
            });
        }
        match parents.get(&current) {
            Some(&parent) if parent != current && parent != 0 => current = parent,
            _ => break,
        }
    }
    None
}

pub fn list(sys: &mut System, runs: &[RunInfo]) -> AppResult<Vec<ListeningPort>> {
    let sockets = parse_netstat(&run_netstat()?);
    sys.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing());

    let mut parents = HashMap::new();
    for p in sys.processes().values() {
        if let Some(parent) = p.parent() {
            parents.insert(p.pid().as_u32(), parent.as_u32());
        }
    }
    let runs: HashMap<u32, &RunInfo> = runs
        .iter()
        .filter(|r| r.status == RunStatus::Running)
        .map(|r| (r.pid, r))
        .collect();

    Ok(group(sockets)
        .into_iter()
        .map(|(protocol, port, pid, addresses)| {
            let process = sys.process(sysinfo::Pid::from_u32(pid));
            let process_name = process.map(|p| p.name().to_string_lossy().into_owned());
            ListeningPort {
                protocol,
                port,
                addresses,
                pid,
                protected: is_protected(pid, process_name.as_deref().unwrap_or("")),
                start_time: process.map(|p| p.start_time()),
                process_name,
                run: owning_run(pid, &parents, &runs),
            }
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "
Connexions actives

  Proto  Adresse locale         Adresse distante       État
  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1404
  TCP    127.0.0.1:3000         0.0.0.0:0              LISTENING       9876
  TCP    127.0.0.1:5354         127.0.0.1:49670        ESTABLISHED     6276
  TCP    127.0.0.1:49729        127.0.0.1:49730        TIME_WAIT       0
  TCP    [::]:135               [::]:0                 LISTENING       1404
  TCP    [::1]:3000             [::]:0                 LISTENING       9876
  TCP    [::1]:1420             [::1]:50359            FIN_WAIT_2      2676
  UDP    0.0.0.0:5353           *:*                                    5224
  UDP    [fe80::1%12]:1900      *:*                                    3000
  UDP    192.168.1.10:50000     8.8.8.8:53                             4000
";

    #[test]
    fn parses_listening_tcp_and_udp() {
        let sockets = parse_netstat(SAMPLE);
        assert_eq!(sockets.len(), 6);
        assert_eq!(
            sockets[1],
            RawSocket {
                protocol: Protocol::Tcp,
                address: "127.0.0.1".into(),
                port: 3000,
                pid: 9876
            }
        );
        assert_eq!(sockets[3].address, "::1");
        assert_eq!(
            sockets[4],
            RawSocket {
                protocol: Protocol::Udp,
                address: "0.0.0.0".into(),
                port: 5353,
                pid: 5224
            }
        );
        // Identifiant de zone retiré.
        assert_eq!(sockets[5].address, "fe80::1");
    }

    #[test]
    fn ignores_non_listening_and_noise() {
        assert!(
            parse_line("  TCP    127.0.0.1:5354   127.0.0.1:49670   ESTABLISHED   6276").is_none()
        );
        assert!(parse_line("  Proto  Adresse locale   Adresse distante   État").is_none());
        assert!(parse_line("Connexions actives").is_none());
        assert!(parse_line("").is_none());
        assert!(parse_line("  TCP    0.0.0.0:abc   0.0.0.0:0   LISTENING   12").is_none());
        // PID 0 (processus inactif du système) : ignoré.
        assert!(parse_line("  TCP    0.0.0.0:80   0.0.0.0:0   LISTENING   0").is_none());
        // UDP connecté : ce n'est pas une écoute.
        assert!(parse_line("  UDP    192.168.1.10:50000     8.8.8.8:53     4000").is_none());
    }

    #[test]
    fn accepts_localized_listening_state() {
        let s = parse_line("  TCP    0.0.0.0:8080   0.0.0.0:0   ABHÖREN   42").unwrap();
        assert_eq!((s.port, s.pid), (8080, 42));
        // État inconnu mais sans port distant : écoute.
        assert!(parse_line("  TCP    0.0.0.0:8081   0.0.0.0:0   À_L'ÉCOUTE   43").is_some());
        // État inconnu avec un port distant : connexion.
        assert!(parse_line("  TCP    10.0.0.1:8082   10.0.0.2:443   ÉTABLI   44").is_none());
    }

    #[test]
    fn groups_addresses_per_port_and_pid() {
        let grouped = group(parse_netstat(SAMPLE));
        let web = grouped
            .iter()
            .find(|g| g.1 == 3000 && g.0 == Protocol::Tcp)
            .unwrap();
        assert_eq!(web.2, 9876);
        assert_eq!(web.3, vec!["127.0.0.1".to_string(), "::1".to_string()]);
        let rpc = grouped.iter().find(|g| g.1 == 135).unwrap();
        assert_eq!(rpc.3.len(), 2);
        assert_eq!(grouped.len(), 4);
    }

    #[test]
    fn finds_owning_run_through_ancestors() {
        let run = RunInfo {
            id: 7,
            project_id: 3,
            script: "dev".into(),
            command: "vite".into(),
            pid: 100,
            status: RunStatus::Running,
            exit_code: None,
            url: None,
            started_at: 0,
        };
        let runs: HashMap<u32, &RunInfo> = [(100, &run)].into_iter().collect();
        // node (300) ← cmd (200) ← pnpm (100, lancé par DevCenter)
        let parents: HashMap<u32, u32> = [(300, 200), (200, 100), (100, 1), (400, 1)]
            .into_iter()
            .collect();
        assert_eq!(owning_run(300, &parents, &runs).unwrap().run_id, 7);
        assert!(owning_run(400, &parents, &runs).is_none());
        // Cycle : pas de boucle infinie.
        let cyclic: HashMap<u32, u32> = [(500, 501), (501, 500)].into_iter().collect();
        assert!(owning_run(500, &cyclic, &runs).is_none());
    }
}
