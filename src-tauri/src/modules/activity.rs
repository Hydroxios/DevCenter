//! Activité du développeur pour le tableau de bord : commits de tous les projets
//! (grille façon profil GitHub) et consommation Claude Code relevée par `ccusage`.

use std::collections::{BTreeMap, HashSet};
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use chrono::{Local, TimeZone};
use serde::Serialize;

use crate::error::{AppError, AppResult};
use crate::modules::shell;

// ---------------------------------------------------------------- Commits

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DayCount {
    /// Jour local, `AAAA-MM-JJ`.
    pub date: String,
    pub count: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitActivity {
    /// Jours ayant au moins un commit, triés.
    pub days: Vec<DayCount>,
    pub total: u32,
    /// Nombre de dépôts Git parcourus.
    pub repos: usize,
}

fn git(dir: &Path, args: &[&str]) -> Option<String> {
    let out = shell::command("git").arg("--no-optional-locks").arg("-C").arg(dir).args(args).output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Commits (hash, horodatage) de l'utilisateur Git configuré pour ce dépôt, toutes branches.
fn repo_commits(dir: &Path, since: &str) -> Vec<(String, i64)> {
    let Some(email) = git(dir, &["config", "user.email"]).map(|e| e.trim().to_string()).filter(|e| !e.is_empty()) else {
        return Vec::new();
    };
    let author = format!("--author={email}");
    let since = format!("--since={since}");
    let Some(text) = git(dir, &["log", "--all", "--no-color", "--fixed-strings", "-i", &author, &since, "--format=%H %at"]) else {
        return Vec::new();
    };
    text.lines()
        .filter_map(|l| {
            let (h, t) = l.split_once(' ')?;
            Some((h.to_string(), t.trim().parse().ok()?))
        })
        .collect()
}

/// Commits par jour sur les `days` derniers jours, tous projets confondus
/// (un commit présent dans plusieurs dossiers n'est compté qu'une fois).
pub fn commits(project_paths: Vec<String>, days: u32) -> CommitActivity {
    let since = format!("{} days ago", days.clamp(1, 800));
    let repos: Vec<String> = project_paths.into_iter().filter(|p| Path::new(p).join(".git").exists()).collect();

    let found: Vec<Vec<(String, i64)>> = std::thread::scope(|s| {
        let handles: Vec<_> = repos.iter().map(|p| s.spawn(|| repo_commits(Path::new(p), &since))).collect();
        handles.into_iter().map(|h| h.join().unwrap_or_default()).collect()
    });

    let mut seen = HashSet::new();
    let mut by_day: BTreeMap<String, u32> = BTreeMap::new();
    for (hash, ts) in found.into_iter().flatten() {
        if !seen.insert(hash) {
            continue;
        }
        if let Some(dt) = Local.timestamp_opt(ts, 0).single() {
            *by_day.entry(dt.format("%Y-%m-%d").to_string()).or_default() += 1;
        }
    }
    let total = by_day.values().sum();
    CommitActivity {
        days: by_day.into_iter().map(|(date, count)| DayCount { date, count }).collect(),
        total,
        repos: repos.len(),
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DayCommit {
    pub project_id: i64,
    pub project_name: String,
    pub hash: String,
    pub subject: String,
    /// Horodatage Unix de l'auteur.
    pub time: i64,
}

/// Commits de l'utilisateur pour un jour local (`AAAA-MM-JJ`), tous projets, du plus récent au plus ancien.
pub fn commits_on(projects: Vec<(i64, String, String)>, date: &str) -> AppResult<Vec<DayCommit>> {
    let day = chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d").map_err(|_| AppError::InvalidInput(format!("date invalide : {date}")))?;
    let local = |d: chrono::NaiveDate| Local.from_local_datetime(&d.and_hms_opt(0, 0, 0).unwrap_or_default()).earliest().map(|t| t.timestamp());
    let (Some(from), Some(to)) = (local(day), day.succ_opt().and_then(local)) else {
        return Ok(Vec::new());
    };
    // Fenêtre élargie d'un jour de chaque côté pour git, puis filtre exact sur l'horodatage.
    let since = (day - chrono::Duration::days(1)).format("%Y-%m-%d").to_string();
    let until = (day + chrono::Duration::days(2)).format("%Y-%m-%d").to_string();
    let repos: Vec<_> = projects.into_iter().filter(|(_, _, p)| Path::new(p).join(".git").exists()).collect();

    let found: Vec<Vec<DayCommit>> = std::thread::scope(|s| {
        let handles: Vec<_> = repos
            .iter()
            .map(|(id, name, path)| {
                let (since, until) = (&since, &until);
                s.spawn(move || {
                    let dir = Path::new(path);
                    let Some(email) = git(dir, &["config", "user.email"]).map(|e| e.trim().to_string()).filter(|e| !e.is_empty()) else {
                        return Vec::new();
                    };
                    let args = [
                        "log".to_string(),
                        "--all".into(),
                        "--no-color".into(),
                        "--fixed-strings".into(),
                        "-i".into(),
                        format!("--author={email}"),
                        format!("--since={since}"),
                        format!("--until={until}"),
                        "--format=%H%x1f%at%x1f%s".into(),
                    ];
                    let args: Vec<&str> = args.iter().map(String::as_str).collect();
                    git(dir, &args)
                        .unwrap_or_default()
                        .lines()
                        .filter_map(|l| {
                            let mut f = l.split('\u{1f}');
                            let hash = f.next()?.to_string();
                            let time: i64 = f.next()?.parse().ok()?;
                            let subject = f.next().unwrap_or("").to_string();
                            (from..to).contains(&time).then(|| DayCommit { project_id: *id, project_name: name.clone(), hash, subject, time })
                        })
                        .collect()
                })
            })
            .collect();
        handles.into_iter().map(|h| h.join().unwrap_or_default()).collect()
    });

    let mut seen = HashSet::new();
    let mut all: Vec<DayCommit> = found.into_iter().flatten().filter(|c| seen.insert(c.hash.clone())).collect();
    all.sort_by(|a, b| b.time.cmp(&a.time));
    Ok(all)
}

// ---------------------------------------------------------------- ccusage

/// Durée pendant laquelle un relevé `ccusage` est réutilisé (il prend plusieurs secondes).
const CCUSAGE_TTL: Duration = Duration::from_secs(60);

type Cached = Option<(Instant, u32, serde_json::Value)>;
static CCUSAGE: OnceLock<Mutex<Cached>> = OnceLock::new();

/// Programme et arguments pour lancer ccusage : installé globalement, sinon via npx ou bunx.
fn ccusage_command() -> AppResult<(std::path::PathBuf, Vec<&'static str>)> {
    if let Some(p) = shell::which(&["ccusage.cmd", "ccusage.exe", "ccusage"]) {
        return Ok((p, vec![]));
    }
    if let Some(p) = shell::which(&["npx.cmd", "npx"]) {
        return Ok((p, vec!["-y", "ccusage@latest"]));
    }
    if let Some(p) = shell::which(&["bunx.exe", "bunx", "bun.exe"]) {
        let bun = p.file_stem().is_some_and(|s| s == "bun");
        return Ok((p, if bun { vec!["x", "ccusage@latest"] } else { vec!["ccusage@latest"] }));
    }
    Err(AppError::InvalidInput("ccusage introuvable : installez Node.js (npx) ou `npm i -g ccusage`".into()))
}

/// Lance ccusage avec ces arguments et renvoie son JSON.
fn run_ccusage(args: &[&str]) -> AppResult<serde_json::Value> {
    let (program, prefix) = ccusage_command()?;
    let out = shell::command(&program)
        .args(prefix)
        .args(args)
        .env("NO_COLOR", "1")
        .output()
        .map_err(|e| AppError::InvalidInput(format!("impossible de lancer ccusage : {e}")))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(AppError::InvalidInput(format!("ccusage a échoué : {}", err.trim().chars().take(300).collect::<String>())));
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    // npx peut écrire des avertissements avant le JSON.
    let json = stdout.find('{').map_or(&*stdout, |i| &stdout[i..]);
    serde_json::from_str(json).map_err(|e| AppError::InvalidInput(format!("réponse de ccusage illisible : {e}")))
}

#[derive(Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProjectUsage {
    /// Dossier tel que Claude Code le nomme (`F--Projects-DevHub`).
    pub key: String,
    pub name: String,
    /// Projet DevCenter correspondant, s'il y en a un.
    pub project_id: Option<i64>,
    pub path: Option<String>,
    pub cost: f64,
    pub total_tokens: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_creation_tokens: u64,
    pub cache_read_tokens: u64,
    pub models: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageBlock {
    /// Début et fin réelle (ISO 8601) de la fenêtre de facturation de 5 h.
    pub start: String,
    pub end: Option<String>,
    pub active: bool,
    pub cost: f64,
    pub total_tokens: u64,
    pub entries: u64,
    pub models: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DayUsage {
    pub projects: Vec<ProjectUsage>,
    pub blocks: Vec<UsageBlock>,
}

/// Nom de dossier que Claude Code donne à un chemin : tout caractère non alphanumérique devient `-`.
fn claude_dir_key(path: &str) -> String {
    path.trim_end_matches(['\\', '/']).chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect()
}

/// Détail d'un jour (`AAAA-MM-JJ`) : coût par projet et fenêtres de 5 h.
pub fn ccusage_day(projects: Vec<(i64, String, String)>, date: &str) -> AppResult<DayUsage> {
    let day = chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d").map_err(|_| AppError::InvalidInput(format!("date invalide : {date}")))?;
    let d = day.format("%Y%m%d").to_string();

    let (by_project, blocks) = std::thread::scope(|s| {
        let a = s.spawn(|| run_ccusage(&["claude", "daily", "--instances", "--json", "--since", &d, "--until", &d]));
        let b = s.spawn(|| run_ccusage(&["blocks", "--json", "--since", &d, "--until", &d]));
        (a.join().unwrap_or_else(|_| Err(AppError::Unavailable("ccusage"))), b.join().unwrap_or_else(|_| Err(AppError::Unavailable("ccusage"))))
    });
    let by_project = by_project?;

    let known: Vec<(String, i64, String, String)> = projects.into_iter().map(|(id, name, path)| (claude_dir_key(&path), id, name, path)).collect();
    let u = |v: &serde_json::Value, k: &str| v.get(k).and_then(|x| x.as_u64()).unwrap_or(0);
    let strings = |v: Option<&serde_json::Value>| -> Vec<String> {
        v.and_then(|x| x.as_array()).map(|a| a.iter().filter_map(|s| s.as_str().map(str::to_string)).collect()).unwrap_or_default()
    };

    let mut out: Vec<ProjectUsage> = Vec::new();
    if let Some(map) = by_project.get("projects").and_then(|p| p.as_object()) {
        for (key, rows) in map {
            let mut p = ProjectUsage { key: key.clone(), ..Default::default() };
            if let Some((_, id, name, path)) = known.iter().find(|(k, ..)| k.eq_ignore_ascii_case(key)) {
                p.project_id = Some(*id);
                p.name = name.clone();
                p.path = Some(path.clone());
            } else {
                // Dossier inconnu de DevCenter : on garde la fin du chemin, plus lisible.
                p.name = key.rsplit("--").next().unwrap_or(key).to_string();
            }
            for r in rows.as_array().into_iter().flatten() {
                p.cost += r.get("totalCost").or_else(|| r.get("cost")).and_then(|x| x.as_f64()).unwrap_or(0.0);
                p.total_tokens += u(r, "totalTokens");
                p.input_tokens += u(r, "inputTokens");
                p.output_tokens += u(r, "outputTokens");
                p.cache_creation_tokens += u(r, "cacheCreationTokens");
                p.cache_read_tokens += u(r, "cacheReadTokens");
                for m in strings(r.get("modelsUsed")) {
                    if !p.models.contains(&m) {
                        p.models.push(m);
                    }
                }
            }
            if p.cost == 0.0 {
                // Coût absent des lignes par projet : on le recalcule depuis le détail par modèle.
                p.cost = rows
                    .as_array()
                    .into_iter()
                    .flatten()
                    .flat_map(|r| r.get("modelBreakdowns").and_then(|m| m.as_array()).cloned().unwrap_or_default())
                    .filter_map(|m| m.get("cost").and_then(|c| c.as_f64()))
                    .sum();
            }
            out.push(p);
        }
    }
    out.sort_by(|a, b| b.cost.total_cmp(&a.cost));

    // Les fenêtres de 5 h sont un plus : leur échec ne bloque pas le détail.
    let blocks = blocks
        .ok()
        .and_then(|b| b.get("blocks").and_then(|x| x.as_array()).cloned())
        .unwrap_or_default()
        .into_iter()
        .filter(|b| !b.get("isGap").and_then(|x| x.as_bool()).unwrap_or(false) && u(b, "entries") > 0)
        .map(|b| UsageBlock {
            start: b.get("startTime").and_then(|x| x.as_str()).unwrap_or_default().to_string(),
            end: b.get("actualEndTime").and_then(|x| x.as_str()).map(str::to_string),
            active: b.get("isActive").and_then(|x| x.as_bool()).unwrap_or(false),
            cost: b.get("costUSD").and_then(|x| x.as_f64()).unwrap_or(0.0),
            total_tokens: u(&b, "totalTokens"),
            entries: u(&b, "entries"),
            models: strings(b.get("models")),
        })
        .collect();

    Ok(DayUsage { projects: out, blocks })
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UsageTotal {
    pub cost: f64,
    pub tokens: u64,
    /// Premier jour relevé (`AAAA-MM-JJ`), s'il y en a un.
    pub since: Option<String>,
    pub active_days: usize,
}

static CCUSAGE_TOTAL: OnceLock<Mutex<Option<(Instant, UsageTotal)>>> = OnceLock::new();
/// Le total depuis le début change peu : relu toutes les 5 minutes au plus.
const TOTAL_TTL: Duration = Duration::from_secs(300);

/// Coût et tokens depuis le premier usage relevé par ccusage.
/// `force` ignore le cache (bouton « Actualiser »).
pub fn ccusage_total(force: bool) -> AppResult<UsageTotal> {
    let mut cache = CCUSAGE_TOTAL.get_or_init(|| Mutex::new(None)).lock().unwrap_or_else(|e| e.into_inner());
    if let Some((at, total)) = cache.as_ref() {
        if !force && at.elapsed() < TOTAL_TTL {
            return Ok(total.clone());
        }
    }
    let value = run_ccusage(&["daily", "--json"])?;
    let daily = value.get("daily").and_then(|d| d.as_array()).cloned().unwrap_or_default();
    let totals = value.get("totals");
    let total = UsageTotal {
        cost: totals
            .and_then(|t| t.get("totalCost"))
            .and_then(|x| x.as_f64())
            .unwrap_or_else(|| daily.iter().filter_map(|d| d.get("totalCost").and_then(|x| x.as_f64())).sum()),
        tokens: totals
            .and_then(|t| t.get("totalTokens"))
            .and_then(|x| x.as_u64())
            .unwrap_or_else(|| daily.iter().filter_map(|d| d.get("totalTokens").and_then(|x| x.as_u64())).sum()),
        since: daily.iter().filter_map(|d| d.get("period").and_then(|p| p.as_str())).min().map(str::to_string),
        active_days: daily.len(),
    };
    *cache = Some((Instant::now(), total.clone()));
    Ok(total)
}

/// Rapport quotidien de `ccusage daily --json` sur les `days` derniers jours.
/// `force` ignore le cache (bouton « Actualiser »).
pub fn ccusage(days: u32, force: bool) -> AppResult<serde_json::Value> {
    let days = days.clamp(1, 400);
    // Le verrou est gardé pendant le calcul : deux widgets ne lancent pas ccusage en même temps.
    let mut cache = CCUSAGE.get_or_init(|| Mutex::new(None)).lock().unwrap_or_else(|e| e.into_inner());
    if let Some((at, d, value)) = cache.as_ref() {
        if !force && *d >= days && at.elapsed() < CCUSAGE_TTL {
            return Ok(value.clone());
        }
    }

    let since = (Local::now() - chrono::Duration::days(days as i64 - 1)).format("%Y%m%d").to_string();
    let value = run_ccusage(&["daily", "--json", "--since", &since])?;
    *cache = Some((Instant::now(), days, value.clone()));
    Ok(value)
}
