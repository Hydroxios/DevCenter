//! Planificateur : vérifie toutes les 15 s les workflows à déclencher.

use std::collections::HashMap;
use std::time::Duration;

use chrono::{Datelike, Local, TimeZone};
use tauri::{AppHandle, Manager};

use super::{Automation, Trigger, last_scheduled_start, list, now, parse_hhmm, trigger};
use crate::state::AppState;

const TICK: Duration = Duration::from_secs(15);

/// Prochain horaire dû pour un déclencheur « quotidien » : l'horaire d'aujourd'hui s'il est passé
/// et que le jour est sélectionné, sinon `None`.
fn daily_slot_today(time: &str, days: &[u8]) -> Option<i64> {
    let (h, m) = parse_hhmm(time)?;
    let now = Local::now();
    let weekday = now.weekday().num_days_from_monday() as u8;
    if !days.is_empty() && !days.contains(&weekday) {
        return None;
    }
    let slot = Local
        .with_ymd_and_hms(now.year(), now.month(), now.day(), h, m, 0)
        .single()?
        .timestamp();
    (now.timestamp() >= slot).then_some(slot)
}

/// Le workflow doit-il partir maintenant ? `last` = dernier démarrage planifié connu.
fn is_due(a: &Automation, last: Option<i64>, now_ts: i64) -> bool {
    match &a.trigger {
        Trigger::Interval { minutes } => last.is_none_or(|l| now_ts - l >= *minutes as i64 * 60),
        Trigger::Daily { time, days } => {
            // Fenêtre de rattrapage de 10 min : DevCenter ouvert juste après l'heure prévue.
            daily_slot_today(time, days)
                .is_some_and(|slot| now_ts - slot < 600 && last.is_none_or(|l| l < slot))
        }
        Trigger::Manual | Trigger::AppStart => false,
    }
}

pub fn spawn_scheduler(app: AppHandle) {
    std::thread::Builder::new()
        .name("automation-scheduler".into())
        .spawn(move || {
            // Workflows « au démarrage » : une fois, après une courte pause (fenêtre et état prêts).
            std::thread::sleep(Duration::from_secs(3));
            if let Ok(all) = list(
                &app.state::<AppState>().db,
                &app.state::<AppState>().automations,
            ) {
                for a in all
                    .iter()
                    .filter(|a| a.enabled && a.trigger == Trigger::AppStart)
                {
                    let _ = trigger(&app, a.id, "startup");
                }
            }

            // Cache des derniers démarrages planifiés (initialisé depuis l'historique).
            let mut last: HashMap<i64, Option<i64>> = HashMap::new();
            loop {
                let state = app.state::<AppState>();
                if let Ok(all) = list(&state.db, &state.automations) {
                    let ts = now();
                    for a in all.iter().filter(|a| a.enabled && !a.running) {
                        let known = *last.entry(a.id).or_insert_with(|| {
                            last_scheduled_start(&state.db, a.id).ok().flatten()
                        });
                        if is_due(a, known, ts) && trigger(&app, a.id, "schedule").is_ok() {
                            last.insert(a.id, Some(ts));
                        }
                    }
                    // Oublie les workflows supprimés.
                    last.retain(|id, _| all.iter().any(|a| a.id == *id));
                }
                std::thread::sleep(TICK);
            }
        })
        .expect("thread planificateur");
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::automations::OnError;
    use chrono::Timelike;

    fn auto(trigger: Trigger) -> Automation {
        Automation {
            id: 1,
            name: "t".into(),
            description: String::new(),
            enabled: true,
            trigger,
            steps: vec![],
            on_error: OnError::Stop,
            timeout_minutes: 5,
            running: false,
            last_run: None,
        }
    }

    #[test]
    fn interval_due() {
        let a = auto(Trigger::Interval { minutes: 10 });
        assert!(is_due(&a, None, 1_000));
        assert!(!is_due(&a, Some(1_000), 1_000 + 9 * 60));
        assert!(is_due(&a, Some(1_000), 1_000 + 10 * 60));
    }

    #[test]
    fn daily_due_once_per_slot() {
        let now = Local::now();
        // Créneau il y a 2 minutes (ou minuit si l'on est juste après minuit).
        let t = now - chrono::Duration::minutes(2);
        if t.day() != now.day() {
            return;
        }
        let time = format!("{:02}:{:02}", t.hour(), t.minute());
        let a = auto(Trigger::Daily { time, days: vec![] });
        let ts = now.timestamp();
        assert!(is_due(&a, None, ts));
        assert!(!is_due(&a, Some(ts - 30), ts)); // déjà lancé après le créneau
        // Jour non sélectionné.
        let other_day = (now.weekday().num_days_from_monday() as u8 + 1) % 7;
        let b = auto(Trigger::Daily {
            time: format!("{:02}:{:02}", t.hour(), t.minute()),
            days: vec![other_day],
        });
        assert!(!is_due(&b, None, ts));
    }
}
