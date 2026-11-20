//! Santé des dépendances d'un projet : paquets obsolètes et vulnérabilités connues.
//!
//! Vérification lancée à la demande, hors du thread principal : `<pm> outdated` / `<pm> audit`
//! pour Node (npm, pnpm, Yarn 1), `cargo outdated` / `cargo audit` pour Rust **seulement s'ils
//! sont déjà installés**. Rien n'est installé ni modifié dans le projet (aucun `--fix`, aucune
//! écriture de lockfile). Le dernier rapport est gardé en base avec son horodatage.

use std::collections::HashSet;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::database::Database;
use crate::error::{AppError, AppResult};
use crate::modules::shell;

const NODE_TIMEOUT: Duration = Duration::from_secs(120);
/// `cargo outdated` résout tout le graphe dans une copie temporaire : nettement plus lent.
const CARGO_TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Unknown,
    Info,
    Low,
    Moderate,
    High,
    Critical,
}

impl Severity {
    fn parse(s: &str) -> Self {
        match s.to_ascii_lowercase().as_str() {
            "critical" => Self::Critical,
            "high" => Self::High,
            "moderate" | "medium" => Self::Moderate,
            "low" => Self::Low,
            "info" | "informational" | "none" => Self::Info,
            _ => Self::Unknown,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutdatedPackage {
    /// `npm` (tous les gestionnaires Node) ou `cargo`.
    pub ecosystem: String,
    pub name: String,
    /// Version installée (absente si `node_modules` n'est pas installé).
    pub current: Option<String>,
    /// Plus haute version compatible avec la contrainte déclarée.
    pub wanted: Option<String>,
    pub latest: Option<String>,
    /// La dernière version change de version majeure (ou de mineure en 0.x).
    pub major: bool,
    /// `dependencies`, `devDependencies`, `Normal`, `Development`…
    pub kind: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Vulnerability {
    pub ecosystem: String,
    pub name: String,
    pub severity: Severity,
    pub title: String,
    pub url: Option<String>,
    /// Versions vulnérables.
    pub range: Option<String>,
    /// Correctif disponible (version ou indication).
    pub fix: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VulnCounts {
    pub critical: u32,
    pub high: u32,
    pub moderate: u32,
    pub low: u32,
    pub info: u32,
    pub unknown: u32,
}

impl VulnCounts {
    fn of(list: &[Vulnerability]) -> Self {
        let mut c = Self::default();
        for v in list {
            *match v.severity {
                Severity::Critical => &mut c.critical,
                Severity::High => &mut c.high,
                Severity::Moderate => &mut c.moderate,
                Severity::Low => &mut c.low,
                Severity::Info => &mut c.info,
                Severity::Unknown => &mut c.unknown,
            } += 1;
        }
        c
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DependencyReport {
    pub project_id: i64,
    /// Horodatage Unix (secondes) de la vérification.
    pub checked_at: i64,
    pub outdated: Vec<OutdatedPackage>,
    pub vulnerabilities: Vec<Vulnerability>,
    pub vuln_counts: VulnCounts,
    /// Commandes exécutées avec succès (« pnpm outdated », « cargo audit »…).
    pub tools: Vec<String>,
    /// Vérifications ignorées ou en échec, en clair.
    pub notes: Vec<String>,
}

/// Résumé affiché sur la carte du projet.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DependencySummary {
    pub project_id: i64,
    pub checked_at: i64,
    pub outdated: u32,
    pub major: u32,
    pub vuln_counts: VulnCounts,
}

impl From<&DependencyReport> for DependencySummary {
    fn from(r: &DependencyReport) -> Self {
        Self {
            project_id: r.project_id,
            checked_at: r.checked_at,
            outdated: r.outdated.len() as u32,
            major: r.outdated.iter().filter(|p| p.major).count() as u32,
            vuln_counts: r.vuln_counts.clone(),
        }
    }
}

// ---------------------------------------------------------------- Persistance

pub fn load(db: &Database, project_id: i64) -> AppResult<Option<DependencyReport>> {
    let raw: Option<String> = db.with(|conn| {
        Ok(conn
            .query_row(
                "SELECT report FROM dependency_reports WHERE project_id = ?1",
                params![project_id],
                |r| r.get(0),
            )
            .optional()?)
    })?;
    // Rapport illisible (format d'une ancienne version) : comme s'il n'y en avait pas.
    Ok(raw.and_then(|r| serde_json::from_str(&r).ok()))
}

pub fn summaries(db: &Database) -> AppResult<Vec<DependencySummary>> {
    let rows: Vec<String> = db.with(|conn| {
        let mut stmt = conn.prepare("SELECT report FROM dependency_reports")?;
        let rows = stmt.query_map([], |r| r.get(0))?;
        Ok(rows.collect::<Result<_, _>>()?)
    })?;
    Ok(rows
        .iter()
        .filter_map(|r| serde_json::from_str::<DependencyReport>(r).ok())
        .map(|r| DependencySummary::from(&r))
        .collect())
}

fn save(db: &Database, report: &DependencyReport) -> AppResult<()> {
    let json = serde_json::to_string(report)
        .map_err(|e| AppError::InvalidInput(format!("rapport illisible : {e}")))?;
    db.with(|conn| {
        conn.execute(
            "INSERT INTO dependency_reports (project_id, checked_at, report) VALUES (?1, ?2, ?3)
             ON CONFLICT(project_id) DO UPDATE SET checked_at = excluded.checked_at, report = excluded.report",
            params![report.project_id, report.checked_at, json],
        )?;
        Ok(())
    })
}

// ---------------------------------------------------------------- Vérification

fn running() -> &'static Mutex<HashSet<i64>> {
    static R: OnceLock<Mutex<HashSet<i64>>> = OnceLock::new();
    R.get_or_init(Default::default)
}

/// Lance toutes les vérifications disponibles et enregistre le rapport. Bloquant (jusqu'à
/// quelques minutes) : à appeler depuis une tâche de fond.
pub fn check(db: &Database, project_id: i64, dir: &Path) -> AppResult<DependencyReport> {
    if !running().lock()?.insert(project_id) {
        return Err(AppError::InvalidInput(
            "vérification des dépendances déjà en cours".into(),
        ));
    }
    let report = collect(project_id, dir);
    running().lock()?.remove(&project_id);
    save(db, &report)?;
    Ok(report)
}

/// Résultat d'une vérification réussie.
enum Outcome {
    Outdated(Vec<OutdatedPackage>),
    Vulns(Vec<Vulnerability>),
}

struct Task {
    label: String,
    program: PathBuf,
    args: Vec<&'static str>,
    dir: PathBuf,
    timeout: Duration,
    parse: fn(&str) -> Result<Outcome, String>,
}

fn collect(project_id: i64, dir: &Path) -> DependencyReport {
    let meta = super::detect::detect(dir);
    let mut tasks = Vec::new();
    let mut notes = Vec::new();

    if dir.join("package.json").is_file() {
        let pm = meta
            .package_manager
            .as_deref()
            .filter(|p| ["npm", "pnpm", "yarn", "bun"].contains(p))
            .unwrap_or("npm");
        node_tasks(pm, dir, &mut tasks, &mut notes);
    }
    let cargo_dir = [dir.to_path_buf(), dir.join("src-tauri")]
        .into_iter()
        .find(|d| d.join("Cargo.toml").is_file());
    if let Some(cargo_dir) = cargo_dir {
        cargo_tasks(&cargo_dir, &mut tasks, &mut notes);
    }
    if tasks.is_empty() && notes.is_empty() {
        notes.push("Aucun écosystème pris en charge (Node ou Rust) dans ce projet.".into());
    }

    // Les commandes tournent en parallèle (chacune attend surtout le réseau).
    let results: Vec<(String, Result<Outcome, String>)> = std::thread::scope(|s| {
        let handles: Vec<_> = tasks
            .iter()
            .map(|t| s.spawn(move || (t.label.clone(), execute(t))))
            .collect();
        handles.into_iter().filter_map(|h| h.join().ok()).collect()
    });

    let mut report = DependencyReport {
        project_id,
        checked_at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| d.as_secs() as i64),
        outdated: Vec::new(),
        vulnerabilities: Vec::new(),
        vuln_counts: VulnCounts::default(),
        tools: Vec::new(),
        notes,
    };
    for (label, result) in results {
        match result {
            Ok(Outcome::Outdated(list)) => {
                report.tools.push(label);
                report.outdated.extend(list);
            }
            Ok(Outcome::Vulns(list)) => {
                report.tools.push(label);
                report.vulnerabilities.extend(list);
            }
            Err(e) => report.notes.push(format!("{label} a échoué : {e}")),
        }
    }
    report.outdated.sort_by(|a, b| {
        b.major
            .cmp(&a.major)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    report.vulnerabilities.sort_by(|a, b| {
        b.severity
            .cmp(&a.severity)
            .then_with(|| a.name.cmp(&b.name))
    });
    report.vuln_counts = VulnCounts::of(&report.vulnerabilities);
    report
}

fn node_tasks(pm: &str, dir: &Path, tasks: &mut Vec<Task>, notes: &mut Vec<String>) {
    let Some(program) = shell::package_manager_program(pm) else {
        return;
    };
    let Some(program) = shell::which(&[program]) else {
        notes.push(format!(
            "{pm} introuvable dans le PATH : dépendances Node non vérifiées."
        ));
        return;
    };
    let task =
        |label: &str, args: Vec<&'static str>, parse: fn(&str) -> Result<Outcome, String>| Task {
            label: label.to_string(),
            program: program.clone(),
            args,
            dir: dir.to_path_buf(),
            timeout: NODE_TIMEOUT,
            parse,
        };
    match pm {
        "npm" => {
            tasks.push(task("npm outdated", vec!["outdated", "--json"], |s| {
                parse_npm_outdated(s).map(Outcome::Outdated)
            }));
            tasks.push(task("npm audit", vec!["audit", "--json"], |s| {
                parse_npm_audit(s).map(Outcome::Vulns)
            }));
        }
        "pnpm" => {
            tasks.push(task(
                "pnpm outdated",
                vec!["outdated", "--format", "json"],
                |s| parse_npm_outdated(s).map(Outcome::Outdated),
            ));
            tasks.push(task("pnpm audit", vec!["audit", "--json"], |s| {
                parse_npm_audit(s).map(Outcome::Vulns)
            }));
        }
        "yarn" if dir.join(".yarnrc.yml").is_file() => {
            notes
                .push("Yarn 2+ (Berry) : vérification des dépendances non prise en charge.".into());
        }
        "yarn" => {
            tasks.push(task("yarn outdated", vec!["outdated", "--json"], |s| {
                parse_yarn_outdated(s).map(Outcome::Outdated)
            }));
            tasks.push(task("yarn audit", vec!["audit", "--json"], |s| {
                parse_yarn_audit(s).map(Outcome::Vulns)
            }));
        }
        _ => notes.push(format!(
            "{pm} : pas de sortie JSON pour outdated/audit, vérification ignorée."
        )),
    }
}

/// Sous-commande Cargo installée (`cargo-outdated`, `cargo-audit`) : PATH, puis `~/.cargo/bin`.
fn cargo_subcommand(name: &str) -> bool {
    let exe = if cfg!(windows) {
        format!("cargo-{name}.exe")
    } else {
        format!("cargo-{name}")
    };
    if shell::which(&[&exe]).is_some() {
        return true;
    }
    let home = std::env::var_os("CARGO_HOME")
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
                .map(|h| PathBuf::from(h).join(".cargo"))
        });
    home.is_some_and(|h| h.join("bin").join(&exe).is_file())
}

fn cargo_tasks(dir: &Path, tasks: &mut Vec<Task>, notes: &mut Vec<String>) {
    let Some(cargo) = shell::which(&[if cfg!(windows) { "cargo.exe" } else { "cargo" }]) else {
        notes.push("cargo introuvable dans le PATH : dépendances Rust non vérifiées.".into());
        return;
    };
    if cargo_subcommand("outdated") {
        tasks.push(Task {
            label: "cargo outdated".into(),
            program: cargo.clone(),
            args: vec!["outdated", "--format", "json", "--root-deps-only"],
            dir: dir.to_path_buf(),
            timeout: CARGO_TIMEOUT,
            parse: |s| parse_cargo_outdated(s).map(Outcome::Outdated),
        });
    } else {
        notes.push("cargo-outdated n'est pas installé (cargo install cargo-outdated) : versions Rust non vérifiées.".into());
    }
    if !cargo_subcommand("audit") {
        notes.push("cargo-audit n'est pas installé (cargo install cargo-audit) : failles Rust non vérifiées.".into());
    } else if !dir.join("Cargo.lock").is_file() {
        // Sans lockfile, cargo audit en générerait un : on ne touche pas au projet.
        notes.push("cargo audit : pas de Cargo.lock, vérification ignorée.".into());
    } else {
        tasks.push(Task {
            label: "cargo audit".into(),
            program: cargo,
            args: vec!["audit", "--json"],
            dir: dir.to_path_buf(),
            timeout: CARGO_TIMEOUT,
            parse: |s| parse_cargo_audit(s).map(Outcome::Vulns),
        });
    }
}

/// Lance la commande sans fenêtre ni entrée, avec délai maximal. Le code de sortie est ignoré :
/// `outdated` et `audit` renvoient 1 dès qu'ils trouvent quelque chose. Seul le JSON compte.
fn execute(task: &Task) -> Result<Outcome, String> {
    let mut child = shell::command(&task.program)
        .args(&task.args)
        .current_dir(&task.dir)
        .env("CI", "1")
        .env("NO_COLOR", "1")
        .env("npm_config_update_notifier", "false")
        .env("npm_config_fund", "false")
        .env("COREPACK_ENABLE_DOWNLOAD_PROMPT", "0")
        .env("CARGO_TERM_COLOR", "never")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("impossible de lancer la commande ({e})"))?;

    // Lecture dans des threads : un tampon plein bloquerait le processus.
    let mut stdout = child.stdout.take().expect("stdout");
    let mut stderr = child.stderr.take().expect("stderr");
    let out = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = stdout.read_to_string(&mut s);
        s
    });
    let err = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = stderr.read_to_string(&mut s);
        s
    });

    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if started.elapsed() > task.timeout => {
                crate::modules::runner::kill_tree(child.id());
                let _ = child.wait();
                return Err(format!("pas de réponse après {} s", task.timeout.as_secs()));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(150)),
            Err(e) => return Err(e.to_string()),
        }
    }
    let out = out.join().unwrap_or_default();
    let err = err.join().unwrap_or_default();
    (task.parse)(&out).map_err(|e| {
        let detail = shell::strip_ansi(&err)
            .lines()
            .map(str::trim)
            .find(|l| !l.is_empty())
            .map(|l| l.chars().take(240).collect::<String>());
        match detail {
            Some(d) if out.trim().is_empty() || e.is_empty() => d,
            Some(d) => format!("{e} ({d})"),
            None => e,
        }
    })
}

