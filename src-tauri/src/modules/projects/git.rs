//! Informations Git via la CLI `git` (pas de dépendance native lourde).

use std::path::Path;

use serde::Serialize;

use crate::modules::shell;

#[derive(Debug, Default, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    /// Branche courante, ou `None` en HEAD détachée.
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub staged: u32,
    pub modified: u32,
    pub untracked: u32,
    pub conflicts: u32,
    pub last_commit: Option<LastCommit>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LastCommit {
    pub hash: String,
    pub subject: String,
    /// Horodatage Unix.
    pub timestamp: i64,
}

fn git(dir: &Path, args: &[&str]) -> Option<String> {
    let out = shell::command("git")
        // Évite de prendre le verrou de l'index (conflits avec l'IDE ouvert en parallèle).
        .args(["--no-optional-locks", "-c", "core.quotepath=off", "-C"])
        .arg(dir)
        .args(args)
        .output()
        .ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

pub fn status(dir: &Path) -> Option<GitStatus> {
    let text = git(dir, &["status", "--porcelain=v2", "--branch"])?;
    let mut s = parse_status(&text);
    if let Some(log) = git(dir, &["log", "-1", "--format=%h%x1f%s%x1f%ct"]) {
        let parts: Vec<&str> = log.trim_end().split('\u{1f}').collect();
        if let [hash, subject, ts] = parts[..] {
            s.last_commit = Some(LastCommit {
                hash: hash.into(),
                subject: subject.into(),
                timestamp: ts.parse().unwrap_or(0),
            });
        }
    }
    Some(s)
}

fn parse_status(text: &str) -> GitStatus {
    let mut s = GitStatus::default();
    for line in text.lines() {
        if let Some(head) = line.strip_prefix("# branch.head ") {
            s.branch = (head != "(detached)").then(|| head.to_string());
        } else if let Some(up) = line.strip_prefix("# branch.upstream ") {
            s.upstream = Some(up.to_string());
        } else if let Some(ab) = line.strip_prefix("# branch.ab ") {
            for part in ab.split_whitespace() {
                if let Some(n) = part.strip_prefix('+') {
                    s.ahead = n.parse().unwrap_or(0);
                } else if let Some(n) = part.strip_prefix('-') {
                    s.behind = n.parse().unwrap_or(0);
                }
            }
        } else if line.starts_with("? ") {
            s.untracked += 1;
        } else if line.starts_with("u ") {
            s.conflicts += 1;
        } else if line.starts_with("1 ") || line.starts_with("2 ") {
            // Champ XY : X = index (staged), Y = arbre de travail.
            let xy = line.as_bytes();
            if xy.len() > 3 {
                if xy[2] != b'.' {
                    s.staged += 1;
                }
                if xy[3] != b'.' {
                    s.modified += 1;
                }
            }
        }
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_porcelain_v2() {
        let s = parse_status(
            "# branch.oid abc\n# branch.head main\n# branch.upstream origin/main\n# branch.ab +2 -1\n\
             1 M. N... 100644 100644 100644 a b src/a.rs\n1 .M N... 100644 100644 100644 a b src/b.rs\n\
             1 MM N... 100644 100644 100644 a b src/c.rs\n? new.txt\nu UU N... 1 2 3 4 a b c x.rs\n",
        );
        assert_eq!(s.branch.as_deref(), Some("main"));
        assert_eq!((s.ahead, s.behind), (2, 1));
        assert_eq!((s.staged, s.modified, s.untracked, s.conflicts), (2, 2, 1, 1));
    }

    #[test]
    fn detached_head() {
        assert_eq!(parse_status("# branch.head (detached)\n").branch, None);
    }
}
