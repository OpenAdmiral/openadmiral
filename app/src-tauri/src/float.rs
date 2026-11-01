//! An agent in a window of its own, to carry to another desktop. The window loads the same
//! app, told which agent to show; its terminal joins the agent's running `claude attach`
//! (ptys are keyed by session), and the main window stays off that terminal meanwhile.

use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, TitleBarStyle, WebviewUrl, WebviewWindowBuilder, Window};

/// Window label → the session it shows.
static FLOATS: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);

fn with<T>(f: impl FnOnce(&mut HashMap<String, String>) -> T) -> T {
    let mut guard = FLOATS.lock().unwrap_or_else(|e| e.into_inner());
    f(guard.get_or_insert_with(HashMap::new))
}

pub const PREFIX: &str = "float-";

/// Labels take letters, digits and dashes; session ids are UUIDs.
fn label_of(id: &str) -> Result<String, String> {
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err("not a session id".into());
    }
    Ok(format!("{PREFIX}{id}"))
}

fn tell(app: &AppHandle) {
    let _ = app.emit("openadmiral://floats", floats());
}

pub fn any() -> bool {
    with(|m| !m.is_empty())
}

/// A floating window closed.
pub fn closed(app: &AppHandle, label: &str) {
    if with(|m| m.remove(label)).is_some() {
        tell(app);
    }
}

/// The sessions in floating windows.
#[tauri::command]
pub fn floats() -> Vec<String> {
    with(|m| m.values().cloned().collect())
}

/// Opens the agent's window, or brings it forward (to its desktop) if it has one.
#[tauri::command]
pub fn float_open(app: AppHandle, session_id: String, title: String) -> Result<(), String> {
    if let Some(label) = with(|m| m.iter().find(|(_, v)| **v == session_id).map(|(k, _)| k.clone())) {
        if let Some(w) = app.get_webview_window(&label) {
            let _ = w.show();
            let _ = w.unminimize();
            return w.set_focus().map_err(|e| e.to_string());
        }
    }
    let label = label_of(&session_id)?;
    let mut builder = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App("index.html".into()))
        // Checked by label_of: only letters, digits and dashes.
        .initialization_script(format!("window.__OPENADMIRAL_FLOAT__ = '{session_id}';"))
        .title(title)
        .inner_size(900.0, 680.0)
        .min_inner_size(420.0, 320.0)
        // On another desktop it is rarely the active window: the first click must already drag it.
        .accept_first_mouse(true);
    #[cfg(target_os = "macos")]
    {
        builder = builder.title_bar_style(TitleBarStyle::Overlay).hidden_title(true).traffic_light_position(tauri::LogicalPosition::new(14.0, 19.0));
    }
    builder.build().map_err(|e| e.to_string())?;
    with(|m| m.insert(label, session_id));
    tell(&app);
    Ok(())
}

/// The agent got a new session id (`/clear`): the window goes on showing it.
#[tauri::command]
pub fn float_track(window: Window, session_id: String) {
    with(|m| m.insert(window.label().to_string(), session_id));
    tell(window.app_handle());
}

/// Back to the main window: this one closes, and the main one shows the agent.
#[tauri::command]
pub fn float_dock(window: Window) -> Result<(), String> {
    let app = window.app_handle();
    let id = with(|m| m.get(window.label()).cloned());
    crate::show_main(app);
    if let Some(id) = id {
        let _ = app.emit_to("main", "openadmiral://float-docked", id);
    }
    window.close().map_err(|e| e.to_string())
}

/// ⌘W in a floating window: closes it; the agent goes on.
#[tauri::command]
pub fn float_close(window: Window) -> Result<(), String> {
    window.close().map_err(|e| e.to_string())
}

/// Brings forward the floating window showing this session and hands it `focus` (an artifact
/// to open). False when no window shows it: the main window is the one to ask.
pub fn focus(app: &AppHandle, session_id: &str, focus: &serde_json::Value) -> bool {
    let label = with(|m| m.iter().find(|(_, v)| *v == session_id).map(|(k, _)| k.clone()));
    let Some(w) = label.as_ref().and_then(|l| app.get_webview_window(l)) else { return false };
    let _ = w.show();
    let _ = w.unminimize();
    let _ = w.set_focus();
    app.emit_to(label.unwrap().as_str(), "openadmiral://focus", focus).is_ok()
}

/// From the main window: an artifact of an agent that lives in a floating window.
#[tauri::command]
pub fn float_focus(app: AppHandle, session_id: String, focus: serde_json::Value) -> bool {
    self::focus(&app, &session_id, &focus)
}

/// From a floating view: the main window comes forward showing this agent.
#[tauri::command]
pub fn float_jump(app: AppHandle, session_id: String) {
    crate::show_main(&app);
    let _ = app.emit_to("main", "openadmiral://float-docked", session_id);
}

/// From the main window: closes the agent's floating window.
#[tauri::command]
pub fn float_recall(app: AppHandle, session_id: String) -> Result<(), String> {
    let label = with(|m| m.iter().find(|(_, v)| **v == session_id).map(|(k, _)| k.clone()));
    match label.and_then(|l| app.get_webview_window(&l)) {
        Some(w) => w.close().map_err(|e| e.to_string()),
        None => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn labels_only_from_session_ids() {
        assert_eq!(super::label_of("c005dcf5-5a89").unwrap(), "float-c005dcf5-5a89");
        assert!(super::label_of("x'; alert(1); '").is_err());
        assert!(super::label_of("").is_err());
    }
}