// ---------------------------------------------------------------- Analyse des sorties

/// Premier entier d'une version : « ^1.2.3 » → (1, 2).
fn major_minor(version: &str) -> Option<(u64, u64)> {
    let v = version
        .trim()
        .trim_start_matches(|c: char| !c.is_ascii_digit());
    let mut parts = v.split(|c: char| !c.is_ascii_digit());
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next().and_then(|p| p.parse().ok()).unwrap_or(0);
    Some((major, minor))
}

/// Changement incompatible au sens semver : majeure différente, ou mineure différente en 0.x.
pub fn is_major_bump(from: &str, to: &str) -> bool {
    match (major_minor(from), major_minor(to)) {
        (Some((fa, fi)), Some((ta, ti))) => ta > fa || (fa == 0 && ta == 0 && ti > fi),
        _ => false,
    }
}

fn str_field(v: &Value, key: &str) -> Option<String> {
    v.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from)
}

/// JSON en tête de sortie : certains outils écrivent un avertissement avant (ou rien du tout).
fn parse_json(output: &str) -> Result<Option<Value>, String> {
    let text = output.trim();
    if text.is_empty() {
        return Ok(None);
    }
    let start = text.find(['{', '[']).ok_or("sortie non JSON")?;
    serde_json::from_str(&text[start..])
        .map(Some)
        .map_err(|e| format!("JSON illisible : {e}"))
}

