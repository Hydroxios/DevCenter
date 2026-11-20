//! Statistiques de temps : durée passée par workspace et par projet, et commits par projet.
//!
//! Sources : sessions de workspace (`workspace_sessions`), exécutions de scripts (`script_runs`)
//! et commits Git (module `activity`). Le temps d'un projet est l'union des intervalles où un
//! workspace qui l'inclut ou l'un de ses scripts tournait : les chevauchements ne comptent qu'une fois.

use std::collections::{BTreeMap, HashMap, HashSet};

use chrono::{Local, TimeZone};
use rusqlite::params;
use serde::Serialize;

use crate::database::Database;
use crate::error::AppResult;
use crate::modules::workspaces::Step;
use crate::modules::{activity, projects};

/// Intervalle `[début, fin[` en secondes Unix.
pub type Interval = (i64, i64);

/// Fusionne des intervalles qui se chevauchent ou se touchent ; les intervalles vides sont ignorés.
pub fn merge_intervals(mut list: Vec<Interval>) -> Vec<Interval> {
    list.retain(|(a, b)| b > a);
    list.sort_unstable();
    let mut out: Vec<Interval> = Vec::with_capacity(list.len());
    for (start, end) in list {
        match out.last_mut() {
            Some(last) if start <= last.1 => last.1 = last.1.max(end),
            _ => out.push((start, end)),
        }
    }
    out
}

/// Durée totale d'intervalles déjà fusionnés.
pub fn total(list: &[Interval]) -> i64 {
    list.iter().map(|(a, b)| b - a).sum()
}

/// Restreint un intervalle à la période `[from, to[`.
fn clip((a, b): Interval, from: i64, to: i64) -> Option<Interval> {
    let (a, b) = (a.max(from), b.min(to));
    (b > a).then_some((a, b))
}

/// Découpe des intervalles fusionnés par jour local (`AAAA-MM-JJ` → secondes).
fn split_by_day(list: &[Interval]) -> BTreeMap<String, i64> {
    let mut out = BTreeMap::new();
    for &(start, end) in list {
        let mut cur = start;
        while cur < end {
            let Some(dt) = Local.timestamp_opt(cur, 0).single() else {
                break;
            };
            let day = dt.date_naive();
            let next = day
                .succ_opt()
                .and_then(|d| d.and_hms_opt(0, 0, 0))
                .and_then(|d| Local.from_local_datetime(&d).earliest())
                .map(|d| d.timestamp())
                .filter(|&n| n > cur)
                .unwrap_or(cur + 86_400);
            let seg_end = next.min(end);
            *out.entry(day.format("%Y-%m-%d").to_string()).or_default() += seg_end - cur;
            cur = seg_end;
        }
    }
    out
}

