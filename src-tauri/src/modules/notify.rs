//! Point d'envoi unique des notifications : chaque événement (échec d'automatisation, script
//! planté, workspace avec erreurs, étape « Notifier »…) part vers la notification Windows et/ou
//! les téléphones abonnés (push), selon les préférences de l'utilisateur.
//!
//! Les toasts Windows portent les boutons « Relancer » et « Voir les logs » : un clic sur la
//! notification ou sur « Voir les logs » ramène DevCenter au premier plan et ouvre l'élément
//! concerné (événement `notification://open` côté interface) ; « Relancer » relance directement.
//! Windows ne signale ces clics que tant que le toast est à l'écran (pas depuis le centre de
//! notifications).

use std::collections::VecDeque;
use std::sync::atomic::{AtomicI32, Ordering};
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_notification::{Action, ActionPerformed, ActionType, NotificationExt};

use crate::modules::push;
use crate::modules::settings::SettingsService;
use crate::state::AppState;

/// Événement reçu par l'interface : naviguer vers l'élément concerné.
pub const EVENT_OPEN: &str = "notification://open";

const ACTIONS_RETRY: &str = "devcenter-retry";
const ACTIONS_LOGS: &str = "devcenter-logs";
const ACTION_RETRY: &str = "retry";
const ACTION_LOGS: &str = "logs";

/// Nombre de notifications dont on garde la cible en mémoire (pour les clics).
const KEEP: usize = 50;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Category {
    /// Une automatisation a échoué ou dépassé son délai.
    Automation,
    /// Un script s'est arrêté avec une erreur (sans avoir été arrêté par l'utilisateur).
    Script,
    /// Un workspace a démarré avec des étapes en échec.
    Workspace,
    /// Étape « Notifier » d'une automatisation.
    Step,
    /// Clonage d'un dépôt terminé ou échoué (téléphone uniquement, non configurable).
    Clone,
}

/// Canaux d'une catégorie.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Channels {
    pub desktop: bool,
    pub mobile: bool,
}

impl Default for Channels {
    fn default() -> Self {
        Self {
            desktop: true,
            mobile: true,
        }
    }
}

/// Préférences de notification (clé `notifications` des paramètres).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct NotificationPrefs {
    pub automation: Channels,
    pub script: Channels,
    pub workspace: Channels,
    pub step: Channels,
    /// Pas de notification Windows quand la fenêtre DevCenter est au premier plan.
    pub skip_when_focused: bool,
}

impl Default for NotificationPrefs {
    fn default() -> Self {
        Self {
            automation: Channels::default(),
            script: Channels::default(),
            workspace: Channels::default(),
            step: Channels::default(),
            skip_when_focused: true,
        }
    }
}

impl NotificationPrefs {
    fn channels(&self, category: Category) -> Channels {
        match category {
            Category::Automation => self.automation,
            Category::Script => self.script,
            Category::Workspace => self.workspace,
            Category::Step => self.step,
            Category::Clone => Channels {
                desktop: false,
                mobile: true,
            },
        }
    }
}

/// Élément ouvert au clic sur la notification.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Target {
    /// Logs d'une exécution de script d'un projet.
    #[serde(rename_all = "camelCase")]
    Run { project_id: i64, run_id: u64 },
    /// Exécution d'une automatisation (historique).
    #[serde(rename_all = "camelCase")]
    Automation {
        automation_id: i64,
        run_id: Option<i64>,
    },
    /// Workspace (résultats de la dernière session).
    #[serde(rename_all = "camelCase")]
    Workspace { workspace_id: i64 },
    /// Liste des projets.
    Projects,
}

/// Action du bouton « Relancer ».
#[derive(Debug, Clone)]
pub enum Retry {
    Script { project_id: i64, script: String },
    Automation { id: i64 },
    Workspace { id: i64 },
}

#[derive(Debug, Clone)]
pub struct Event {
    pub category: Category,
    pub title: String,
    pub body: String,
    /// Onglet de la page mobile ouvert au toucher (home, scripts, auto…).
    pub tab: Option<String>,
    /// Regroupe les notifications push d'un même sujet.
    pub tag: Option<String>,
    pub target: Option<Target>,
    pub retry: Option<Retry>,
}

#[derive(Default)]
struct Registry {
    /// Cibles des derniers toasts affichés, par identifiant de notification.
    shown: Mutex<VecDeque<(i32, Event)>>,
}

fn registry() -> &'static Registry {
    static REGISTRY: OnceLock<Registry> = OnceLock::new();
    REGISTRY.get_or_init(Registry::default)
}

fn next_id() -> i32 {
    static NEXT: AtomicI32 = AtomicI32::new(1);
    NEXT.fetch_add(1, Ordering::Relaxed)
}

