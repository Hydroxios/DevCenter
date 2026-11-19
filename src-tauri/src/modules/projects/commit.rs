//! Préparation d'un commit : fichiers modifiés, index (stage / unstage), diff d'un fichier, commit, push.

use std::io::Write;
use std::path::Path;
use std::process::{Output, Stdio};

use serde::Serialize;

use crate::error::{AppError, AppResult};
use crate::modules::shell;

/// Taille maximale d'un diff renvoyé à l'interface.
const MAX_DIFF: usize = 256 * 1024;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    pub path: String,
    /// Ancien chemin d'un fichier renommé.
    pub orig_path: Option<String>,
    /// État dans l'index (`M`, `A`, `D`, `R`, `C`, `T`), ou `None` si rien n'est indexé.
    pub staged: Option<char>,
    /// État dans l'arbre de travail (`M`, `D`, `T`, `?` pour un fichier non suivi), ou `None`.
    pub unstaged: Option<char>,
    pub conflict: bool,
}

fn git(dir: &Path, args: &[&str]) -> std::io::Result<Output> {
    shell::command("git").args(["-c", "core.quotepath=off", "-C"]).arg(dir).args(args).output()
}

fn error_of(out: &Output) -> AppError {
    let text = format!("{}\n{}", String::from_utf8_lossy(&out.stderr), String::from_utf8_lossy(&out.stdout));
    let msg: Vec<&str> = text
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with("hint:"))
        .collect();
    AppError::InvalidInput(if msg.is_empty() { "commande git en échec".into() } else { msg.join("\n") })
}

fn run(dir: &Path, args: &[&str]) -> AppResult<String> {
    let out = git(dir, args)?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        Err(error_of(&out))
    }
}

/// Les chemins sont toujours passés après `--` : git ne peut pas les prendre pour des options.
fn check_paths(paths: &[String]) -> AppResult<()> {
    if paths.is_empty() {
        return Err(AppError::InvalidInput("aucun fichier".into()));
    }
    if paths.iter().any(String::is_empty) {
        return Err(AppError::InvalidInput("chemin invalide".into()));
    }
    Ok(())
}

pub fn changes(dir: &Path) -> AppResult<Vec<ChangedFile>> {
    let text = run(dir, &["status", "--porcelain=v2", "-z", "--untracked-files=all"])?;
    Ok(parse(&text))
}

fn state(c: u8) -> Option<char> {
    (c != b'.').then_some(c as char)
}

fn parse(text: &str) -> Vec<ChangedFile> {
    let mut files = Vec::new();
    let mut entries = text.split('\0').filter(|e| !e.is_empty());
    while let Some(entry) = entries.next() {
        let b = entry.as_bytes();
        match b.first() {
            Some(b'?') => files.push(ChangedFile {
                path: entry[2..].to_string(),
                orig_path: None,
                staged: None,
                unstaged: Some('?'),
                conflict: false,
            }),
            // « 1 XY sub mH mI mW hH hI chemin »
            Some(b'1') if b.len() > 4 => {
                if let Some(path) = entry.splitn(9, ' ').nth(8) {
                    files.push(ChangedFile {
                        path: path.to_string(),
                        orig_path: None,
                        staged: state(b[2]),
                        unstaged: state(b[3]),
                        conflict: false,
                    });
                }
            }
            // « 2 XY sub mH mI mW hH hI Xscore chemin » puis l'ancien chemin en entrée séparée.
            Some(b'2') if b.len() > 4 => {
                let orig = entries.next().map(str::to_string);
                if let Some(path) = entry.splitn(10, ' ').nth(9) {
                    files.push(ChangedFile {
                        path: path.to_string(),
                        orig_path: orig,
                        staged: state(b[2]),
                        unstaged: state(b[3]),
                        conflict: false,
                    });
                }
            }
            // « u XY sub m1 m2 m3 mW h1 h2 h3 chemin »
            Some(b'u') => {
                if let Some(path) = entry.splitn(11, ' ').nth(10) {
                    files.push(ChangedFile {
                        path: path.to_string(),
                        orig_path: None,
                        staged: None,
                        unstaged: Some('U'),
                        conflict: true,
                    });
                }
            }
            _ => {}
        }
    }
    files.sort_by(|a, b| a.path.to_lowercase().cmp(&b.path.to_lowercase()));
    files
}