// ------------------------------------------------------------------ Résultat

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DayTime {
    pub date: String,
    pub seconds: i64,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceTime {
    /// `None` : workspace supprimé depuis (seul son nom reste dans l'historique).
    pub id: Option<i64>,
    pub name: String,
    pub seconds: i64,
    pub sessions: u32,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectTime {
    pub id: i64,
    pub name: String,
    pub seconds: i64,
    /// Sessions de workspace incluant ce projet.
    pub sessions: u32,
    /// Exécutions de scripts du projet.
    pub runs: u32,
    pub commits: u32,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TimeStats {
    pub days: u32,
    /// Début (minuit local) et fin (maintenant) de la période, secondes Unix.
    pub from: i64,
    pub to: i64,
    /// Temps d'activité total (union de toutes les sessions et exécutions).
    pub total_seconds: i64,
    /// Jours ayant de l'activité, triés.
    pub daily: Vec<DayTime>,
    pub workspaces: Vec<WorkspaceTime>,
    pub projects: Vec<ProjectTime>,
}

// ------------------------------------------------------------------ Calcul

pub struct SessionSpan {
    pub workspace_id: Option<i64>,
    pub name: String,
    pub start: i64,
    pub end: i64,
}

pub struct RunSpan {
    pub project_id: i64,
    pub start: i64,
    pub end: i64,
}

pub struct Inputs<'a> {
    /// Sessions triées par début.
    pub sessions: &'a [SessionSpan],
    pub runs: &'a [RunSpan],
    /// Projets inclus dans chaque workspace (d'après ses étapes).
    pub workspace_projects: &'a HashMap<i64, HashSet<i64>>,
    /// Projets connus (id, nom).
    pub projects: &'a [(i64, String)],
    pub commits: &'a HashMap<i64, u32>,
}

/// Calcul pur des statistiques sur `[from, to[`.
pub fn build(input: Inputs, days: u32, from: i64, to: i64) -> TimeStats {
    let known: HashMap<i64, &str> = input
        .projects
        .iter()
        .map(|(id, n)| (*id, n.as_str()))
        .collect();
    let mut all: Vec<Interval> = Vec::new();

    // Par workspace : identifié par son id, ou par son nom s'il a été supprimé.
    let mut by_ws: HashMap<(Option<i64>, String), (String, Vec<Interval>, u32)> = HashMap::new();
    let mut by_project: HashMap<i64, (Vec<Interval>, u32, u32)> = HashMap::new();
    for s in input.sessions {
        let Some(iv) = clip((s.start, s.end), from, to) else {
            continue;
        };
        all.push(iv);
        let key = (
            s.workspace_id,
            if s.workspace_id.is_some() {
                String::new()
            } else {
                s.name.clone()
            },
        );
        let entry = by_ws
            .entry(key)
            .or_insert_with(|| (s.name.clone(), Vec::new(), 0));
        entry.0 = s.name.clone(); // nom le plus récent (sessions triées par début)
        entry.1.push(iv);
        entry.2 += 1;
        if let Some(projects) = s
            .workspace_id
            .and_then(|id| input.workspace_projects.get(&id))
        {
            for p in projects.iter().filter(|p| known.contains_key(p)) {
                let e = by_project.entry(*p).or_default();
                e.0.push(iv);
                e.1 += 1;
            }
        }
    }
    for r in input.runs {
        let Some(iv) = clip((r.start, r.end), from, to) else {
            continue;
        };
        if !known.contains_key(&r.project_id) {
            continue;
        }
        all.push(iv);
        let e = by_project.entry(r.project_id).or_default();
        e.0.push(iv);
        e.2 += 1;
    }

    let mut workspaces: Vec<WorkspaceTime> = by_ws
        .into_iter()
        .map(|((id, _), (name, list, sessions))| WorkspaceTime {
            id,
            name,
            seconds: total(&merge_intervals(list)),
            sessions,
        })
        .collect();
    workspaces.sort_by(|a, b| {
        b.seconds
            .cmp(&a.seconds)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    let mut projects: Vec<ProjectTime> = input
        .projects
        .iter()
        .filter_map(|(id, name)| {
            let (list, sessions, runs) = by_project.remove(id).unwrap_or_default();
            let commits = input.commits.get(id).copied().unwrap_or(0);
            let seconds = total(&merge_intervals(list));
            (seconds > 0 || commits > 0).then(|| ProjectTime {
                id: *id,
                name: name.clone(),
                seconds,
                sessions,
                runs,
                commits,
            })
        })
        .collect();
    projects.sort_by(|a, b| {
        b.seconds
            .cmp(&a.seconds)
            .then(b.commits.cmp(&a.commits))
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    let merged = merge_intervals(all);
    TimeStats {
        days,
        from,
        to,
        total_seconds: total(&merged),
        daily: split_by_day(&merged)
            .into_iter()
            .map(|(date, seconds)| DayTime { date, seconds })
            .collect(),
        workspaces,
        projects,
    }
}

/// Minuit local, `days - 1` jours avant aujourd'hui : la période couvre `days` jours calendaires.
fn period_start(days: u32) -> i64 {
    let day = Local::now().date_naive() - chrono::Duration::days(days as i64 - 1);
    day.and_hms_opt(0, 0, 0)
        .and_then(|d| Local.from_local_datetime(&d).earliest())
        .map(|d| d.timestamp())
        .unwrap_or_else(|| Local::now().timestamp() - days as i64 * 86_400)
}

/// Statistiques des `days` derniers jours (sessions et scripts en cours comptés jusqu'à maintenant).
pub fn time_stats(db: &Database, days: u32) -> AppResult<TimeStats> {
    let days = days.clamp(1, 365);
    let to = Local::now().timestamp();
    let from = period_start(days);

    let (sessions, runs, steps) = db.with(|conn| {
        let mut stmt = conn.prepare(
            "SELECT workspace_id, workspace_name, started_at, COALESCE(ended_at, ?1) FROM workspace_sessions
             WHERE COALESCE(ended_at, ?1) > ?2 AND started_at < ?1 ORDER BY started_at, id",
        )?;
        let sessions: Vec<SessionSpan> = stmt
            .query_map(params![to, from], |r| Ok(SessionSpan { workspace_id: r.get(0)?, name: r.get(1)?, start: r.get(2)?, end: r.get(3)? }))?
            .collect::<Result<_, _>>()?;
        let mut stmt = conn.prepare(
            "SELECT project_id, started_at, COALESCE(ended_at, ?1) FROM script_runs
             WHERE COALESCE(ended_at, ?1) > ?2 AND started_at < ?1",
        )?;
        let runs: Vec<RunSpan> = stmt
            .query_map(params![to, from], |r| Ok(RunSpan { project_id: r.get(0)?, start: r.get(1)?, end: r.get(2)? }))?
            .collect::<Result<_, _>>()?;
        let mut stmt = conn.prepare("SELECT workspace_id, action FROM workspace_steps")?;
        let steps: Vec<(i64, String)> = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<Result<_, _>>()?;
        Ok((sessions, runs, steps))
    })?;

    let mut workspace_projects: HashMap<i64, HashSet<i64>> = HashMap::new();
    for (ws, json) in steps {
        if let Ok(
            Step::Editor { project_id }
            | Step::Folder { project_id }
            | Step::Script { project_id, .. },
        ) = serde_json::from_str::<Step>(&json)
        {
            workspace_projects.entry(ws).or_default().insert(project_id);
        }
    }

    let list = projects::list(db)?;
    let commits = activity::commits_by_project(
        list.iter()
            .filter(|p| p.exists)
            .map(|p| (p.id, p.path.clone()))
            .collect(),
        days,
    );
    let known: Vec<(i64, String)> = list.into_iter().map(|p| (p.id, p.name)).collect();

    Ok(build(
        Inputs {
            sessions: &sessions,
            runs: &runs,
            workspace_projects: &workspace_projects,
            projects: &known,
            commits: &commits,
        },
        days,
        from,
        to,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merges_overlapping_and_adjacent_intervals() {
        assert_eq!(merge_intervals(vec![]), vec![]);
        assert_eq!(
            merge_intervals(vec![(5, 10), (1, 3), (2, 4)]),
            vec![(1, 4), (5, 10)]
        );
        // Contigus : fusionnés ; inclus : absorbés ; vides ou inversés : ignorés.
        assert_eq!(
            merge_intervals(vec![(0, 10), (10, 20), (2, 5), (7, 7), (9, 3)]),
            vec![(0, 20)]
        );
        assert_eq!(
            merge_intervals(vec![(30, 40), (0, 10), (35, 50)]),
            vec![(0, 10), (30, 50)]
        );
        assert_eq!(
            total(&merge_intervals(vec![(0, 10), (5, 15), (20, 25)])),
            20
        );
    }

    #[test]
    fn clips_to_period() {
        assert_eq!(clip((0, 100), 50, 80), Some((50, 80)));
        assert_eq!(clip((0, 10), 20, 30), None);
        assert_eq!(clip((25, 40), 20, 30), Some((25, 30)));
    }

    #[test]
    fn day_split_preserves_total() {
        let list = merge_intervals(vec![
            (1_700_000_000, 1_700_000_000 + 3 * 86_400 + 1234),
            (1_700_500_000, 1_700_500_600),
        ]);
        let by_day = split_by_day(&list);
        assert!(by_day.len() >= 4);
        assert_eq!(by_day.values().sum::<i64>(), total(&list));
    }

    #[test]
    fn project_time_does_not_double_count() {
        let sessions = vec![
            SessionSpan {
                workspace_id: Some(1),
                name: "Front".into(),
                start: 100,
                end: 200,
            },
            SessionSpan {
                workspace_id: Some(2),
                name: "Full".into(),
                start: 150,
                end: 300,
            },
            SessionSpan {
                workspace_id: None,
                name: "Ancien".into(),
                start: 0,
                end: 50,
            },
        ];
        // Script du projet 10 pendant les sessions, et un autre hors session.
        let runs = vec![
            RunSpan {
                project_id: 10,
                start: 120,
                end: 180,
            },
            RunSpan {
                project_id: 10,
                start: 400,
                end: 450,
            },
            RunSpan {
                project_id: 99,
                start: 0,
                end: 1000,
            }, // projet inconnu : ignoré
        ];
        let wp: HashMap<i64, HashSet<i64>> =
            [(1, HashSet::from([10])), (2, HashSet::from([10, 11]))].into();
        let projects = vec![
            (10, "app".to_string()),
            (11, "api".to_string()),
            (12, "lib".to_string()),
        ];
        let commits: HashMap<i64, u32> = [(12, 3)].into();
        let stats = build(
            Inputs {
                sessions: &sessions,
                runs: &runs,
                workspace_projects: &wp,
                projects: &projects,
                commits: &commits,
            },
            7,
            0,
            1000,
        );

        // Projet 10 : [100,300[ ∪ [400,450[ = 250 s, malgré les chevauchements.
        assert_eq!(
            stats.projects[0],
            ProjectTime {
                id: 10,
                name: "app".into(),
                seconds: 250,
                sessions: 2,
                runs: 2,
                commits: 0
            }
        );
        assert_eq!(
            stats.projects[1],
            ProjectTime {
                id: 11,
                name: "api".into(),
                seconds: 150,
                sessions: 1,
                runs: 0,
                commits: 0
            }
        );
        assert_eq!(stats.projects[2].commits, 3);
        assert_eq!(stats.projects.len(), 3);

        assert_eq!(
            stats
                .workspaces
                .iter()
                .map(|w| (w.name.as_str(), w.seconds))
                .collect::<Vec<_>>(),
            vec![("Full", 150), ("Front", 100), ("Ancien", 50)]
        );
        // Total : [0,50[ ∪ [100,300[ ∪ [400,450[.
        assert_eq!(stats.total_seconds, 300);
        assert_eq!(stats.daily.iter().map(|d| d.seconds).sum::<i64>(), 300);

        // Période plus courte : tout est restreint.
        let short = build(
            Inputs {
                sessions: &sessions,
                runs: &runs,
                workspace_projects: &wp,
                projects: &projects,
                commits: &commits,
            },
            1,
            160,
            1000,
        );
        assert_eq!(short.projects[0].seconds, 140 + 50);
        assert_eq!(short.workspaces.len(), 2);
    }
}
