mod ports;
mod processes;

use std::sync::Mutex;
use std::sync::mpsc::{self, Sender};

use serde::Serialize;
use sysinfo::{Components, CpuRefreshKind, Disks, Gpus, MemoryRefreshKind, RefreshKind, System};

use crate::error::{AppError, AppResult};

pub use ports::ListeningPort;
pub use processes::{KillOutcome, ProcessInfo, ProcessSort};

use crate::modules::runner::RunInfo;

fn opt<T>(r: Result<T, sysinfo::Error>) -> Option<T> {
    r.ok()
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemInfo {
    pub host_name: Option<String>,
    pub os_name: Option<String>,
    pub os_version: Option<String>,
    pub kernel_version: Option<String>,
    pub cpu_brand: String,
    pub cpu_cores: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskSnapshot {
    pub name: String,
    pub mount_point: String,
    pub file_system: String,
    pub total_bytes: u64,
    pub available_bytes: u64,
    pub removable: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemSnapshot {
    /// Utilisation CPU globale en pourcentage (0–100).
    pub cpu_usage: f32,
    /// Utilisation par cœur logique.
    pub cpu_per_core: Vec<f32>,
    pub memory_total: u64,
    pub memory_used: u64,
    pub swap_total: u64,
    pub swap_used: u64,
    pub disks: Vec<DiskSnapshot>,
    pub uptime_secs: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuSnapshot {
    pub vendor: Option<String>,
    pub model: Option<String>,
    /// Utilisation en pourcentage, si le pilote l'expose.
    pub usage: Option<f32>,
    pub memory_total: Option<u64>,
    pub memory_used: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SensorSnapshot {
    pub label: String,
    pub temperature: Option<f32>,
    pub critical: Option<f32>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HardwareSnapshot {
    pub gpus: Vec<GpuSnapshot>,
    /// Capteurs de température. Souvent vide sous Windows sans droits administrateur.
    pub sensors: Vec<SensorSnapshot>,
}

/// Collecte des métriques système. Les instances sysinfo sont conservées entre deux appels
/// car l'utilisation CPU est calculée à partir de la différence entre deux mesures.
/// Chaque famille de données a son propre verrou pour ne pas bloquer les autres.
pub struct SystemService {
    sys: Mutex<System>,
    disks: Mutex<Disks>,
    procs: Mutex<System>,
    hardware: Mutex<Sender<Sender<HardwareSnapshot>>>,
}

/// GPU et capteurs reposent sur des objets COM/WMI qui ne peuvent pas changer de thread :
/// un thread dédié les possède et répond aux demandes via un canal.
fn spawn_hardware_worker() -> Sender<Sender<HardwareSnapshot>> {
    let (tx, rx) = mpsc::channel::<Sender<HardwareSnapshot>>();
    std::thread::Builder::new()
        .name("devcenter-hardware".into())
        .spawn(move || {
            // Optionnels : l'absence de support ne doit pas empêcher le démarrage.
            let mut gpus = Gpus::new_with_refreshed_list().ok();
            let mut components = Components::new_with_refreshed_list().ok();
            for reply in rx {
                let _ = reply.send(collect_hardware(gpus.as_mut(), components.as_mut()));
            }
        })
        .expect("thread matériel");
    tx
}

fn collect_hardware(
    gpus: Option<&mut Gpus>,
    components: Option<&mut Components>,
) -> HardwareSnapshot {
    let gpus = match gpus {
        Some(list) => {
            list.refresh(true);
            list.iter()
                .map(|g| GpuSnapshot {
                    vendor: g.vendor().map(str::to_string),
                    model: g.model().map(str::to_string),
                    usage: g.usage(),
                    memory_total: g.total_memory(),
                    memory_used: g.used_memory(),
                })
                .collect()
        }
        None => Vec::new(),
    };
    let sensors = match components {
        Some(list) => {
            list.refresh(true);
            list.iter()
                .map(|c| SensorSnapshot {
                    label: c.label().to_string(),
                    temperature: c.temperature().filter(|t| t.is_finite()),
                    critical: c.critical().filter(|t| t.is_finite()),
                })
                .collect()
        }
        None => Vec::new(),
    };
    HardwareSnapshot { gpus, sensors }
}

impl SystemService {
    pub fn new() -> AppResult<Self> {
        let sys = System::new_with_specifics(
            RefreshKind::nothing()
                .with_cpu(CpuRefreshKind::nothing().with_usage())
                .with_memory(MemoryRefreshKind::everything()),
        )?;
        Ok(Self {
            sys: Mutex::new(sys),
            disks: Mutex::new(Disks::new_with_refreshed_list()?),
            procs: Mutex::new(System::new()?),
            hardware: Mutex::new(spawn_hardware_worker()),
        })
    }

    pub fn info(&self) -> AppResult<SystemInfo> {
        let sys = self.sys.lock()?;
        let cpus = sys.cpus();
        Ok(SystemInfo {
            host_name: opt(System::host_name()),
            os_name: opt(System::name()),
            os_version: opt(System::long_os_version()),
            kernel_version: opt(System::kernel_version()),
            cpu_brand: cpus
                .first()
                .map(|c| c.brand().trim().to_string())
                .unwrap_or_default(),
            cpu_cores: cpus.len(),
        })
    }

    pub fn snapshot(&self) -> AppResult<SystemSnapshot> {
        let mut sys = self.sys.lock()?;
        sys.refresh_cpu_usage();
        sys.refresh_memory();

        let mut disks = self.disks.lock()?;
        disks.refresh(true);

        Ok(SystemSnapshot {
            cpu_usage: sys.global_cpu_usage(),
            cpu_per_core: sys.cpus().iter().map(|c| c.usage()).collect(),
            memory_total: sys.total_memory(),
            memory_used: sys.used_memory(),
            swap_total: sys.total_swap(),
            swap_used: sys.used_swap(),
            disks: disks
                .iter()
                .map(|d| DiskSnapshot {
                    name: d.name().to_string_lossy().into_owned(),
                    mount_point: d.mount_point().to_string_lossy().into_owned(),
                    file_system: d.file_system().to_string_lossy().into_owned(),
                    total_bytes: d.total_space(),
                    available_bytes: d.available_space(),
                    removable: d.is_removable(),
                })
                .collect(),
            uptime_secs: System::uptime().unwrap_or(0),
        })
    }

    /// Ouvre un disque dans l'explorateur. Seuls les points de montage détectés sont acceptés.
    pub fn open_disk(&self, mount_point: &str) -> AppResult<()> {
        let path = {
            let disks = self.disks.lock()?;
            disks
                .iter()
                .map(|d| d.mount_point().to_path_buf())
                .find(|p| p.to_string_lossy() == mount_point)
                .ok_or_else(|| AppError::InvalidInput(format!("disque inconnu : {mount_point}")))?
        };
        tauri_plugin_opener::open_path(&path, None::<&str>).map_err(|e| {
            AppError::InvalidInput(format!("impossible d'ouvrir {} : {e}", path.display()))
        })
    }

    pub fn hardware(&self) -> AppResult<HardwareSnapshot> {
        let (reply_tx, reply_rx) = mpsc::channel();
        self.hardware
            .lock()?
            .send(reply_tx)
            .map_err(|_| AppError::Unavailable("matériel"))?;
        reply_rx
            .recv()
            .map_err(|_| AppError::Unavailable("matériel"))
    }

    /// Liste des processus ; avec `sort`/`limit`, seuls les premiers du classement sont renvoyés.
    pub fn processes(
        &self,
        sort: Option<ProcessSort>,
        limit: Option<usize>,
    ) -> AppResult<Vec<ProcessInfo>> {
        let cores = self.sys.lock()?.cpus().len().max(1);
        let mut list = {
            let mut procs = self.procs.lock()?;
            processes::list(&mut procs, cores)
        };
        if let Some(sort) = sort {
            processes::sort(&mut list, sort);
        }
        if let Some(limit) = limit {
            list.truncate(limit);
        }
        Ok(list)
    }

    pub fn kill_process(&self, pid: u32, start_time: u64) -> AppResult<KillOutcome> {
        let mut procs = self.procs.lock()?;
        processes::kill(&mut procs, pid, start_time)
    }

    /// Sockets TCP/UDP en écoute, rattachées à leur processus et au script DevCenter éventuel.
    pub fn listening_ports(&self, runs: &[RunInfo]) -> AppResult<Vec<ListeningPort>> {
        let mut procs = self.procs.lock()?;
        ports::list(&mut procs, runs)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collects_hardware_and_processes() {
        let svc = SystemService::new().unwrap();
        let hw = svc.hardware().unwrap();
        // Deux appels : le thread matériel doit rester disponible.
        svc.hardware().unwrap();
        eprintln!("gpus={} sensors={}", hw.gpus.len(), hw.sensors.len());
        for g in &hw.gpus {
            eprintln!(
                "  gpu {:?} usage={:?} vram={:?}/{:?}",
                g.model, g.usage, g.memory_used, g.memory_total
            );
        }

        let procs = svc.processes(None, None).unwrap();
        assert!(procs.len() > 10);
        let me = procs
            .iter()
            .find(|p| p.pid == std::process::id())
            .expect("processus courant listé");
        assert!(me.protected);
        assert!(
            procs
                .iter()
                .all(|p| p.cpu_usage >= 0.0 && p.cpu_usage <= 100.5)
        );
        eprintln!("processes={}", procs.len());
    }
}