/// À appeler au démarrage : boutons des toasts et réception des clics.
pub fn init(app: &AppHandle) {
    let notification = app.notification();
    let _ = notification.register_action_types(vec![
        ActionType::builder(ACTIONS_RETRY)
            .actions(vec![
                Action::builder(ACTION_RETRY, "Relancer").build(),
                Action::builder(ACTION_LOGS, "Voir les logs").build(),
            ])
            .build(),
        ActionType::builder(ACTIONS_LOGS)
            .actions(vec![Action::builder(ACTION_LOGS, "Voir les logs").build()])
            .build(),
    ]);
    let handle = app.clone();
    let _ =
        notification.on_action(move |performed: &ActionPerformed| on_action(&handle, performed));
}

fn on_action(app: &AppHandle, performed: &ActionPerformed) {
    let Some(id) = performed.notification().map(|n| n.id()) else {
        return;
    };
    let event = registry()
        .shown
        .lock()
        .ok()
        .and_then(|s| s.iter().find(|(i, _)| *i == id).map(|(_, e)| e.clone()));
    let Some(event) = event else {
        crate::tray::show_main_window(app);
        return;
    };
    match performed.action_id() {
        ACTION_RETRY => {
            if let Some(retry) = event.retry.clone() {
                let app = app.clone();
                // Hors du fil de la notification : relancer peut prendre un moment.
                std::thread::spawn(move || {
                    if let Err(e) = run_retry(&app, &retry) {
                        log::warn!("relance depuis la notification impossible : {e}");
                        show_desktop(
                            &app,
                            &Event {
                                category: event.category,
                                title: "Relance impossible".into(),
                                body: e.to_string(),
                                tab: None,
                                tag: None,
                                target: event.target.clone(),
                                retry: None,
                            },
                        );
                    }
                });
            }
        }
        // `tap` (clic sur le toast) ou « Voir les logs ».
        _ => open_target(app, event.target.as_ref()),
    }
}

fn run_retry(app: &AppHandle, retry: &Retry) -> crate::error::AppResult<()> {
    let state = app.state::<AppState>();
    match retry {
        Retry::Script { project_id, script } => {
            crate::modules::projects::run_script(app, *project_id, script)?;
        }
        Retry::Automation { id } => {
            crate::modules::automations::trigger(app, *id, "manual")?;
        }
        Retry::Workspace { id } => {
            // Un workspace partiellement démarré reste actif : on l'arrête avant de relancer
            // (erreur ignorée s'il ne tourne déjà plus).
            let _ = crate::modules::workspaces::stop(app, &state, *id);
            crate::modules::workspaces::start(app, &state, *id)?;
        }
    }
    Ok(())
}

/// Ramène DevCenter au premier plan et demande à l'interface d'ouvrir l'élément.
fn open_target(app: &AppHandle, target: Option<&Target>) {
    crate::tray::show_main_window(app);
    if let Some(target) = target {
        let _ = app.emit(EVENT_OPEN, target);
    }
}

fn main_window_in_front(app: &AppHandle) -> bool {
    app.get_webview_window("main").is_some_and(|w| {
        w.is_visible().unwrap_or(false)
            && !w.is_minimized().unwrap_or(false)
            && w.is_focused().unwrap_or(false)
    })
}

fn show_desktop(app: &AppHandle, event: &Event) {
    let id = next_id();
    let mut builder = app
        .notification()
        .builder()
        .id(id)
        .title(&event.title)
        .body(&event.body);
    if event.target.is_some() {
        builder = builder.action_type_id(if event.retry.is_some() {
            ACTIONS_RETRY
        } else {
            ACTIONS_LOGS
        });
    }
    if let Ok(mut shown) = registry().shown.lock() {
        shown.push_back((id, event.clone()));
        while shown.len() > KEEP {
            shown.pop_front();
        }
    }
    if let Err(e) = builder.show() {
        log::warn!("notification Windows impossible : {e}");
    }
}

/// Envoie l'événement sur les canaux activés pour sa catégorie. Ne bloque pas.
pub fn dispatch(app: &AppHandle, event: Event) {
    let prefs = app
        .try_state::<AppState>()
        .and_then(|s| SettingsService::load(&s.db).ok())
        .map(|s| s.notifications)
        .unwrap_or_default();
    let channels = prefs.channels(event.category);
    if channels.desktop && !(prefs.skip_when_focused && main_window_in_front(app)) {
        show_desktop(app, &event);
    }
    if channels.mobile {
        push::notify_all(
            app,
            push::Notification {
                title: event.title,
                body: event.body,
                tab: event.tab,
                tag: event.tag,
            },
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefs_fill_missing_fields() {
        let p: NotificationPrefs =
            serde_json::from_str(r#"{"script":{"desktop":false,"mobile":true}}"#).unwrap();
        assert!(!p.script.desktop);
        assert!(p.automation.desktop && p.skip_when_focused);
        assert!(!p.channels(Category::Clone).desktop);
    }
}