/// Erreur structurée renvoyée par npm / pnpm (`{"error": {"code", "summary"}}`).
fn json_error(v: &Value) -> Option<String> {
    let e = v.get("error")?;
    Some(
        str_field(e, "summary")
            .or_else(|| str_field(e, "message"))
            .or_else(|| e.as_str().map(String::from))
            .or_else(|| str_field(e, "code"))
            .unwrap_or_else(|| "erreur inconnue".into()),
    )
}

fn outdated_entry(
    ecosystem: &str,
    name: &str,
    current: Option<String>,
    wanted: Option<String>,
    latest: Option<String>,
    kind: Option<String>,
) -> OutdatedPackage {
    let base = current.as_deref().or(wanted.as_deref());
    let major = matches!((base, latest.as_deref()), (Some(b), Some(l)) if is_major_bump(b, l));
    OutdatedPackage {
        ecosystem: ecosystem.into(),
        name: name.into(),
        current,
        wanted,
        latest,
        major,
        kind,
    }
}

/// `npm outdated --json` et `pnpm outdated --format json` : objet `{ paquet: { current, wanted, latest, type | dependencyType } }`.
/// Avec les workspaces npm, la valeur peut être un tableau (une entrée par emplacement).
pub fn parse_npm_outdated(output: &str) -> Result<Vec<OutdatedPackage>, String> {
    let Some(v) = parse_json(output)? else {
        return Ok(Vec::new());
    };
    if let Some(e) = json_error(&v) {
        return Err(e);
    }
    let obj = v.as_object().ok_or("objet JSON attendu")?;
    let mut list = Vec::new();
    for (name, entry) in obj {
        let entry = entry.as_array().and_then(|a| a.first()).unwrap_or(entry);
        list.push(outdated_entry(
            "npm",
            name,
            str_field(entry, "current"),
            str_field(entry, "wanted"),
            str_field(entry, "latest"),
            str_field(entry, "type").or_else(|| str_field(entry, "dependencyType")),
        ));
    }
    Ok(list)
}