/// Ajoute les fichiers à l'index (suppressions comprises).
pub fn stage(dir: &Path, paths: &[String]) -> AppResult<()> {
    check_paths(paths)?;
    let mut args = vec!["add", "-A", "--"];
    args.extend(paths.iter().map(String::as_str));
    run(dir, &args).map(|_| ())
}

/// Retire les fichiers de l'index sans toucher à l'arbre de travail.
pub fn unstage(dir: &Path, paths: &[String]) -> AppResult<()> {
    check_paths(paths)?;
    let has_head = run(dir, &["rev-parse", "--verify", "--quiet", "HEAD"]).is_ok();
    // Sans commit, il n'y a pas de HEAD à restaurer : on retire simplement de l'index.
    let mut args = if has_head { vec!["restore", "--staged", "--"] } else { vec!["rm", "--cached", "-r", "-q", "--"] };
    args.extend(paths.iter().map(String::as_str));
    run(dir, &args).map(|_| ())
}

/// Diff d'un fichier : version indexée (`staged`) ou modifications non indexées.
pub fn diff(dir: &Path, path: &str, staged: bool) -> AppResult<String> {
    check_paths(&[path.to_string()])?;
    let out = if staged {
        git(dir, &["diff", "--cached", "--no-color", "--no-ext-diff", "--", path])?
    } else {
        let tracked = git(dir, &["ls-files", "--error-unmatch", "--", path])?.status.success();
        if tracked {
            git(dir, &["diff", "--no-color", "--no-ext-diff", "--", path])?
        } else {
            // Fichier non suivi : comparé au vide. `--no-index` sort avec le code 1 s'il y a une différence.
            git(dir, &["diff", "--no-color", "--no-ext-diff", "--no-index", "--", "/dev/null", path])?
        }
    };
    if !matches!(out.status.code(), Some(0 | 1)) {
        return Err(error_of(&out));
    }
    let mut text = String::from_utf8_lossy(&out.stdout).into_owned();
    if text.len() > MAX_DIFF {
        let mut cut = MAX_DIFF;
        while !text.is_char_boundary(cut) {
            cut -= 1;
        }
        text.truncate(cut);
        text.push_str("\n… diff tronqué");
    }
    // Garde le diff à partir du premier bloc (les en-têtes répètent le nom du fichier).
    Ok(match text.find("\n@@") {
        Some(i) => text[i + 1..].to_string(),
        None => text,
    })
}

