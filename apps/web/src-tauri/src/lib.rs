mod analytics_commands;
mod backup;
mod db;
mod db_key;
mod keychain;
mod path_safety;

use db::DbState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // BUG-30: writes to stdout and a rotating file in the OS app-log dir
        // (`%LOCALAPPDATA%\com.kanegrowth.app\logs` / `~/Library/Logs/com.kanegrowth.app` /
        // `~/.local/share/com.kanegrowth.app/logs`), so an opaque local-store failure on a user's
        // machine leaves a readable trail. Only Rust-side `log::*` records reach that file — the
        // WebView console is NOT forwarded to disk (P10), and must not be: axios errors there
        // carry `Authorization` headers. `attachConsole()` on the JS side goes the other way,
        // surfacing these Rust records in the WebView devtools console.
        .plugin(
            tauri_plugin_log::Builder::new()
                .target(tauri_plugin_log::Target::new(
                    tauri_plugin_log::TargetKind::Stdout,
                ))
                .target(tauri_plugin_log::Target::new(
                    tauri_plugin_log::TargetKind::LogDir {
                        file_name: Some("kanegrowth".into()),
                    },
                ))
                .level(log::LevelFilter::Info)
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        // BUG-27: opens external URLs in the user's default browser (external `<a>` clicks
        // otherwise silently no-op inside the webview).
        .plugin(tauri_plugin_opener::init())
        .manage(DbState::default())
        .invoke_handler(tauri::generate_handler![
            db::db_open,
            db::db_exec,
            db::db_select,
            db::db_set_key,
            db::db_reset_file,
            db::db_close,
            backup::save_file,
            backup::open_backup_file,
            keychain::keychain_set,
            keychain::keychain_get,
            keychain::keychain_delete,
            keychain::offline_grant_set,
            keychain::offline_grant_get,
            keychain::offline_grant_delete,
            analytics_commands::analytics_get_cash_flow_sankey,
            analytics_commands::analytics_get_category_trends,
            analytics_commands::analytics_get_net_worth_projection,
            analytics_commands::analytics_list_drilldown_transactions,
            analytics_commands::analytics_list_saved_views,
            analytics_commands::analytics_save_view,
            analytics_commands::analytics_delete_view,
        ])
        .run(tauri::generate_context!())
        .expect("error while running the KaneGrowth desktop application");
}
