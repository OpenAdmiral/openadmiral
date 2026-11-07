//! Codex agents. Codex has no background jobs like `claude --bg`, so a Codex agent lives in
//! an embedded terminal of OpenAdmiral (pty.rs): it runs while the app is open and is
//! resumed (`codex resume <session>`) when its terminal opens again after a restart.
//!
//! What it is doing comes from Codex's own hooks, passed for that session only with `-c`
//! (nothing is written to ~/.codex): each event runs `~/.claude/openadmiral/bin/codex-hook`,
//! which writes the latest one to `~/.claude/openadmiral/codex/<agent>.json`.
//! The list of Codex agents is the app's (`codex.json` in its data folder).

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::AppHandle;

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CodexAgent {
    pub id: String,
    pub name: String,
    pub cwd: String,
    pub created_at: u64,
    /// The first instruction, given when it starts.
    #[serde(default)]
    pub prompt: Option<String>,
}

/// An agent as the UI lists it: what it is doing and the command its terminal runs.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CodexRow {
    #[serde(flatten)]
    pub agent: CodexAgent,
    /// "working", "waiting", "idle" or "ended".
    pub status: &'static str,
    pub running: bool,
    pub updated_at: Option<u64>,
    pub last_reply: Option<String>,
    pub waiting: Option<String>,
    pub argv: Vec<String>,
}

const EVENTS: [&str; 7] = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PermissionRequest", "Stop", "SessionEnd"];

fn list_path(app: &AppHandle) -> Option<PathBuf> {
    crate::app_data_dir(app).map(|d| d.join("codex.json"))
}

fn read_list(app: &AppHandle) -> Vec<CodexAgent> {
    list_path(app).and_then(|p| std::fs::read_to_string(p).ok()).and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

fn write_list(app: &AppHandle, list: &[CodexAgent]) -> Result<(), String> {
    if crate::preview() {
        return Ok(());
    }
    let path = list_path(app).ok_or("no app data dir")?;
    std::fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(list).unwrap_or_default()).map_err(|e| e.to_string())?;
    std::fs::rename(tmp, path).map_err(|e| e.to_string())
}

fn events_dir() -> PathBuf {
    crate::admiral_dir().join("codex")
}

fn hook_path() -> PathBuf {
    crate::admiral_dir().join("bin").join("codex-hook")
}

/// The hook script: the event's JSON (stdin) and when, as the agent's latest event.
const HOOK: &str = r#"#!/bin/sh
# OpenAdmiral: a Codex hook event for an agent ($1: agent id, $2: event name).
dir="$HOME/.claude/openadmiral/codex"
mkdir -p "$dir"
payload=$(cat)
[ -n "$payload" ] || payload=null
printf '{"event":"%s","at":%s,"payload":%s}\n' "$2" "$(date +%s)" "$payload" > "$dir/$1.json.tmp" && mv "$dir/$1.json.tmp" "$dir/$1.json"
"#;

fn install_hook() -> Result<PathBuf, String> {
    let path = hook_path();
    if std::fs::read_to_string(&path).ok().as_deref() != Some(HOOK) {
        std::fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
        std::fs::write(&path, HOOK).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).map_err(|e| e.to_string())?;
        }
    }
    Ok(path)
}