fn npm_fix(fix: Option<&Value>) -> Option<String> {
    match fix? {
        Value::Bool(true) => Some("disponible".into()),
        Value::Object(o) => {
            let name = o.get("name").and_then(Value::as_str)?;
            let version = o.get("version").and_then(Value::as_str)?;
            let major = o
                .get("isSemVerMajor")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            Some(format!(
                "{name}@{version}{}",
                if major { " (majeure)" } else { "" }
            ))
        }
        _ => None,
    }
}

/// `npm audit --json` (format v2, npm 7+) ou format « advisories » (npm 6, `pnpm audit --json`).
pub fn parse_npm_audit(output: &str) -> Result<Vec<Vulnerability>, String> {
    let Some(v) = parse_json(output)? else {
        return Ok(Vec::new());
    };
    if let Some(e) = json_error(&v) {
        return Err(e);
    }
    let mut list = Vec::new();
    if let Some(vulns) = v.get("vulnerabilities").and_then(Value::as_object) {
        for (name, entry) in vulns {
            let via = entry
                .get("via")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let advisory = via.iter().find(|x| x.is_object());
            let title = advisory
                .and_then(|a| str_field(a, "title"))
                .unwrap_or_else(|| {
                    let parents: Vec<&str> = via.iter().filter_map(Value::as_str).collect();
                    if parents.is_empty() {
                        "Vulnérabilité".into()
                    } else {
                        format!("Via {}", parents.join(", "))
                    }
                });
            list.push(Vulnerability {
                ecosystem: "npm".into(),
                name: str_field(entry, "name").unwrap_or_else(|| name.clone()),
                severity: Severity::parse(
                    entry.get("severity").and_then(Value::as_str).unwrap_or(""),
                ),
                title,
                url: advisory.and_then(|a| str_field(a, "url")),
                range: str_field(entry, "range"),
                fix: npm_fix(entry.get("fixAvailable")),
            });
        }
    } else if let Some(advisories) = v.get("advisories").and_then(Value::as_object) {
        for a in advisories.values() {
            list.push(advisory_entry(a));
        }
    }
    Ok(dedupe(list))
}

/// Advisory au format npm 6 / pnpm / Yarn 1.
fn advisory_entry(a: &Value) -> Vulnerability {
    Vulnerability {
        ecosystem: "npm".into(),
        name: str_field(a, "module_name").unwrap_or_else(|| "?".into()),
        severity: Severity::parse(a.get("severity").and_then(Value::as_str).unwrap_or("")),
        title: str_field(a, "title").unwrap_or_else(|| "Vulnérabilité".into()),
        url: str_field(a, "url"),
        range: str_field(a, "vulnerable_versions"),
        fix: str_field(a, "patched_versions").filter(|p| p != "<0.0.0"),
    }
}

