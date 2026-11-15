//! Branches Git : liste (locales et distantes), changement de branche et création.

use std::path::Path;

use serde::Serialize;

use crate::error::{AppError, AppResult};
use crate::modules::shell;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Branch {
    /// Nom court : `main`, ou `origin/main` pour une branche distante.
    pub name: String,
    pub remote: bool,
    pub current: bool,
    /// Branche distante suivie (`origin/main`), pour une branche locale.
    pub upstream: Option<String>,
    /// Horodatage Unix du dernier commit.
    pub timestamp: i64,
    pub subject: String,
}

/// Lance `git` et renvoie la sortie standard, ou le message d'erreur de git.
fn run(dir: &Path, args: &[&str]) -> AppResult<String> {
    let out = shell::command("git")
        .args(["-c", "core.quotepath=off", "-C"])
        .arg(dir)
        .args(args)
        .output()?;
    if out.status.success() {
        return Ok(String::from_utf8_lossy(&out.stdout).into_owned());
    }
    let stderr = String::from_utf8_lossy(&out.stderr);
    let msg: Vec<&str> = stderr
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with("hint:"))
        .collect();
    Err(AppError::InvalidInput(if msg.is_empty() { "commande git en échec".into() } else { msg.join("\n") }))
}

pub fn list(dir: &Path) -> AppResult<Vec<Branch>> {
    let text = run(
        dir,
        &[
            "for-each-ref",
            "--sort=-committerdate",
            "--format=%(refname)%1f%(refname:short)%1f%(HEAD)%1f%(upstream:short)%1f%(committerdate:unix)%1f%(contents:subject)",
            "refs/heads",
            "refs/remotes",
        ],
    )?;
    Ok(parse(&text))
}

fn parse(text: &str) -> Vec<Branch> {
    text.lines()
        .filter_map(|line| {
            let parts: Vec<&str> = line.split('\u{1f}').collect();
            let [full, short, head, upstream, ts, subject] = parts[..] else { return None };
            let remote = full.starts_with("refs/remotes/");
            // `origin/HEAD` n'est qu'un alias de la branche par défaut du dépôt distant.
            if remote && full.ends_with("/HEAD") {
                return None;
            }
            Some(Branch {
                name: short.to_string(),
                remote,
                current: head == "*",
                upstream: (!upstream.is_empty()).then(|| upstream.to_string()),
                timestamp: ts.parse().unwrap_or(0),
                subject: subject.to_string(),
            })
        })
        .collect()
}

fn validate(dir: &Path, name: &str) -> AppResult<()> {
    if name.is_empty() || name.starts_with('-') {
        return Err(AppError::InvalidInput("nom de branche invalide".into()));
    }
    run(dir, &["check-ref-format", "--branch", name])
        .map(|_| ())
        .map_err(|_| AppError::InvalidInput(format!("« {name} » n'est pas un nom de branche valide")))
}

/// Bascule sur `name`. Une branche distante (`origin/feature`) crée la branche locale
/// correspondante qui la suit, ou bascule dessus si elle existe déjà.
pub fn checkout(dir: &Path, name: &str, remote: bool) -> AppResult<()> {
    validate(dir, name)?;
    if remote {
        let local = name.split_once('/').map(|(_, b)| b).unwrap_or(name);
        let exists = run(dir, &["show-ref", "--verify", "--quiet", &format!("refs/heads/{local}")]).is_ok();
        if exists {
            run(dir, &["switch", local])?;
        } else {
            run(dir, &["switch", "--track", "-c", local, name])?;
        }
    } else {
        run(dir, &["switch", name])?;
    }
    Ok(())
}

/// Crée `name` à partir de `from` (HEAD par défaut) et bascule dessus si demandé.
pub fn create(dir: &Path, name: &str, from: Option<&str>, switch: bool) -> AppResult<()> {
    validate(dir, name)?;
    let from = from.map(str::trim).filter(|f| !f.is_empty());
    if from.is_some_and(|f| f.starts_with('-')) {
        return Err(AppError::InvalidInput("point de départ invalide".into()));
    }
    // Partir d'une branche distante ne doit pas la faire suivre automatiquement.
    let mut args = if switch { vec!["switch", "--no-track", "-c", name] } else { vec!["branch", "--no-track", name] };
    args.extend(from);
    run(dir, &args)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_branches() {
        let b = parse(
            "refs/heads/main\u{1f}main\u{1f}*\u{1f}origin/main\u{1f}100\u{1f}init\n\
             refs/remotes/origin/HEAD\u{1f}origin\u{1f} \u{1f}\u{1f}100\u{1f}init\n\
             refs/remotes/origin/dev\u{1f}origin/dev\u{1f} \u{1f}\u{1f}90\u{1f}wip\n",
        );
        assert_eq!(b.len(), 2);
        assert!(b[0].current && !b[0].remote);
        assert_eq!(b[0].upstream.as_deref(), Some("origin/main"));
        assert!(b[1].remote && !b[1].current);
        assert_eq!(b[1].name, "origin/dev");
    }
}
