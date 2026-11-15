//! Tâches Gradle réelles d'un projet (`gradlew tasks --all`), mises en cache.
//!
//! Lister les tâches demande de configurer le build (plusieurs secondes) : c'est fait à la
//! demande, hors du thread principal, et le résultat est gardé tant que les fichiers de build
//! ne changent pas. En attendant, `detect` propose une liste de tâches courantes.

use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime};

use crate::error::{AppError, AppResult};
use crate::modules::shell;

use super::detect::Script;

/// Fichiers dont la modification change la liste des tâches.
const BUILD_FILES: &[&str] = &[
    "build.gradle",
    "build.gradle.kts",
    "settings.gradle",
    "settings.gradle.kts",
    "gradle.properties",
    "gradle/libs.versions.toml",
    "app/build.gradle",
    "app/build.gradle.kts",
    "buildSrc",
];

/// Groupes Gradle standard, dans l'ordre d'affichage. Les groupes propres au projet passent avant.
const STANDARD_GROUPS: &[&str] =
    &["Application", "Build", "Verification", "Documentation", "Distribution", "Publishing", "Shadow", "Other", "Build Setup", "Help"];

const TIMEOUT: Duration = Duration::from_secs(240);

struct Entry {
    fingerprint: u128,
    tasks: Vec<Script>,
}

fn cache() -> &'static Mutex<HashMap<PathBuf, Entry>> {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, Entry>>> = OnceLock::new();
    CACHE.get_or_init(Default::default)
}

fn loading() -> &'static Mutex<HashSet<PathBuf>> {
    static LOADING: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();
    LOADING.get_or_init(Default::default)
}

