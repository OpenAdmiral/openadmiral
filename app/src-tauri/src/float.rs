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

/// Grid window label → the sessions its panes show.
static GRIDS: Mutex<Option<HashMap<String, Vec<String>>>> = Mutex::new(None);

fn with_grids<T>(f: impl FnOnce(&mut HashMap<String, Vec<String>>) -> T) -> T {
    let mut guard = GRIDS.lock().unwrap_or_else(|e| e.into_inner());
    f(guard.get_or_insert_with(HashMap::new))
}

/// The window showing a session: its own floating window, or a grid window with it in a pane.
fn holder(session_id: &str) -> Option<String> {
    with(|m| m.iter().find(|(_, v)| v.as_str() == session_id).map(|(k, _)| k.clone()))
        .or_else(|| with_grids(|g| g.iter().find(|(_, v)| v.iter().any(|s| s == session_id)).map(|(k, _)| k.clone())))
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
    with_grids(|g| g.remove(label));
    if with(|m| m.remove(label)).is_some() {
        tell(app);
        crate::windows::changed(app);
    }
}

/// The sessions in floating windows, their own or a grid window's panes.
#[tauri::command]
pub fn floats() -> Vec<String> {
    let mut out: Vec<String> = with(|m| m.values().filter(|v| !v.starts_with("grid-")).cloned().collect());
    with_grids(|g| out.extend(g.values().flatten().cloned()));
    out
}

/// Window label and session of every floating window.
pub fn open_windows() -> Vec<(String, String)> {
    with(|m| m.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
}

/// A window for ⌘K's Windows row: the main one, then each floating one.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowInfo {
    pub label: String,
    /// The agent's session, or "view-<name>" for a floating view; none for the main window.
    pub id: Option<String>,
    pub focused: bool,
    pub title: Option<String>,
    /// A grid window's agents, in pane order.
    pub sessions: Vec<String>,
}

#[tauri::command]
pub fn window_list(app: AppHandle) -> Vec<WindowInfo> {
    let focused = |label: &str| app.get_webview_window(label).and_then(|w| w.is_focused().ok()).unwrap_or(false);
    let title = |label: &str| app.get_webview_window(label).and_then(|w| w.title().ok());
    let mut out = vec![WindowInfo { label: "main".into(), id: None, focused: focused("main"), title: None, sessions: vec![] }];
    let mut floats = open_windows();
    floats.sort();
    out.extend(floats.into_iter().map(|(label, id)| WindowInfo {
        focused: focused(&label),
        title: title(&label),
        sessions: with_grids(|g| g.get(&label).cloned()).unwrap_or_default(),
        label,
        id: Some(id),
    }));
    out
}

/// Brings a window forward, to its desktop.
#[tauri::command]
pub fn window_focus(app: AppHandle, label: String) -> Result<(), String> {
    if label == "main" {
        crate::show_main(&app);
        return Ok(());
    }
    let w = app.get_webview_window(&label).ok_or("That window is closed.")?;
    let _ = w.show();
    let _ = w.unminimize();
    w.set_focus().map_err(|e| e.to_string())
}

/// ⌘K in a floating window picked something the main window shows: bring it forward with it.
#[tauri::command]
pub fn palette_pick(app: AppHandle, target: serde_json::Value) {
    crate::show_main(&app);
    let _ = app.emit_to("main", "openadmiral://palette-pick", target);
}

/// Opens the agent's window, or brings it forward (to its desktop) if it has one.
#[tauri::command]
pub fn float_open(app: AppHandle, session_id: String, title: String) -> Result<(), String> {
    open(&app, &session_id, &title, None)
}

/// `frame`: where it was, when it comes back at start.
pub fn open(app: &AppHandle, session_id: &str, title: &str, frame: Option<&crate::windows::Frame>) -> Result<(), String> {
    if let Some(label) = holder(session_id) {
        if let Some(w) = app.get_webview_window(&label) {
            let _ = w.show();
            let _ = w.unminimize();
            return w.set_focus().map_err(|e| e.to_string());
        }
    }
    let label = label_of(session_id)?;
    let mut builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html".into()))
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
    let window = builder.build().map_err(|e| e.to_string())?;
    if let Some(f) = frame {
        crate::windows::apply(&window, f);
    }
    with(|m| m.insert(label, session_id.to_string()));
    tell(app);
    crate::windows::changed(app);
    Ok(())
}

