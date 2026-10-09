//! Closing, force-quitting and removing sessions. Every `claude` here runs through
//! `claude_cmd()`, without a parent session's variables.

use serde_json::Value;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::AppHandle;

fn short(session_id: &str) -> &str {
    &session_id[..session_id.len().min(8)]
}

/// The job id `claude stop` / `claude rm` take. It is the FIRST session id's
/// prefix and survives /clear, which gives the session a new id; so read it
/// from the CLI's row, and fall back to the prefix only when there is none.
fn job_id(row: Option<&Value>, session_id: &str) -> String {
    row.and_then(|r| r.get("id")).and_then(Value::as_str).map(str::to_owned).unwrap_or_else(|| short(session_id).to_owned())
}

/// The CLI's own row for a session: its pid and kind come from here, never from the UI.
fn row(session_id: &str) -> Option<Value> {
    crate::claude_agents()?
        .as_array()?
        .iter()
        .find(|a| a.get("sessionId").and_then(Value::as_str) == Some(session_id))
        .cloned()
}

fn request_exit(session_id: &str) -> Result<(), String> {
    let path = crate::admiral_dir().join("requests").join(format!("{session_id}.json"));
    std::fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
    let at = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    std::fs::write(path, serde_json::json!({ "action": "exit", "at": at }).to_string()).map_err(|e| e.to_string())
}

/// Close, keeping the conversation: a background session is stopped; an
/// interactive one is asked (through the mod) to exit once its turn ends.
/// Answers `"stopped"` or `"requested"`.
#[tauri::command]
pub async fn agent_close(app: AppHandle, session_id: String) -> Result<String, String> {
    let Some(r) = row(&session_id) else { return Err("That session is not running.".into()) };
    if r.get("kind").and_then(Value::as_str) == Some("interactive") {
        request_exit(&session_id)?;
        return Ok("requested".into());
    }
    // Detach first, so the attach client does not report the stop as an error.
    crate::pty::close(&app, &session_id);
    let mut cmd = crate::claude_cmd();
    cmd.args(["stop", &job_id(Some(&r), &session_id)]);
    crate::run_cli(cmd).map(|_| "stopped".into())
}

/// For a session stuck mid-turn: SIGTERM, then SIGKILL if it is still listed after ~5 s.
#[tauri::command]
pub async fn agent_force_quit(app: AppHandle, session_id: String) -> Result<String, String> {
    let Some(r) = row(&session_id) else { return Err("That session is not running.".into()) };
    let pid = r.get("pid").and_then(Value::as_i64).ok_or("claude did not report its pid")?;
    crate::pty::close(&app, &session_id);
    let signal = |sig: &str| std::process::Command::new("kill").args([sig, &pid.to_string()]).status();
    signal("-TERM").map_err(|e| e.to_string())?;
    let start = Instant::now();
    while start.elapsed() < Duration::from_secs(5) {
        std::thread::sleep(Duration::from_millis(500));
        if row(&session_id).is_none() {
            return Ok("terminated".into());
        }
    }
    signal("-KILL").map_err(|e| e.to_string())?;
    Ok("killed".into())
}

/// Drops a session that is not running from OpenAdmiral: `claude rm` for a background
/// job, and its files under ~/.claude/openadmiral. The conversation stays resumable.
#[tauri::command]
pub async fn agent_remove(app: AppHandle, session_id: String) -> Result<Vec<String>, String> {
    if row(&session_id).is_some() || crate::claude_agents().is_some_and(|live| crate::jobs::is_running(&live, &session_id)) {
        return Err("Close the session before removing it.".into());
    }
    crate::pty::close(&app, &session_id);
    // Every id the session had (/clear changes it); the job is listed under the first one.
    let chain = crate::jobs::chain_of(&session_id);
    // Not every session is a background job; for one that is not, rm has nothing to do.
    let job = crate::claude_agents_all().and_then(|all| crate::jobs::find(&all, &chain));
    let mut cmd = crate::claude_cmd();
    cmd.args(["rm", &job.map_or_else(|| job_id(None, &session_id), |j| j.id)]);
    let _ = crate::run_cli(cmd);
    // Answers what it deleted, so the UI can say so.
    let dir = crate::admiral_dir();
    let mut removed = vec![];
    for id in &chain {
        for sub in ["sessions", "requests"] {
            let path = dir.join(sub).join(format!("{id}.json"));
            if std::fs::remove_file(&path).is_ok() {
                removed.push(path.display().to_string());
            }
        }
    }
    Ok(removed)
}