/// Empreinte des fichiers de build : date de modification la plus récente.
fn fingerprint(dir: &Path) -> u128 {
    BUILD_FILES
        .iter()
        .filter_map(|f| std::fs::metadata(dir.join(f)).and_then(|m| m.modified()).ok())
        .filter_map(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map(|d| d.as_nanos())
        .max()
        .unwrap_or(0)
}

/// Tâches en cache, si les fichiers de build n'ont pas changé depuis la lecture.
pub fn cached(dir: &Path) -> Option<Vec<Script>> {
    let cache = cache().lock().ok()?;
    let entry = cache.get(dir)?;
    (entry.fingerprint == fingerprint(dir)).then(|| entry.tasks.clone())
}

fn rank(group: &str) -> usize {
    STANDARD_GROUPS.iter().position(|g| g.eq_ignore_ascii_case(group)).map_or(0, |i| i + 1)
}

fn valid_task(name: &str) -> bool {
    !name.is_empty() && name.len() <= 200 && name.chars().all(|c| c.is_ascii_alphanumeric() || ":_-.".contains(c))
}

/// Analyse la sortie de `gradle tasks --all` : un groupe par titre souligné de tirets,
/// une tâche par ligne (`nom - description`). La section « Rules » (motifs) est ignorée.
pub fn parse(output: &str, exe: &str) -> Vec<Script> {
    let lines: Vec<&str> = output.lines().map(str::trim_end).collect();
    let is_rule = |l: &str| l.len() >= 3 && l.chars().all(|c| c == '-');
    let mut group: Option<String> = None;
    let mut tasks: Vec<(usize, usize, Script)> = Vec::new();
    for (i, line) in lines.iter().enumerate() {
        if line.is_empty() || is_rule(line) {
            continue;
        }
        if lines.get(i + 1).is_some_and(|next| is_rule(next)) {
            // Titre de section ; l'en-tête « Tasks runnable from… » est encadré de tirets.
            group = (!lines.get(i.wrapping_sub(1)).is_some_and(|prev| is_rule(prev))).then(|| line.trim().to_string());
            continue;
        }
        let Some(g) = group.as_deref().map(|g| g.strip_suffix(" tasks").unwrap_or(g)) else { continue };
        if g.eq_ignore_ascii_case("Rules") {
            continue;
        }
        let (name, about) = match line.split_once(" - ") {
            Some((n, d)) => (n.trim(), d.trim()),
            None => (line.trim(), ""),
        };
        if !valid_task(name) || tasks.iter().any(|(_, _, s)| s.name == name) {
            continue;
        }
        let command = if about.is_empty() { format!("{exe} {name}") } else { format!("{exe} {name} · {about}") };
        tasks.push((rank(g), tasks.len(), Script { name: name.to_string(), command, group: Some(g.to_string()) }));
    }
    // Groupes du projet d'abord, puis groupes standard ; ordre de Gradle à l'intérieur d'un groupe.
    tasks.sort_by_key(|(r, i, _)| (*r, *i));
    tasks.into_iter().map(|(_, _, s)| s).collect()
}

/// Lance `gradlew tasks --all` et met le résultat en cache. Bloquant (plusieurs secondes).
pub fn load(dir: &Path) -> AppResult<Vec<Script>> {
    if let Some(tasks) = cached(dir) {
        return Ok(tasks);
    }
    if !loading().lock()?.insert(dir.to_path_buf()) {
        return Err(AppError::InvalidInput("lecture des tâches Gradle déjà en cours".into()));
    }
    let result = run(dir);
    loading().lock()?.remove(dir);
    let tasks = result?;
    cache().lock()?.insert(dir.to_path_buf(), Entry { fingerprint: fingerprint(dir), tasks: tasks.clone() });
    Ok(tasks)
}

fn run(dir: &Path) -> AppResult<Vec<Script>> {
    let program = shell::gradle_program(dir)
        .ok_or_else(|| AppError::InvalidInput("Gradle introuvable : ni gradlew dans le projet, ni gradle dans le PATH".into()))?;
    let exe = if program.starts_with(dir) { "gradlew" } else { "gradle" };
    let mut child = shell::command(&program)
        .args(["tasks", "--all", "--console=plain", "-q"])
        .current_dir(dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| AppError::InvalidInput(format!("impossible de lancer Gradle : {e}")))?;

    // Lecture dans des threads : un tampon plein bloquerait Gradle.
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
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if started.elapsed() > TIMEOUT {
            crate::modules::runner::kill_tree(child.id());
            let _ = child.wait();
            return Err(AppError::InvalidInput("Gradle n'a pas répondu à temps (4 min)".into()));
        }
        std::thread::sleep(Duration::from_millis(150));
    };
    let out = out.join().unwrap_or_default();
    let err = err.join().unwrap_or_default();
    if !status.success() {
        let detail = err.lines().map(str::trim).find(|l| !l.is_empty() && !l.starts_with('*')).unwrap_or("erreur inconnue");
        return Err(AppError::InvalidInput(format!("gradle tasks a échoué : {detail}")));
    }
    let tasks = parse(&out, exe);
    if tasks.is_empty() {
        return Err(AppError::InvalidInput("aucune tâche Gradle trouvée".into()));
    }
    Ok(tasks)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "
------------------------------------------------------------
Tasks runnable from root project 'HxUHC'
------------------------------------------------------------

Build tasks
-----------
assemble - Assembles the outputs of this project.
build - Assembles and tests this project.

Help tasks
----------
tasks - Displays the tasks runnable from root project 'HxUHC'.

Uhc tasks
---------
deploy - Copies the plugin jar into server/plugins/.
runServer - Builds, deploys and starts the test server.

Other tasks
-----------
compileJava - Compiles main Java source.
prepareKotlinBuildScriptModel
app:assembleDebug - Sub-project task.

Rules
-----
Pattern: clean<TaskName>: Cleans the output files of a task.
";

    #[test]
    fn parses_task_report() {
        let tasks = parse(SAMPLE, "gradlew");
        let names: Vec<&str> = tasks.iter().map(|t| t.name.as_str()).collect();
        assert_eq!(
            names,
            ["deploy", "runServer", "assemble", "build", "compileJava", "prepareKotlinBuildScriptModel", "app:assembleDebug", "tasks"]
        );
        assert_eq!(tasks[0].group.as_deref(), Some("Uhc"));
        assert_eq!(tasks[1].command, "gradlew runServer · Builds, deploys and starts the test server.");
        assert!(!names.iter().any(|n| n.starts_with("Pattern")));
    }

    /// Projet Gradle réel : `DEVCENTER_GRADLE_PROJECT=<dossier> cargo test gradle`.
    #[test]
    fn loads_real_project_tasks() {
        let Some(dir) = std::env::var_os("DEVCENTER_GRADLE_PROJECT").map(PathBuf::from) else { return };
        let tasks = load(&dir).unwrap();
        for t in &tasks {
            eprintln!("{:<14} {}", t.group.as_deref().unwrap_or(""), t.command);
        }
        assert!(tasks.iter().any(|t| t.name == "build"));
        assert!(cached(&dir).is_some());
        let meta = super::super::detect::detect(&dir);
        assert!(meta.tasks_loaded);
        assert_eq!(meta.scripts.len(), tasks.len());
    }
}