/// Crée un commit avec le contenu de l'index. `all` indexe d'abord toutes les modifications.
pub fn commit(dir: &Path, message: &str, all: bool) -> AppResult<()> {
    let message = message.trim();
    if message.is_empty() {
        return Err(AppError::InvalidInput("message de commit vide".into()));
    }
    if all {
        run(dir, &["add", "-A"])?;
    }
    let mut child = shell::command("git")
        .args(["-c", "core.quotepath=off", "-C"])
        .arg(dir)
        .args(["commit", "--cleanup=strip", "-F", "-"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // Pas d'éditeur ni d'invite interactive : l'app n'a pas de terminal.
        .env("GIT_EDITOR", "true")
        .env("GIT_TERMINAL_PROMPT", "0")
        .spawn()?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(message.as_bytes())?;
    }
    let out = child.wait_with_output()?;
    if out.status.success() {
        Ok(())
    } else {
        Err(error_of(&out))
    }
}

/// Pousse la branche courante. Sans branche suivie, la publie sur le dépôt distant
/// (`origin` de préférence) et la fait suivre (`-u`).
pub fn push(dir: &Path) -> AppResult<()> {
    let branch = run(dir, &["symbolic-ref", "--quiet", "--short", "HEAD"])
        .map_err(|_| AppError::InvalidInput("HEAD détachée : basculez sur une branche pour pousser".into()))?;
    let branch = branch.trim();
    let has_upstream = run(dir, &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]).is_ok();
    let mut args = vec!["push", "--porcelain"];
    let remotes = run(dir, &["remote"])?;
    let remote;
    if !has_upstream {
        let list: Vec<&str> = remotes.lines().map(str::trim).filter(|r| !r.is_empty()).collect();
        remote = match list.iter().find(|r| **r == "origin").or(list.first()) {
            Some(r) => r.to_string(),
            None => return Err(AppError::InvalidInput("aucun dépôt distant configuré (git remote add origin …)".into())),
        };
        args.extend(["-u", remote.as_str(), branch]);
    }
    let out = shell::command("git")
        .args(["-c", "core.quotepath=off", "-C"])
        .arg(dir)
        .args(&args)
        .stdin(Stdio::null())
        // Pas de terminal pour saisir un identifiant : échouer plutôt que bloquer.
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()?;
    if out.status.success() {
        Ok(())
    } else {
        Err(error_of(&out))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_porcelain_v2_z() {
        let text = "1 M. N... 100644 100644 100644 a b src/a b.rs\0\
                    1 .D N... 100644 100644 000000 a b gone.txt\0\
                    2 R. N... 100644 100644 100644 a b R100 new.rs\0old.rs\0\
                    u UU N... 100644 100644 100644 100644 a b c conflict.rs\0\
                    ? Notes.md\0";
        let f = parse(text);
        assert_eq!(f.len(), 5);
        let get = |p: &str| f.iter().find(|x| x.path == p).unwrap();
        assert_eq!(get("src/a b.rs").staged, Some('M'));
        assert_eq!(get("src/a b.rs").unstaged, None);
        assert_eq!(get("gone.txt").unstaged, Some('D'));
        assert_eq!(get("new.rs").orig_path.as_deref(), Some("old.rs"));
        assert!(get("conflict.rs").conflict);
        assert_eq!(get("Notes.md").unstaged, Some('?'));
    }

    #[test]
    fn rejects_empty_paths() {
        assert!(check_paths(&["".into()]).is_err());
        assert!(check_paths(&[]).is_err());
        assert!(check_paths(&["src/a.rs".into()]).is_ok());
    }

    /// Dépôt temporaire + dépôt distant nu : commit, publication de la branche, puis push simple.
    #[test]
    fn commit_then_push() {
        let root = std::env::temp_dir().join(format!("devcenter-push-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let (work, bare) = (root.join("work"), root.join("remote.git"));
        std::fs::create_dir_all(&work).unwrap();
        run(&root, &["init", "-q", "--bare", bare.to_str().unwrap()]).unwrap();
        run(&work, &["init", "-q", "-b", "main"]).unwrap();
        run(&work, &["config", "user.name", "t"]).unwrap();
        run(&work, &["config", "user.email", "t@t"]).unwrap();

        assert!(push(&work).is_err(), "pas de commit ni de distant");
        std::fs::write(work.join("a.txt"), "1").unwrap();
        commit(&work, "  premier  ", true).unwrap();
        assert!(changes(&work).unwrap().is_empty());
        assert!(push(&work).unwrap_err().to_string().contains("distant"));

        run(&work, &["remote", "add", "origin", bare.to_str().unwrap()]).unwrap();
        push(&work).unwrap();
        assert_eq!(run(&work, &["rev-parse", "--abbrev-ref", "@{u}"]).unwrap().trim(), "origin/main");

        std::fs::write(work.join("a.txt"), "2").unwrap();
        stage(&work, &["a.txt".into()]).unwrap();
        commit(&work, "second", false).unwrap();
        push(&work).unwrap();
        assert_eq!(run(&bare, &["log", "-1", "--format=%s", "main"]).unwrap().trim(), "second");
        let _ = std::fs::remove_dir_all(&root);
    }
}