fn dedupe(list: Vec<Vulnerability>) -> Vec<Vulnerability> {
    let mut seen = HashSet::new();
    list.into_iter()
        .filter(|v| seen.insert((v.name.clone(), v.title.clone())))
        .collect()
}

/// Sortie NDJSON de Yarn 1 : une ligne JSON par événement.
fn ndjson(output: &str) -> impl Iterator<Item = Value> + '_ {
    output
        .lines()
        .filter_map(|l| serde_json::from_str::<Value>(l.trim()).ok())
}

/// `yarn outdated --json` (Yarn 1) : ligne `{"type":"table","data":{"head":[…],"body":[[…]]}}`.
pub fn parse_yarn_outdated(output: &str) -> Result<Vec<OutdatedPackage>, String> {
    let mut list = Vec::new();
    for line in ndjson(output) {
        match line.get("type").and_then(Value::as_str) {
            Some("error") => {
                return Err(str_field(&line, "data").unwrap_or_else(|| "erreur inconnue".into()));
            }
            Some("table") => {}
            _ => continue,
        }
        let data = &line["data"];
        let head: Vec<String> = data["head"]
            .as_array()
            .map(|h| {
                h.iter()
                    .filter_map(|x| x.as_str().map(str::to_lowercase))
                    .collect()
            })
            .unwrap_or_default();
        let col = |name: &str| head.iter().position(|h| h == name);
        let (Some(pkg), Some(cur), Some(want), Some(last)) =
            (col("package"), col("current"), col("wanted"), col("latest"))
        else {
            continue;
        };
        let kind = col("package type");
        for row in data["body"].as_array().into_iter().flatten() {
            let cell = |i: usize| {
                row.get(i)
                    .and_then(Value::as_str)
                    .map(String::from)
                    .filter(|s| !s.is_empty() && s != "exotic")
            };
            let Some(name) = cell(pkg) else { continue };
            list.push(outdated_entry(
                "npm",
                &name,
                cell(cur),
                cell(want),
                cell(last),
                kind.and_then(cell),
            ));
        }
    }
    Ok(list)
}

/// `yarn audit --json` (Yarn 1) : lignes `{"type":"auditAdvisory","data":{"advisory":{…}}}`.
pub fn parse_yarn_audit(output: &str) -> Result<Vec<Vulnerability>, String> {
    let mut list = Vec::new();
    for line in ndjson(output) {
        match line.get("type").and_then(Value::as_str) {
            Some("error") => {
                return Err(str_field(&line, "data").unwrap_or_else(|| "erreur inconnue".into()));
            }
            Some("auditAdvisory") => list.push(advisory_entry(&line["data"]["advisory"])),
            _ => {}
        }
    }
    Ok(dedupe(list))
}

/// `cargo outdated --format json` : un objet par crate du workspace, une ligne chacun.
/// `project` / `compat` / `latest` valent « --- » quand il n'y a rien à signaler.
pub fn parse_cargo_outdated(output: &str) -> Result<Vec<OutdatedPackage>, String> {
    let clean = |v: &Value, key: &str| str_field(v, key).filter(|s| s != "---" && s != "Removed");
    let mut list: Vec<OutdatedPackage> = Vec::new();
    let mut any = false;
    for doc in output
        .lines()
        .filter_map(|l| serde_json::from_str::<Value>(l.trim()).ok())
    {
        let Some(deps) = doc.get("dependencies").and_then(Value::as_array) else {
            continue;
        };
        any = true;
        for d in deps {
            let Some(name) = str_field(d, "name") else {
                continue;
            };
            let current = clean(d, "project");
            let latest = clean(d, "latest");
            let wanted = clean(d, "compat").or_else(|| current.clone());
            if (latest.is_none() || latest == current) && wanted == current {
                continue;
            }
            if list.iter().any(|p| p.name == name && p.current == current) {
                continue; // même dépendance dans plusieurs crates du workspace
            }
            list.push(outdated_entry(
                "cargo",
                &name,
                current,
                wanted,
                latest,
                str_field(d, "kind"),
            ));
        }
    }
    if !any && !output.trim().is_empty() {
        return Err("sortie inattendue".into());
    }
    Ok(list)
}

/// Score de base CVSS 3.x d'un vecteur (`CVSS:3.1/AV:N/AC:L/…`) → gravité.
fn cvss_severity(vector: &str) -> Severity {
    let metric = |key: &str| {
        vector
            .split('/')
            .find_map(|p| p.strip_prefix(key).and_then(|r| r.strip_prefix(':')))
    };
    let changed = metric("S") == Some("C");
    let weight = |key: &str, table: &[(&str, f64)]| {
        metric(key).and_then(|m| table.iter().find(|(k, _)| *k == m).map(|(_, w)| *w))
    };
    let (Some(av), Some(ac), Some(pr), Some(ui), Some(c), Some(i), Some(a)) = (
        weight("AV", &[("N", 0.85), ("A", 0.62), ("L", 0.55), ("P", 0.2)]),
        weight("AC", &[("L", 0.77), ("H", 0.44)]),
        weight(
            "PR",
            if changed {
                &[("N", 0.85), ("L", 0.68), ("H", 0.5)]
            } else {
                &[("N", 0.85), ("L", 0.62), ("H", 0.27)]
            },
        ),
        weight("UI", &[("N", 0.85), ("R", 0.62)]),
        weight("C", &[("H", 0.56), ("L", 0.22), ("N", 0.0)]),
        weight("I", &[("H", 0.56), ("L", 0.22), ("N", 0.0)]),
        weight("A", &[("H", 0.56), ("L", 0.22), ("N", 0.0)]),
    ) else {
        return Severity::Unknown;
    };
    let iss = 1.0 - (1.0 - c) * (1.0 - i) * (1.0 - a);
    let impact = if changed {
        7.52 * (iss - 0.029) - 3.25 * (iss - 0.02).powi(15)
    } else {
        6.42 * iss
    };
    let exploitability = 8.22 * av * ac * pr * ui;
    let roundup = |x: f64| (x * 10.0 - 1e-9).ceil() / 10.0;
    let score = if impact <= 0.0 {
        0.0
    } else if changed {
        roundup((1.08 * (impact + exploitability)).min(10.0))
    } else {
        roundup((impact + exploitability).min(10.0))
    };
    match score {
        s if s >= 9.0 => Severity::Critical,
        s if s >= 7.0 => Severity::High,
        s if s >= 4.0 => Severity::Moderate,
        s if s > 0.0 => Severity::Low,
        _ => Severity::Info,
    }
}

