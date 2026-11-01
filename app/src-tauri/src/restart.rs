//! Restarting a background session on the installed Claude Code: `claude respawn` keeps its id,
//! its conversation and its background shells (measured on a throwaway session), but would cut
//! a turn short, so it waits for the turn to end. Runs here, not in the UI, so it survives a
//! closed window.

use serde_json::Value;
use std::collections::HashSet;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

static WAITING: Mutex<Option<HashSet<String>>> = Mutex::new(None);

fn with<T>(f: impl FnOnce(&mut HashSet<String>) -> T) -> T {
    let mut guard = WAITING.lock().unwrap_or_else(|e| e.into_inner());
    f(guard.get_or_insert_with(HashSet::new))
}

fn tell(app: &AppHandle) {
    let _ = app.emit("openadmiral://restarts", agent_restarts());
}

pub fn any() -> bool {
    with(|w| !w.is_empty())
}

/// Nothing to cut short: the turn is over (a shell left running does not count), nobody is
/// waiting on an answer, and no subagent still works. `session` is its file, if it has one.
fn turn_over(row: &Value, session: Option<&Value>) -> bool {
    if row.get("state").and_then(Value::as_str) == Some("working") {
        return false;
    }
    let Some(s) = session else { return row.get("status").and_then(Value::as_str) != Some("busy") || row.get("state").and_then(Value::as_str) == Some("done") };
    let idle = matches!(s.get("status").and_then(Value::as_str), Some("idle" | "ended"));
    let subagents = s.get("subagents").and_then(Value::as_array).is_some_and(|l| l.iter().any(|a| a.get("status").and_then(Value::as_str) == Some("running")));
    idle && !subagents
}

/// The sessions waiting for their turn to end, to restart.
#[tauri::command]
pub fn agent_restarts() -> Vec<String> {
    with(|w| w.iter().cloned().collect())
}

#[tauri::command]
pub fn agent_restart(app: AppHandle, session_id: String) {
    with(|w| w.insert(session_id));
    tell(&app);
}

#[tauri::command]
pub fn agent_restart_cancel(app: AppHandle, session_id: String) {
    with(|w| w.remove(&session_id));
    tell(&app);
}

/// Called with every `claude agents --json` reading.
pub fn tick(app: &AppHandle, agents: &Value) {
    for id in agent_restarts() {
        let Some(row) = crate::agent_row(agents, &id) else {
            // Closed meanwhile: nothing to restart.
            with(|w| w.remove(&id));
            tell(app);
            continue;
        };
        let session = crate::scheduler::read_json(&crate::admiral_dir().join("sessions").join(format!("{id}.json")));
        if turn_over(&row, session.as_ref()) {
            with(|w| w.remove(&id));
            tell(app);
            let app = app.clone();
            std::thread::spawn(move || respawn(app, id, row));
        }
    }
}

fn respawn(app: AppHandle, id: String, row: Value) {
    let job = row.get("id").and_then(Value::as_str).unwrap_or(&id[..id.len().min(8)]).to_string();
    let mut cmd = crate::claude_cmd();
    cmd.args(["respawn", &job]);
    let result = crate::run_cli_within(cmd, Duration::from_secs(60));
    // One answer, in the window that shows it: its own if it floats, else the main one.
    let floating = format!("{}{id}", crate::float::PREFIX);
    let target = if app.get_webview_window(&floating).is_some() { floating.as_str() } else { "main" };
    let _ = app.emit_to(target, "openadmiral://restart-done", serde_json::json!({ "sessionId": id, "error": result.err() }));
}

static INSTALLED: Mutex<Option<(Instant, Option<String>)>> = Mutex::new(None);
/// It changes only when Claude Code updates itself.
const VERSION_FRESH: Duration = Duration::from_secs(300);

/// "2.1.316 (Claude Code)" → "2.1.316".
fn version_in(output: &str) -> Option<String> {
    output.split_whitespace().next().filter(|v| v.chars().next().is_some_and(|c| c.is_ascii_digit())).map(str::to_owned)
}

/// The Claude Code a session restarted now would run.
#[tauri::command]
pub async fn claude_installed_version() -> Option<String> {
    if let Some((at, v)) = INSTALLED.lock().ok()?.as_ref() {
        if at.elapsed() < VERSION_FRESH {
            return v.clone();
        }
    }
    let out = crate::claude_cmd().arg("--version").output().ok()?;
    let v = version_in(&String::from_utf8_lossy(&out.stdout));
    *INSTALLED.lock().ok()? = Some((Instant::now(), v.clone()));
    v
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_shell_left_running_does_not_hold_it_back() {
        let done = json!({ "status": "busy", "state": "done" });
        assert!(turn_over(&done, Some(&json!({ "status": "idle" }))));
        assert!(turn_over(&done, None));
    }

    #[test]
    fn a_turn_a_question_or_a_subagent_does() {
        assert!(!turn_over(&json!({ "status": "busy", "state": "working" }), Some(&json!({ "status": "idle" }))));
        let row = json!({ "status": "idle", "state": "blocked" });
        assert!(!turn_over(&row, Some(&json!({ "status": "waiting" }))));
        assert!(!turn_over(&row, Some(&json!({ "status": "idle", "subagents": [{ "status": "running" }] }))));
        assert!(turn_over(&row, Some(&json!({ "status": "idle", "subagents": [{ "status": "done" }] }))));
    }

    #[test]
    fn reads_the_version() {
        assert_eq!(version_in("2.1.316 (Claude Code)\n").as_deref(), Some("2.1.316"));
        assert_eq!(version_in("error: nope"), None);
    }
}
