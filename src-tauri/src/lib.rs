mod commands;
mod database;
mod error;
mod modules;
mod state;
mod tray;

use tauri::{Listener, Manager, RunEvent, WindowEvent};

use database::Database;
use modules::settings::SettingsService;
use modules::system::SystemService;
use state::AppState;

/// Un plantage Rust (`panic`) est écrit dans le journal avant l'arrêt du processus.
fn install_panic_logging() {
    let default = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let location = info.location().map(|l| format!(" ({}:{})", l.file(), l.line())).unwrap_or_default();
        log::error!("PANIC{location} : {info}");
        default(info);
    }));
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Doit être enregistré en premier : une seconde instance réaffiche la fenêtre existante.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            tray::show_main_window(app);
        }))
        // Journal : `devcenter.log` dans le dossier des logs de l'app (3 fichiers de 2 Mo max).
        .plugin(
            tauri_plugin_log::Builder::new()
                .targets([
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir { file_name: Some("devcenter".into()) }),
                ])
                .level(log::LevelFilter::Info)
                .max_file_size(2_000_000)
                .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepSome(3))
                .timezone_strategy(tauri_plugin_log::TimezoneStrategy::UseLocal)
                .build(),
        )
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            install_panic_logging();
            log::info!("DevCenter {} démarré", app.package_info().version);
            let db_path = app.path().app_data_dir()?.join("devcenter.db");
            let db = Database::open(&db_path)?;
            let settings = SettingsService::new(&db)?;
            modules::workspaces::mark_interrupted(&db)?;
            modules::runner::mark_interrupted(&db)?;
            modules::automations::startup_cleanup(&db)?;
            app.manage(AppState {
                db,
                settings,
                system: SystemService::new()?,
                runner: Default::default(),
                workspaces: Default::default(),
                terminals: Default::default(),
                automations: Default::default(),
                remote: Default::default(),
                clones: Default::default(),
                github: Default::default(),
                git_watcher: Default::default(),
            });
            modules::automations::spawn_scheduler(app.handle().clone());

            // Statut Git en direct ; la liste suivie est réalignée à chaque changement de projets
            // (ajout, retrait, clonage, import depuis le téléphone).
            app.state::<AppState>().git_watcher.start(app.handle());
            let handle = app.handle().clone();
            app.listen_any(modules::projects::import::EVENT_CHANGED, move |_| {
                let state = handle.state::<AppState>();
                state.git_watcher.sync(&state.db);
            });

            // Accès à distance : redémarré au lancement s'il était activé (une erreur de port
            // n'empêche pas DevCenter de démarrer ; elle est affichée dans les paramètres).
            let state = app.state::<AppState>();
            let settings = SettingsService::load(&state.db)?;
            if settings.remote_enabled {
                let _ = state.remote.start(app.handle(), settings.remote_port);
            }

            tray::create(app.handle())?;
            Ok(())
        })
        .on_window_event(|window, event| {
            // Fermer la fenêtre principale = la cacher dans la barre système (si activé).
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    let close_to_tray = window
                        .app_handle()
                        .try_state::<AppState>()
                        .map(|s| s.settings.close_to_tray())
                        .unwrap_or(false);
                    if close_to_tray {
                        api.prevent_close();
                        let _ = window.hide();
                    } else {
                        window.app_handle().exit(0);
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_settings,
            commands::client_log,
            commands::update_check,
            commands::update_install,
            commands::app_version,
            commands::open_log_folder,
            commands::set_setting,
            commands::get_system_info,
            commands::get_system_snapshot,
            commands::open_disk,
            commands::get_hardware,
            commands::list_processes,
            commands::kill_process,
            commands::list_apps,
            commands::add_app,
            commands::remove_app,
            commands::launch_app,
            commands::list_projects,
            commands::add_projects,
            commands::remove_project,
            commands::rename_project,
            commands::project_details,
            commands::scan_projects,
            commands::open_in_editor,
            commands::open_project_folder,
            commands::open_project_terminal,
            commands::gradle_tasks,
            commands::detect_editor,
            commands::list_runs,
            commands::run_logs,
            commands::run_script,
            commands::stop_run,
            commands::dismiss_run,
            commands::list_workspaces,
            commands::save_workspace,
            commands::delete_workspace,
            commands::set_workspace_favorite,
            commands::start_workspace,
            commands::stop_workspace,
            commands::workspace_history,
            commands::list_servers,
            commands::save_server,
            commands::delete_server,
            commands::find_ssh_keys,
            commands::ping_server,
            commands::server_metrics,
            commands::server_services,
            commands::server_service_action,
            commands::server_service_logs,
            commands::server_containers,
            commands::server_container_action,
            commands::server_container_logs,
            commands::terminal_open,
            commands::terminal_write,
            commands::terminal_resize,
            commands::terminal_close,
            commands::server_key_status,
            commands::terminal_open_ssh_add,
            commands::list_automations,
            commands::save_automation,
            commands::delete_automation,
            commands::set_automation_enabled,
            commands::run_automation,
            commands::automation_history,
            commands::remote_status,
            commands::remote_configure,
            commands::remote_pairing_code,
            commands::remote_revoke,
            commands::export_config,
            commands::import_config,
            commands::tailscale_status,
            commands::tailscale_serve,
            commands::push_test,
            commands::github_status,
            commands::github_repos,
            commands::github_login_terminal,
            commands::clone_repo,
            commands::list_clone_jobs,
            commands::commit_activity,
            commands::ccusage_daily,
            commands::ccusage_day,
            commands::ccusage_total,
            commands::time_stats,
            commands::commits_on_day,
            commands::git_log,
            commands::git_commit,
            commands::git_branches,
            commands::git_checkout,
            commands::git_create_branch,
            commands::git_changes,
            commands::git_stage,
            commands::git_file_diff,
            commands::git_create_commit,
            commands::git_push,
        ])
        .build(tauri::generate_context!())
        .expect("erreur au lancement de DevCenter")
        .run(|app, event| {
            // Pas de processus orphelins : les scripts lancés depuis DevCenter s'arrêtent avec lui.
            if let RunEvent::Exit = event {
                if let Some(state) = app.try_state::<AppState>() {
                    modules::workspaces::close_all(&state);
                    state.terminals.close_all();
                    state.remote.stop();
                    state.runner.stop_all();
                    modules::runner::close_history(&state.db);
                }
            }
        });
}