/// `cargo audit --json` : `vulnerabilities.list[]` avec `advisory` (id, titre, CVSS) et `package`.
pub fn parse_cargo_audit(output: &str) -> Result<Vec<Vulnerability>, String> {
    let Some(v) = parse_json(output)? else {
        return Err("aucune sortie".into());
    };
    let list = v
        .pointer("/vulnerabilities/list")
        .and_then(Value::as_array)
        .ok_or("champ « vulnerabilities » absent")?;
    let mut out = Vec::new();
    for item in list {
        let adv = &item["advisory"];
        let id = str_field(adv, "id");
        let severity = adv
            .get("severity")
            .and_then(Value::as_str)
            .map(Severity::parse)
            .or_else(|| adv.get("cvss").and_then(Value::as_str).map(cvss_severity))
            .unwrap_or(Severity::Unknown);
        let patched: Vec<&str> = item
            .pointer("/versions/patched")
            .and_then(Value::as_array)
            .map(|p| p.iter().filter_map(Value::as_str).collect())
            .unwrap_or_default();
        let title = str_field(adv, "title").unwrap_or_else(|| "Vulnérabilité".into());
        out.push(Vulnerability {
            ecosystem: "cargo".into(),
            name: str_field(&item["package"], "name")
                .or_else(|| str_field(adv, "package"))
                .unwrap_or_else(|| "?".into()),
            severity,
            title: match &id {
                Some(id) => format!("{id} · {title}"),
                None => title,
            },
            url: str_field(adv, "url")
                .or_else(|| id.map(|id| format!("https://rustsec.org/advisories/{id}"))),
            range: str_field(&item["package"], "version").map(|v| format!("={v}")),
            fix: (!patched.is_empty()).then(|| patched.join(" ou ")),
        });
    }
    Ok(dedupe(out))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_major_bumps() {
        assert!(is_major_bump("1.4.2", "2.0.0"));
        assert!(is_major_bump("^18.3.1", "19.0.0"));
        assert!(is_major_bump("0.2.9", "0.3.0"));
        assert!(!is_major_bump("1.4.2", "1.9.0"));
        assert!(!is_major_bump("0.2.1", "0.2.5"));
        assert!(!is_major_bump("git", "1.0.0"));
    }

    const NPM_OUTDATED: &str = r#"{
  "react": { "current": "18.2.0", "wanted": "18.3.1", "latest": "19.0.0", "dependent": "app", "location": "node_modules/react", "type": "dependencies" },
  "vite": { "current": "5.4.0", "wanted": "5.4.11", "latest": "5.4.11", "type": "devDependencies" },
  "lodash": [ { "wanted": "4.17.21", "latest": "4.17.21", "dependent": "web", "location": "packages/web" } ]
}"#;

    #[test]
    fn parses_npm_outdated() {
        let list = parse_npm_outdated(NPM_OUTDATED).unwrap();
        assert_eq!(list.len(), 3);
        let react = list.iter().find(|p| p.name == "react").unwrap();
        assert_eq!(react.current.as_deref(), Some("18.2.0"));
        assert_eq!(react.wanted.as_deref(), Some("18.3.1"));
        assert!(react.major);
        assert_eq!(react.kind.as_deref(), Some("dependencies"));
        let vite = list.iter().find(|p| p.name == "vite").unwrap();
        assert!(!vite.major);
        let lodash = list.iter().find(|p| p.name == "lodash").unwrap();
        assert_eq!(lodash.current, None);
        assert!(parse_npm_outdated("").unwrap().is_empty());
        assert!(parse_npm_outdated("{}").unwrap().is_empty());
    }

    #[test]
    fn parses_pnpm_outdated() {
        let out = r#"{ "typescript": { "current": "5.4.5", "latest": "5.6.3", "wanted": "5.4.5", "isDeprecated": false, "dependencyType": "devDependencies" } }"#;
        let list = parse_npm_outdated(out).unwrap();
        assert_eq!(list[0].kind.as_deref(), Some("devDependencies"));
        assert!(!list[0].major);
    }

    #[test]
    fn npm_errors_are_reported() {
        let out = r#"{ "error": { "code": "ENOLOCK", "summary": "This command requires an existing lockfile.", "detail": "Try creating one first" } }"#;
        assert_eq!(
            parse_npm_audit(out).unwrap_err(),
            "This command requires an existing lockfile."
        );
        assert!(parse_npm_outdated("not json").is_err());
    }

    const NPM_AUDIT: &str = r#"{
  "auditReportVersion": 2,
  "vulnerabilities": {
    "braces": {
      "name": "braces", "severity": "high", "isDirect": false,
      "via": [ { "source": 1098094, "name": "braces", "dependency": "braces", "title": "Uncontrolled resource consumption in braces", "url": "https://github.com/advisories/GHSA-grv7-fg5c-xmjg", "severity": "high", "range": "<3.0.3" } ],
      "effects": ["micromatch"], "range": "<3.0.3", "nodes": ["node_modules/braces"], "fixAvailable": true
    },
    "micromatch": {
      "name": "micromatch", "severity": "moderate", "isDirect": true,
      "via": ["braces"], "effects": [], "range": "<=4.0.7",
      "fixAvailable": { "name": "micromatch", "version": "4.0.8", "isSemVerMajor": false }
    },
    "next": {
      "name": "next", "severity": "critical", "isDirect": true,
      "via": [ { "title": "Authorization bypass in Next.js middleware", "url": "https://github.com/advisories/GHSA-f82v-jwr5-mffw", "severity": "critical" } ],
      "range": "13.0.0 - 14.2.24", "fixAvailable": { "name": "next", "version": "15.2.3", "isSemVerMajor": true }
    }
  },
  "metadata": { "vulnerabilities": { "info": 0, "low": 0, "moderate": 1, "high": 1, "critical": 1, "total": 3 } }
}"#;

    #[test]
    fn parses_npm_audit_v2() {
        let list = parse_npm_audit(NPM_AUDIT).unwrap();
        assert_eq!(list.len(), 3);
        let braces = list.iter().find(|v| v.name == "braces").unwrap();
        assert_eq!(braces.severity, Severity::High);
        assert_eq!(
            braces.url.as_deref(),
            Some("https://github.com/advisories/GHSA-grv7-fg5c-xmjg")
        );
        assert_eq!(braces.fix.as_deref(), Some("disponible"));
        let mm = list.iter().find(|v| v.name == "micromatch").unwrap();
        assert_eq!(mm.title, "Via braces");
        assert_eq!(mm.fix.as_deref(), Some("micromatch@4.0.8"));
        let next = list.iter().find(|v| v.name == "next").unwrap();
        assert_eq!(next.fix.as_deref(), Some("next@15.2.3 (majeure)"));
        let counts = VulnCounts::of(&list);
        assert_eq!((counts.critical, counts.high, counts.moderate), (1, 1, 1));

        let clean = r#"{ "auditReportVersion": 2, "vulnerabilities": {}, "metadata": {} }"#;
        assert!(parse_npm_audit(clean).unwrap().is_empty());
    }

    #[test]
    fn parses_pnpm_audit_advisories() {
        let out = r#"{
  "actions": [],
  "advisories": {
    "1097682": { "id": 1097682, "module_name": "semver", "severity": "moderate", "title": "semver vulnerable to Regular Expression Denial of Service", "url": "https://github.com/advisories/GHSA-c2qf-rxjj-qqgw", "vulnerable_versions": "<5.7.2", "patched_versions": ">=5.7.2", "findings": [ { "version": "5.7.1", "paths": ["a > semver"] } ] },
    "1098000": { "id": 1098000, "module_name": "ip", "severity": "low", "title": "ip SSRF", "url": "https://github.com/advisories/x", "vulnerable_versions": "<=2.0.1", "patched_versions": "<0.0.0" }
  },
  "metadata": { "vulnerabilities": { "info": 0, "low": 1, "moderate": 1, "high": 0, "critical": 0 } }
}"#;
        let list = parse_npm_audit(out).unwrap();
        assert_eq!(list.len(), 2);
        let semver = list.iter().find(|v| v.name == "semver").unwrap();
        assert_eq!(semver.severity, Severity::Moderate);
        assert_eq!(semver.range.as_deref(), Some("<5.7.2"));
        assert_eq!(semver.fix.as_deref(), Some(">=5.7.2"));
        assert_eq!(list.iter().find(|v| v.name == "ip").unwrap().fix, None);
    }

    #[test]
    fn parses_yarn_classic() {
        let outdated = r#"{"type":"info","data":"Color legend : ..."}
{"type":"table","data":{"head":["Package","Current","Wanted","Latest","Package Type","URL"],"body":[["chalk","2.4.2","2.4.2","5.3.0","dependencies","https://github.com/chalk/chalk"],["jest","29.6.0","29.7.0","29.7.0","devDependencies","https://jestjs.io"]]}}"#;
        let list = parse_yarn_outdated(outdated).unwrap();
        assert_eq!(list.len(), 2);
        assert!(list[0].major && list[0].name == "chalk");
        assert_eq!(list[1].kind.as_deref(), Some("devDependencies"));
        assert!(!list[1].major);

        let audit = r#"{"type":"auditAdvisory","data":{"resolution":{"id":1,"path":"a>minimist"},"advisory":{"module_name":"minimist","severity":"critical","title":"Prototype Pollution in minimist","url":"https://github.com/advisories/GHSA-xvch-5gv4-984h","vulnerable_versions":"<1.2.6","patched_versions":">=1.2.6"}}}
{"type":"auditAdvisory","data":{"resolution":{"id":1,"path":"b>minimist"},"advisory":{"module_name":"minimist","severity":"critical","title":"Prototype Pollution in minimist","url":"https://github.com/advisories/GHSA-xvch-5gv4-984h","vulnerable_versions":"<1.2.6","patched_versions":">=1.2.6"}}}
{"type":"auditSummary","data":{"vulnerabilities":{"info":0,"low":0,"moderate":0,"high":0,"critical":1}}}"#;
        let vulns = parse_yarn_audit(audit).unwrap();
        assert_eq!(vulns.len(), 1, "doublons fusionnés");
        assert_eq!(vulns[0].severity, Severity::Critical);
    }

    #[test]
    fn parses_cargo_outdated() {
        let out = r#"{"crate_name":"devcenter","dependencies":[{"name":"rusqlite","project":"0.31.0","compat":"---","latest":"0.32.1","kind":"Normal","platform":null},{"name":"serde","project":"1.0.200","compat":"1.0.215","latest":"1.0.215","kind":"Normal","platform":null},{"name":"old","project":"1.0.0","compat":"---","latest":"Removed","kind":"Development","platform":null}]}
{"crate_name":"other","dependencies":[{"name":"serde","project":"1.0.200","compat":"1.0.215","latest":"1.0.215","kind":"Normal","platform":null}]}"#;
        let list = parse_cargo_outdated(out).unwrap();
        assert_eq!(list.len(), 2, "{list:?}");
        let rusqlite = list.iter().find(|p| p.name == "rusqlite").unwrap();
        assert!(rusqlite.major);
        assert_eq!(rusqlite.wanted.as_deref(), Some("0.31.0"));
        let serde = list.iter().find(|p| p.name == "serde").unwrap();
        assert!(!serde.major);
        assert_eq!(serde.ecosystem, "cargo");
        assert!(parse_cargo_outdated("").unwrap().is_empty());
        assert!(parse_cargo_outdated("error: oops").is_err());
    }

    #[test]
    fn parses_cargo_audit() {
        let out = r#"{
  "database": { "advisory-count": 600 },
  "lockfile": { "dependency-count": 300 },
  "settings": {},
  "vulnerabilities": {
    "found": true, "count": 2,
    "list": [
      { "advisory": { "id": "RUSTSEC-2024-0001", "package": "h2", "title": "Resource exhaustion in h2", "date": "2024-01-17", "url": "https://github.com/hyperium/h2/issues/1", "cvss": "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H" },
        "versions": { "patched": ["^0.3.24", ">=0.4.2"], "unaffected": [] },
        "package": { "name": "h2", "version": "0.3.20" } },
      { "advisory": { "id": "RUSTSEC-2023-0071", "package": "rsa", "title": "Marvin Attack", "cvss": null },
        "versions": { "patched": [] },
        "package": { "name": "rsa", "version": "0.9.6" } }
    ]
  },
  "warnings": {}
}"#;
        let list = parse_cargo_audit(out).unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].name, "h2");
        assert_eq!(list[0].severity, Severity::High); // 7.5
        assert_eq!(list[0].fix.as_deref(), Some("^0.3.24 ou >=0.4.2"));
        assert_eq!(list[0].range.as_deref(), Some("=0.3.20"));
        assert_eq!(list[1].severity, Severity::Unknown);
        assert_eq!(
            list[1].url.as_deref(),
            Some("https://rustsec.org/advisories/RUSTSEC-2023-0071")
        );
        assert!(parse_cargo_audit("").is_err());
    }

    #[test]
    fn computes_cvss_severity() {
        assert_eq!(
            cvss_severity("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H"),
            Severity::Critical
        ); // 9.8
        assert_eq!(
            cvss_severity("CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N"),
            Severity::Moderate
        ); // 6.1
        assert_eq!(
            cvss_severity("CVSS:3.1/AV:L/AC:H/PR:H/UI:R/S:U/C:L/I:N/A:N"),
            Severity::Low
        ); // 1.8
        assert_eq!(cvss_severity("garbage"), Severity::Unknown);
    }

    #[test]
    fn stores_reports() {
        let dir = std::env::temp_dir().join(format!("devcenter-deps-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = Database::open(&dir.join("t.db")).unwrap();
        db.with(|c| {
            c.execute(
                "INSERT INTO projects (id, name, path, added_at) VALUES (1, 'a', 'C:\\a', 0)",
                [],
            )?;
            Ok(())
        })
        .unwrap();
        let mut report = DependencyReport {
            project_id: 1,
            checked_at: 42,
            outdated: parse_npm_outdated(NPM_OUTDATED).unwrap(),
            vulnerabilities: parse_npm_audit(NPM_AUDIT).unwrap(),
            vuln_counts: VulnCounts::default(),
            tools: vec!["npm outdated".into()],
            notes: vec![],
        };
        report.vuln_counts = VulnCounts::of(&report.vulnerabilities);
        save(&db, &report).unwrap();
        save(&db, &report).unwrap(); // remplace
        assert_eq!(load(&db, 1).unwrap().unwrap().outdated.len(), 3);
        let s = summaries(&db).unwrap();
        assert_eq!(
            (
                s.len(),
                s[0].outdated,
                s[0].major,
                s[0].vuln_counts.critical
            ),
            (1, 3, 1, 1)
        );
        std::fs::remove_dir_all(&dir).ok();
    }
}