/// `-c hooks.<Event>=[…]` for each event, running the hook script for this agent.
pub fn hook_args(script: &Path, id: &str) -> Vec<String> {
    let script = script.to_string_lossy().replace('\\', "\\\\").replace('"', "\\\"");
    EVENTS
        .iter()
        .flat_map(|e| ["-c".to_string(), format!(r#"hooks.{e}=[{{hooks=[{{type="command",command="'{script}' {id} {e}",timeout=10}}]}}]"#)])
        .collect()
}

/// The latest hook event of an agent: (event, unix seconds, payload).
fn last_event(id: &str) -> Option<(String, u64, serde_json::Value)> {
    let text = std::fs::read_to_string(events_dir().join(format!("{id}.json"))).ok()?;
    let v: serde_json::Value = serde_json::from_str(text.trim()).ok()?;
    Some((v["event"].as_str()?.to_string(), v["at"].as_u64().unwrap_or(0), v["payload"].clone()))
}

/// The Codex session to resume: the last SessionStart's, kept beside the events.
fn session_of(id: &str) -> Option<String> {
    std::fs::read_to_string(events_dir().join(format!("{id}.session"))).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

pub fn status_of(event: Option<&str>) -> &'static str {
    match event {
        Some("UserPromptSubmit" | "PreToolUse" | "PostToolUse") => "working",
        Some("PermissionRequest") => "waiting",
        Some("SessionEnd") => "ended",
        _ => "idle",
    }
}

fn row(a: CodexAgent, running: bool, script: &Path) -> CodexRow {
    let event = last_event(&a.id);
    // Remember the session to resume, from the event that names it.
    if let Some(sid) = event.as_ref().and_then(|(_, _, p)| p["session_id"].as_str()) {
        if session_of(&a.id).as_deref() != Some(sid) {
            let _ = std::fs::write(events_dir().join(format!("{}.session", a.id)), sid);
        }
    }
    let status = if running { status_of(event.as_ref().map(|e| e.0.as_str())) } else { "ended" };
    let waiting = event.as_ref().filter(|e| e.0 == "PermissionRequest").and_then(|e| e.2["tool_input"]["description"].as_str().or(e.2["tool_name"].as_str()).map(str::to_string));
    let last_reply = event.as_ref().and_then(|e| e.2["last_assistant_message"].as_str()).map(|s| s.chars().take(2000).collect());
    let mut argv = vec!["codex".to_string()];
    argv.extend(hook_args(script, &a.id));
    match session_of(&a.id) {
        Some(sid) => argv.extend(["resume".to_string(), sid]),
        None => argv.extend(a.prompt.clone().filter(|p| !p.trim().is_empty())),
    }
    CodexRow { status: if running && status == "ended" { "idle" } else { status }, running, updated_at: event.map(|e| e.1 * 1000), last_reply, waiting, argv, agent: a }
}

/// The Codex agents, with what each is doing and the command its terminal runs.
#[tauri::command]
pub fn codex_list(app: AppHandle) -> Vec<CodexRow> {
    let Ok(script) = install_hook() else { return vec![] };
    let running = crate::pty::open_keys(&app);
    read_list(&app).into_iter().map(|a| {
        let on = running.contains(&a.id);
        row(a, on, &script)
    }).collect()
}

/// Whether the Codex CLI is installed (on the login PATH).
#[tauri::command]
pub fn codex_available() -> bool {
    std::env::split_paths(crate::login_path()).any(|d| d.join("codex").is_file() || d.join("codex.exe").is_file() || d.join("codex.cmd").is_file())
}

/// A new Codex agent in `cwd` (or a worktree of its own): answers its id. Its terminal
/// starts it when it opens.
#[tauri::command]
pub async fn codex_new(app: AppHandle, cwd: String, name: String, prompt: Option<String>, worktree: Option<String>) -> Result<String, String> {
    let dir = match worktree.filter(|w| !w.trim().is_empty()) {
        Some(w) => {
            let cwd = cwd.clone();
            tauri::async_runtime::spawn_blocking(move || crate::workspace::new_worktree(&cwd, &w)).await.map_err(|e| e.to_string())??.to_string_lossy().to_string()
        }
        None => cwd,
    };
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    let id = format!("codex-{now:x}");
    let name = if name.trim().is_empty() { Path::new(&dir).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "codex".into()) } else { name.trim().to_string() };
    let mut list = read_list(&app);
    list.push(CodexAgent { id: id.clone(), name, cwd: dir, created_at: now, prompt: prompt.filter(|p| !p.trim().is_empty()) });
    write_list(&app, &list)?;
    Ok(id)
}

/// Stops a Codex agent (its terminal closes); it can be resumed from its view.
#[tauri::command]
pub fn codex_stop(app: AppHandle, id: String) {
    crate::pty::close(&app, &id);
}

/// Drops a Codex agent from OpenAdmiral (its Codex session stays in ~/.codex).
#[tauri::command]
pub fn codex_remove(app: AppHandle, id: String) -> Result<(), String> {
    crate::pty::close(&app, &id);
    let list: Vec<CodexAgent> = read_list(&app).into_iter().filter(|a| a.id != id).collect();
    for ext in ["json", "session"] {
        let _ = std::fs::remove_file(events_dir().join(format!("{id}.{ext}")));
    }
    write_list(&app, &list)
}

#[cfg(test)]
mod tests {
    #[test]
    fn hooks_are_toml_for_each_event() {
        let args = super::hook_args(std::path::Path::new("/Users/me/.claude/openadmiral/bin/codex-hook"), "codex-1");
        assert_eq!(args.len(), 14);
        assert_eq!(args[0], "-c");
        assert_eq!(args[1], r#"hooks.SessionStart=[{hooks=[{type="command",command="'/Users/me/.claude/openadmiral/bin/codex-hook' codex-1 SessionStart",timeout=10}]}]"#);
    }

    #[test]
    fn events_say_what_it_is_doing() {
        assert_eq!(super::status_of(Some("UserPromptSubmit")), "working");
        assert_eq!(super::status_of(Some("PermissionRequest")), "waiting");
        assert_eq!(super::status_of(Some("Stop")), "idle");
        assert_eq!(super::status_of(None), "idle");
    }
}
