//! Auto-update: the app checks openadmiral.com/updates/latest.json (tauri.conf.json
//! `plugins.updater`) shortly after launch and every 6 h, and on "Check for Updates…".
//! A newer version is offered in the UI (`openadmiral://update`); installing it is
//! the person's choice (`update_install`), then the app restarts into it.

use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_updater::{Update, UpdaterExt};

const FIRST_CHECK: Duration = Duration::from_secs(20);
const EVERY: Duration = Duration::from_secs(6 * 3600);

/// The update found by the last check, kept for `update_install`.
#[derive(Default)]
pub struct Pending(Mutex<Option<Update>>);

#[derive(serde::Serialize, Clone)]
struct Offer {
    version: String,
    notes: Option<String>,
}

pub fn start(app: AppHandle) {
    if crate::preview() {
        return;
    }
    std::thread::spawn(move || {
        std::thread::sleep(FIRST_CHECK);
        loop {
            let _ = tauri::async_runtime::block_on(check(&app, false));
            std::thread::sleep(EVERY);
        }
    });
}

/// Looks for a newer version and offers it. `manual` (the menu item) also says when
/// there is none, or why the check failed.
pub async fn check(app: &AppHandle, manual: bool) -> Result<(), String> {
    let found = app.updater().map_err(|e| e.to_string())?.check().await.map_err(|e| e.to_string());
    match found {
        Ok(Some(update)) => {
            let offer = Offer { version: update.version.clone(), notes: update.body.clone() };
            *app.state::<Pending>().0.lock().unwrap() = Some(update);
            let _ = app.emit("openadmiral://update", offer);
        }
        Ok(None) if manual => {
            let _ = app.emit("openadmiral://update-none", app.package_info().version.to_string());
        }
        Err(e) if manual => {
            let _ = app.emit("openadmiral://update-error", e.clone());
            return Err(e);
        }
        _ => {}
    }
    Ok(())
}

#[tauri::command]
pub async fn update_check(app: AppHandle) -> Result<(), String> {
    check(&app, true).await
}

/// Downloads and installs the offered version, then restarts into it.
#[tauri::command]
pub async fn update_install(app: AppHandle, pending: State<'_, Pending>) -> Result<(), String> {
    let update = pending.0.lock().unwrap().take().ok_or("No update to install.")?;
    update.download_and_install(|_, _| {}, || {}).await.map_err(|e| e.to_string())?;
    app.restart();
}
