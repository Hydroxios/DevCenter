use serde::{Deserialize, Serialize};
use sysinfo::{Pid, ProcessRefreshKind, ProcessStatus, ProcessesToUpdate, System, UpdateKind};

use crate::error::{AppError, AppResult};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessInfo {
    pub pid: u32,
    pub parent_pid: Option<u32>,
    pub name: String,
    pub exe: Option<String>,
    /// Utilisation CPU rapportée à la machine entière (0–100), comme le Gestionnaire des tâches.
    pub cpu_usage: f32,
    pub memory: u64,
    pub status: String,
    /// Horodatage Unix de démarrage : sert à identifier le processus de façon sûre.
    pub start_time: u64,
    pub run_time: u64,
    /// Processus système ou DevCenter lui-même : l'arrêt est refusé.
    pub protected: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KillOutcome {
    pub pid: u32,
    pub name: String,
    pub killed: bool,
}

/// Critère de classement des processus.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProcessSort {
    Cpu,
    Memory,
}

/// Trie par ordre décroissant selon le critère.
pub fn sort(list: &mut [ProcessInfo], by: ProcessSort) {
    match by {
        ProcessSort::Cpu => list.sort_unstable_by(|a, b| b.cpu_usage.total_cmp(&a.cpu_usage)),
        ProcessSort::Memory => list.sort_unstable_by_key(|p| std::cmp::Reverse(p.memory)),
    }
}

/// Processus Windows dont l'arrêt provoque un écran bleu, une déconnexion ou une instabilité.
const PROTECTED_NAMES: &[&str] = &[
    "system",
    "system idle process",
    "registry",
    "memory compression",
    "secure system",
    "smss.exe",
    "csrss.exe",
    "wininit.exe",
    "winlogon.exe",
    "services.exe",
    "lsass.exe",
    "lsaiso.exe",
    "svchost.exe",
    "fontdrvhost.exe",
    "dwm.exe",
    "audiodg.exe",
    "spoolsv.exe",
    "msmpeng.exe",
];

pub(super) fn is_protected(pid: u32, name: &str) -> bool {
    pid <= 4
        || pid == std::process::id()
        || PROTECTED_NAMES.contains(&name.to_ascii_lowercase().as_str())
}

fn status_label(status: ProcessStatus) -> String {
    match status {
        ProcessStatus::Run => "running".into(),
        ProcessStatus::Sleep | ProcessStatus::Idle => "sleeping".into(),
        ProcessStatus::Stop => "stopped".into(),
        ProcessStatus::Zombie | ProcessStatus::Dead => "dead".into(),
        other => other.to_string().to_lowercase(),
    }
}

fn refresh(sys: &mut System) {
    sys.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing()
            .with_cpu()
            .with_memory()
            .with_exe(UpdateKind::OnlyIfNotSet),
    );
}

pub fn list(sys: &mut System, cores: usize) -> Vec<ProcessInfo> {
    refresh(sys);
    sys.processes()
        .values()
        .map(|p| {
            let pid = p.pid().as_u32();
            let name = p.name().to_string_lossy().into_owned();
            ProcessInfo {
                pid,
                parent_pid: p.parent().map(|pp| pp.as_u32()),
                protected: is_protected(pid, &name),
                name,
                exe: p.exe().map(|e| e.to_string_lossy().into_owned()),
                cpu_usage: p.cpu_usage() / cores as f32,
                memory: p.memory(),
                status: status_label(p.status()),
                start_time: p.start_time(),
                run_time: p.run_time(),
            }
        })
        .collect()
}

/// Arrête un processus. `start_time` doit correspondre à celui affiché dans l'interface :
/// si le PID a été réattribué entre-temps à un autre programme, l'arrêt est refusé.
pub fn kill(sys: &mut System, pid: u32, start_time: u64) -> AppResult<KillOutcome> {
    let spid = Pid::from_u32(pid);
    sys.refresh_processes_specifics(
        ProcessesToUpdate::Some(&[spid]),
        true,
        ProcessRefreshKind::nothing(),
    );

    let process = sys
        .process(spid)
        .ok_or_else(|| AppError::InvalidInput(format!("le processus {pid} n'existe plus")))?;
    let name = process.name().to_string_lossy().into_owned();

    if process.start_time() != start_time {
        return Err(AppError::InvalidInput(format!(
            "le PID {pid} correspond désormais à un autre processus ({name}), actualisez la liste"
        )));
    }
    if is_protected(pid, &name) {
        return Err(AppError::InvalidInput(format!(
            "{name} est un processus protégé"
        )));
    }

    let killed = process.kill();
    Ok(KillOutcome { pid, name, killed })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn protects_critical_and_self() {
        assert!(is_protected(4, "anything"));
        assert!(is_protected(1234, "CSRSS.EXE"));
        assert!(is_protected(std::process::id(), "devcenter.exe"));
        assert!(!is_protected(1234, "notepad.exe"));
    }

    #[test]
    fn refuses_mismatched_start_time() {
        let mut sys = System::new().unwrap();
        let me = std::process::id();
        sys.refresh_processes(ProcessesToUpdate::Some(&[Pid::from_u32(me)]), true);
        let start = sys.process(Pid::from_u32(me)).unwrap().start_time();
        // Mauvais horodatage → refus avant toute tentative d'arrêt.
        assert!(kill(&mut sys, me, start + 1).is_err());
        // Bon horodatage mais processus protégé (soi-même) → refus.
        assert!(kill(&mut sys, me, start).is_err());
    }
}
