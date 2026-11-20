//! Historique Git : graphe des commits (toutes les branches) et détail d'un commit avec son diff.
//!
//! Le placement du graphe (colonnes et liaisons) est calculé ici une seule fois, pour que
//! l'application de bureau et la page mobile dessinent exactement le même arbre.

use std::path::Path;

use serde::Serialize;

use crate::error::{AppError, AppResult};
use crate::modules::shell;

/// Nombre de couleurs de branches côté interface.
const PALETTE: usize = 8;
/// Taille maximale du diff renvoyé (au-delà, tronqué).
const MAX_DIFF_BYTES: usize = 400 * 1024;
const MAX_FILE_DIFF_LINES: usize = 1500;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphEdge {
    /// Colonne de départ (ligne du commit) et d'arrivée (ligne suivante).
    pub from: usize,
    pub to: usize,
    pub color: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphCommit {
    pub hash: String,
    pub short: String,
    pub parents: Vec<String>,
    pub author: String,
    pub timestamp: i64,
    pub subject: String,
    /// Branches, tags, HEAD (`HEAD -> main`, `origin/main`, `tag: v1.0`).
    pub refs: Vec<String>,
    pub column: usize,
    pub color: usize,
    /// Segments entre cette ligne et la suivante.
    pub edges: Vec<GraphEdge>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitLog {
    pub commits: Vec<GraphCommit>,
    /// Nombre de colonnes à prévoir pour dessiner le graphe.
    pub width: usize,
    /// D'autres commits existent au-delà de la limite.
    pub truncated: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub path: String,
    /// Ancien chemin en cas de renommage.
    pub old_path: Option<String>,
    /// added | deleted | modified | renamed | binary
    pub status: String,
    pub additions: u32,
    pub deletions: u32,
    pub patch: String,
    pub truncated: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitDetails {
    pub hash: String,
    pub parents: Vec<String>,
    pub author: String,
    pub author_email: String,
    pub authored_at: i64,
    pub committer: String,
    pub committed_at: i64,
    pub refs: Vec<String>,
    pub subject: String,
    pub body: String,
    pub files: Vec<FileChange>,
    pub additions: u32,
    pub deletions: u32,
    /// Diff trop volumineux : certains fichiers n'ont pas leur contenu.
    pub diff_truncated: bool,
}

fn git(dir: &Path, args: &[&str]) -> AppResult<String> {
    let out = shell::command("git")
        .args([
            "--no-optional-locks",
            "-c",
            "core.quotepath=off",
            "-c",
            "log.showSignature=false",
            "-C",
        ])
        .arg(dir)
        .args(args)
        .output()
        .map_err(|e| AppError::InvalidInput(format!("git introuvable : {e}")))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        let err = String::from_utf8_lossy(&out.stderr);
        if err.contains("does not have any commits") || err.contains("bad default revision") {
            return Ok(String::new());
        }
        Err(AppError::InvalidInput(
            err.trim().chars().take(300).collect(),
        ))
    }
}

fn parse_refs(raw: &str) -> Vec<String> {
    raw.split(", ")
        .map(str::trim)
        .filter(|r| !r.is_empty() && *r != "origin/HEAD")
        .map(str::to_string)
        .collect()
}

/// Graphe des `limit` commits les plus récents, toutes branches confondues.
pub fn log(dir: &Path, limit: usize) -> AppResult<GitLog> {
    let limit = limit.clamp(10, 1000);
    let n = (limit + 1).to_string();
    let text = git(
        dir,
        &[
            "log",
            "--all",
            "--date-order",
            "--no-color",
            "-n",
            &n,
            "--format=%H%x1f%P%x1f%an%x1f%at%x1f%D%x1f%s%x1e",
        ],
    )?;
    let mut raw: Vec<RawCommit> = text
        .split('\u{1e}')
        .filter_map(|rec| {
            let f: Vec<&str> = rec.trim_start_matches('\n').split('\u{1f}').collect();
            (f.len() >= 6 && !f[0].is_empty()).then(|| {
                (
                    f[0].to_string(),
                    f[1].split_whitespace().map(str::to_string).collect(),
                    f[2].to_string(),
                    f[3].parse().unwrap_or(0),
                    parse_refs(f[4]),
                    f[5].trim_end().to_string(),
                )
            })
        })
        .collect();
    let truncated = raw.len() > limit;
    raw.truncate(limit);
    Ok(layout(raw, truncated))
}

/// Commit brut lu dans `git log` : hash, parents, auteur, date, refs, message.
type RawCommit = (String, Vec<String>, String, i64, Vec<String>, String);

/// Placement des commits en colonnes (algorithme classique des « voies » de `git log --graph`).
fn layout(raw: Vec<RawCommit>, truncated: bool) -> GitLog {
    // Voie = hash attendu dans cette colonne + couleur.
    let mut lanes: Vec<Option<(String, usize)>> = Vec::new();
    let mut next_color = 0usize;
    let mut width = 1;
    let mut commits = Vec::with_capacity(raw.len());

    let mut new_color = || {
        let c = next_color % PALETTE;
        next_color += 1;
        c
    };

    for (hash, parents, author, timestamp, refs, subject) in raw {
        // Colonne du commit : la voie qui l'attendait, sinon une voie libre (nouvelle pointe de branche).
        let col = match lanes
            .iter()
            .position(|l| l.as_ref().is_some_and(|(h, _)| *h == hash))
        {
            Some(c) => c,
            None => {
                let c = lanes
                    .iter()
                    .position(Option::is_none)
                    .unwrap_or(lanes.len());
                let color = new_color();
                if c == lanes.len() {
                    lanes.push(Some((hash.clone(), color)));
                } else {
                    lanes[c] = Some((hash.clone(), color));
                }
                c
            }
        };
        let color = lanes[col].as_ref().map(|(_, c)| *c).unwrap_or(0);

        // Autres voies qui attendaient aussi ce commit (branches qui se rejoignent ici).
        let converging: Vec<usize> = lanes
            .iter()
            .enumerate()
            .filter(|(i, l)| *i != col && l.as_ref().is_some_and(|(h, _)| *h == hash))
            .map(|(i, _)| i)
            .collect();

        let mut next = lanes.clone();
        for &i in &converging {
            next[i] = None;
        }
        next[col] = None;
        let mut parent_cols = Vec::new();
        for (k, p) in parents.iter().enumerate() {
            if let Some(i) = next
                .iter()
                .position(|l| l.as_ref().is_some_and(|(h, _)| h == p))
            {
                if k == 0 && i > col {
                    // Le premier parent est déjà attendu plus à droite : l'historique continue dans la
                    // colonne la plus à gauche, l'autre voie vient la rejoindre.
                    next[i] = None;
                    next[col] = Some((p.clone(), color));
                    parent_cols.push((col, color));
                } else {
                    parent_cols.push((i, next[i].as_ref().map(|(_, c)| *c).unwrap_or(color)));
                }
            } else if k == 0 {
                next[col] = Some((p.clone(), color));
                parent_cols.push((col, color));
            } else {
                let i = next.iter().position(Option::is_none).unwrap_or(next.len());
                let c = new_color();
                if i == next.len() {
                    next.push(Some((p.clone(), c)));
                } else {
                    next[i] = Some((p.clone(), c));
                }
                parent_cols.push((i, c));
            }
        }

        // Segments vers la ligne suivante.
        let mut edges = Vec::new();
        for (i, lane) in lanes.iter().enumerate() {
            if i == col || converging.contains(&i) {
                continue;
            }
            if let Some((h, c)) = lane
                && let Some(j) = next
                    .iter()
                    .position(|l| l.as_ref().is_some_and(|(nh, _)| nh == h))
            {
                edges.push(GraphEdge {
                    from: i,
                    to: j,
                    color: *c,
                });
            }
        }
        for &(to, c) in &parent_cols {
            edges.push(GraphEdge {
                from: col,
                to,
                color: c,
            });
        }

        while next.last().is_some_and(Option::is_none) {
            next.pop();
        }
        width = width.max(lanes.len()).max(next.len());
        lanes = next;

        let short = hash.chars().take(7).collect();
        commits.push(GraphCommit {
            hash,
            short,
            parents,
            author,
            timestamp,
            subject,
            refs,
            column: col,
            color,
            edges,
        });
        // Convergences : les voies fusionnées rejoignent ce commit (dessinées sur la ligne précédente).
        if !converging.is_empty() {
            let row = commits.len() - 1;
            if row > 0 {
                let prev = &mut commits[row - 1].edges;
                for e in prev.iter_mut() {
                    if converging.contains(&e.to) {
                        e.to = col;
                    }
                }
            }
        }
    }
    GitLog {
        commits,
        width,
        truncated,
    }
}

fn validate_hash(hash: &str) -> AppResult<()> {
    if (7..=40).contains(&hash.len()) && hash.chars().all(|c| c.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err(AppError::InvalidInput(
            "identifiant de commit invalide".into(),
        ))
    }
}

/// Détail d'un commit : message complet, fichiers modifiés et diff (par rapport au premier parent).
pub fn commit(dir: &Path, hash: &str) -> AppResult<CommitDetails> {
    validate_hash(hash)?;
    let meta = git(
        dir,
        &[
            "show",
            "--no-color",
            "--no-patch",
            "--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%cn%x1f%ct%x1f%D%x1f%s%x1f%b",
            hash,
        ],
    )?;
    let f: Vec<&str> = meta.splitn(10, '\u{1f}').collect();
    if f.len() < 10 {
        return Err(AppError::InvalidInput("commit introuvable".into()));
    }

    // Statistiques par fichier (renommages détectés).
    let numstat = git(
        dir,
        &[
            "show",
            "--no-color",
            "--format=",
            "--numstat",
            "-M",
            "--diff-merges=first-parent",
            "-z",
            hash,
        ],
    )?;
    let mut files: Vec<FileChange> = Vec::new();
    let mut parts = numstat
        .split('\0')
        .filter(|s| !s.is_empty() || false)
        .peekable();
    while let Some(entry) = parts.next() {
        let entry = entry.trim_start_matches('\n');
        let cols: Vec<&str> = entry.splitn(3, '\t').collect();
        if cols.len() < 3 {
            continue;
        }
        let binary = cols[0] == "-";
        let (add, del) = (cols[0].parse().unwrap_or(0), cols[1].parse().unwrap_or(0));
        // Renommage avec -z : chemin vide, puis ancien et nouveau chemins dans les deux champs suivants.
        let (path, old_path) = if cols[2].is_empty() {
            let old = parts.next().unwrap_or_default().to_string();
            let new = parts.next().unwrap_or_default().to_string();
            (new, Some(old))
        } else {
            (cols[2].to_string(), None)
        };
        files.push(FileChange {
            status: if binary {
                "binary".into()
            } else if old_path.is_some() {
                "renamed".into()
            } else {
                "modified".into()
            },
            path,
            old_path,
            additions: add,
            deletions: del,
            patch: String::new(),
            truncated: false,
        });
    }

    // Diff complet, découpé par fichier.
    let patch = git(
        dir,
        &[
            "show",
            "--no-color",
            "--format=",
            "--patch",
            "-M",
            "--diff-merges=first-parent",
            hash,
        ],
    )?;
    let diff_truncated = patch.len() > MAX_DIFF_BYTES;
    let patch = if diff_truncated {
        &patch[..floor_char_boundary(&patch, MAX_DIFF_BYTES)]
    } else {
        &patch[..]
    };
    for chunk in patch.split("\ndiff --git ").enumerate().map(|(i, c)| {
        if i == 0 {
            c.trim_start_matches("diff --git ").to_string()
        } else {
            c.to_string()
        }
    }) {
        if chunk.trim().is_empty() {
            continue;
        }
        let header = chunk.lines().next().unwrap_or("");
        let status = if chunk.contains("\nnew file mode") {
            Some("added")
        } else if chunk.contains("\ndeleted file mode") {
            Some("deleted")
        } else {
            None
        };
        // « a/x b/y » : on retrouve le fichier par son nouveau chemin.
        let target = files
            .iter_mut()
            .find(|f| header.ends_with(&format!(" b/{}", f.path)));
        if let Some(file) = target {
            if let Some(st) = status {
                file.status = st.into();
            }
            let body: Vec<&str> = chunk.lines().skip_while(|l| !l.starts_with("@@")).collect();
            file.truncated = body.len() > MAX_FILE_DIFF_LINES;
            file.patch = body
                .into_iter()
                .take(MAX_FILE_DIFF_LINES)
                .collect::<Vec<_>>()
                .join("\n");
        }
    }

    let additions = files.iter().map(|f| f.additions).sum();
    let deletions = files.iter().map(|f| f.deletions).sum();
    Ok(CommitDetails {
        hash: f[0].to_string(),
        parents: f[1].split_whitespace().map(str::to_string).collect(),
        author: f[2].to_string(),
        author_email: f[3].to_string(),
        authored_at: f[4].parse().unwrap_or(0),
        committer: f[5].to_string(),
        committed_at: f[6].parse().unwrap_or(0),
        refs: parse_refs(f[7]),
        subject: f[8].to_string(),
        body: f[9].trim().to_string(),
        files,
        additions,
        deletions,
        diff_truncated,
    })
}

fn floor_char_boundary(s: &str, mut i: usize) -> usize {
    while i > 0 && !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

#[cfg(test)]
mod tests {
    use super::*;

    fn c(h: &str, parents: &[&str]) -> (String, Vec<String>, String, i64, Vec<String>, String) {
        (
            h.into(),
            parents.iter().map(|s| s.to_string()).collect(),
            "a".into(),
            0,
            vec![],
            h.into(),
        )
    }

    #[test]
    fn layout_branch_and_merge() {
        // M fusionne B (branche) dans A ; ordre : M, B, A, R
        //   M
        //   |\
        //   | B
        //   A |
        //   |/
        //   R
        let g = layout(
            vec![
                c("M", &["A", "B"]),
                c("B", &["R"]),
                c("A", &["R"]),
                c("R", &[]),
            ],
            false,
        );
        let col = |h: &str| g.commits.iter().find(|x| x.hash == h).unwrap().column;
        assert_eq!(col("M"), 0);
        assert_eq!(col("B"), 1);
        assert_eq!(col("A"), 0);
        assert_eq!(col("R"), 0);
        assert_eq!(g.width, 2);
        // M a deux segments : vers A (col 0) et vers B (col 1).
        let m = &g.commits[0];
        assert!(m.edges.iter().any(|e| e.from == 0 && e.to == 0));
        assert!(m.edges.iter().any(|e| e.from == 0 && e.to == 1));
        // La ligne de A doit ramener la voie de B vers R (convergence en colonne 0).
        let a = &g.commits[2];
        assert!(a.edges.iter().any(|e| e.from == 1 && e.to == 0));
    }

    #[test]
    fn linear_history_uses_one_column() {
        let g = layout(vec![c("3", &["2"]), c("2", &["1"]), c("1", &[])], false);
        assert!(g.commits.iter().all(|x| x.column == 0));
        assert_eq!(g.width, 1);
    }

    #[test]
    fn rejects_bad_hashes() {
        assert!(validate_hash("1986b2a").is_ok());
        assert!(validate_hash("HEAD; rm").is_err());
        assert!(validate_hash("--all").is_err());
    }

    /// Sur le dépôt DevCenter lui-même (s'il a des commits).
    #[test]
    fn reads_a_real_repository() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        let log = log(root, 50).unwrap();
        if let Some(first) = log.commits.first() {
            let d = commit(root, &first.hash).unwrap();
            assert_eq!(d.hash, first.hash);
        }
    }
}

#[cfg(test)]
mod live_tests {
    use super::*;

    /// `cargo test --lib history::live -- --ignored --nocapture` (lecture seule sur F:\Projects\hxim).
    #[test]
    #[ignore]
    fn live_hxim() {
        let dir = Path::new(r"F:\Projects\hxim");
        let g = log(dir, 300).unwrap();
        let merges = g.commits.iter().filter(|c| c.parents.len() > 1).count();
        eprintln!(
            "{} commits, {} fusions, largeur {}, tronqué {}",
            g.commits.len(),
            merges,
            g.width,
            g.truncated
        );
        // Chaque segment doit relier des colonnes existantes, et chaque parent visible doit être relié.
        for (r, c) in g.commits.iter().enumerate() {
            for e in &c.edges {
                assert!(e.from < g.width && e.to < g.width, "ligne {r}");
            }
            if let Some(next) = g.commits.get(r + 1) {
                if c.parents.contains(&next.hash) {
                    assert!(
                        c.edges
                            .iter()
                            .any(|e| e.from == c.column && e.to == next.column),
                        "parent non relié ligne {r}"
                    );
                }
            }
        }
        let merge = g.commits.iter().find(|c| c.parents.len() > 1).unwrap();
        let d = commit(dir, &merge.hash).unwrap();
        eprintln!(
            "fusion {} : {} fichiers +{} -{}",
            merge.short,
            d.files.len(),
            d.additions,
            d.deletions
        );
        let normal = g.commits.iter().find(|c| c.parents.len() == 1).unwrap();
        let d = commit(dir, &normal.hash).unwrap();
        eprintln!(
            "commit {} « {} » : {} fichiers, premier : {} ({}), patch {} lignes",
            normal.short,
            d.subject,
            d.files.len(),
            d.files[0].path,
            d.files[0].status,
            d.files[0].patch.lines().count()
        );
        assert!(
            d.files
                .iter()
                .any(|f| !f.patch.is_empty() || f.status == "binary")
        );
    }
}