/// The agent got a new session id (`/clear`): the window goes on showing it.
#[tauri::command]
pub fn float_track(window: Window, session_id: String) {
    with(|m| m.insert(window.label().to_string(), session_id));
    tell(window.app_handle());
    crate::windows::changed(window.app_handle());
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
    let label = holder(session_id);
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
    let label = holder(&session_id);
    // In a grid window: only its pane lets it go; the window stays.
    if let Some(l) = label.as_ref().filter(|l| with_grids(|g| g.contains_key(*l))) {
        let _ = app.emit_to(l.as_str(), "openadmiral://grid-release", &session_id);
        return Ok(());
    }
    match label.and_then(|l| app.get_webview_window(&l)) {
        Some(w) => w.close().map_err(|e| e.to_string()),
        None => Ok(()),
    }
}

/// An agent's own window takes a grid layout: it becomes a grid window in place, its
/// agent in the first pane. Answers the grid's id.
#[tauri::command]
pub fn float_to_grid(app: AppHandle, window: Window, layout: String) -> Result<String, String> {
    let label = window.label().to_string();
    let session = with(|m| m.get(&label).cloned()).ok_or("Not an agent's window.")?;
    let n = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    let id = format!("grid-{n:x}");
    grid_state_save(app.clone(), id.clone(), serde_json::json!({ "layout": layout, "panes": [session.clone()], "active": 0 }));
    with(|m| m.insert(label.clone(), id.clone()));
    with_grids(|g| g.insert(label, vec![session]));
    tell(&app);
    crate::windows::changed(&app);
    Ok(id)
}

/// A window with a grid of its own (components/FloatingGrid.tsx): `sessions` start in its
/// panes, laid out to fit them. Answers its id.
#[tauri::command]
pub fn grid_new(app: AppHandle, sessions: Vec<String>) -> Result<String, String> {
    let n = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    let id = format!("grid-{n:x}");
    let layout = match sessions.len() {
        0..=2 => "2v",
        3 => "3v",
        4 => "4",
        5 => "c122",
        _ => "c222",
    };
    let panes: Vec<serde_json::Value> = sessions.iter().take(6).map(|s| serde_json::Value::String(s.clone())).collect();
    grid_state_save(app.clone(), id.clone(), serde_json::json!({ "layout": layout, "panes": panes, "active": 0 }));
    open(&app, &id, "OpenAdmiral", None)?;
    Ok(id)
}

/// A grid window's panes changed: it now shows these sessions. Any other window showing
/// one of them lets it go (an agent's terminal lives in one window at a time).
#[tauri::command]
pub fn grid_track(window: Window, sessions: Vec<String>) {
    let app = window.app_handle();
    let me = window.label().to_string();
    for s in &sessions {
        match holder(s) {
            Some(other) if other != me => {
                if with_grids(|g| g.contains_key(&other)) {
                    let _ = app.emit_to(other.as_str(), "openadmiral://grid-release", s);
                    with_grids(|g| g.get_mut(&other).map(|v| v.retain(|x| x != s)));
                } else if let Some(w) = app.get_webview_window(&other) {
                    let _ = w.close();
                }
            }
            _ => {}
        }
    }
    with_grids(|g| g.insert(me, sessions));
    tell(app);
}

fn grids_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    crate::app_data_dir(app).map(|d| d.join("grids.json"))
}

fn grids_read(app: &AppHandle) -> serde_json::Map<String, serde_json::Value> {
    grids_path(app).and_then(|p| std::fs::read_to_string(p).ok()).and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

/// A grid window's layout, panes and dividers, as it left them.
#[tauri::command]
pub fn grid_state_load(app: AppHandle, id: String) -> serde_json::Value {
    grids_read(&app).remove(&id).unwrap_or(serde_json::Value::Null)
}

#[tauri::command]
pub fn grid_state_save(app: AppHandle, id: String, state: serde_json::Value) {
    if crate::preview() {
        return;
    }
    let Some(path) = grids_path(&app) else { return };
    let mut all = grids_read(&app);
    all.insert(id, state);
    let _ = std::fs::create_dir_all(path.parent().unwrap());
    let tmp = path.with_extension("json.tmp");
    if std::fs::write(&tmp, serde_json::Value::Object(all).to_string()).is_ok() {
        let _ = std::fs::rename(tmp, path);
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
