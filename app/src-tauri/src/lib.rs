mod artifacts;
mod handoff;
mod jobs;
mod lifecycle;
mod migrate;
mod netwatch;
mod plugin_files;
mod power;
mod pty;
mod resume;
mod scheduler;
mod shot;
mod telemetry;
mod transcript;
mod underway;
mod updater;

use notify::{RecursiveMode, Watcher};
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::mpsc;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{TrayIconBuilder, TrayIconEvent};
use tauri::webview::DownloadEvent;
use tauri::{AppHandle, Emitter, Manager};

/// PATH of the person's login shell: an app opened from Finder inherits a bare
/// PATH, without the folders where `claude`, `git` and node live.
pub fn login_path() -> &'static str {
    static PATH: OnceLock<String> = OnceLock::new();
    PATH.get_or_init(|| {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
        let out = Command::new(shell)
            .args(["-ilc", "printf %s \"$PATH\""])
            .output()
            .ok()
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .map(|s| s.lines().last().unwrap_or("").trim().to_string())
            .unwrap_or_default();
        let home = dirs::home_dir().unwrap_or_default();
        let extra = format!(
            "{}/.local/bin:{}/.claude/local:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
            home.display(),
            home.display()
        );
        if out.is_empty() { extra } else { format!("{out}:{extra}") }
    })
}

/// Variables a Claude Code session sets for its own children. A `claude` started
/// with them (OpenAdmiral launched from inside a session, as `pnpm tauri dev` is) runs as
/// that session's child: not registered with `claude agents`, transcript off.
/// The person's own configuration (`CLAUDE_CONFIG_DIR`) is kept.
pub fn inherited_claude_vars() -> Vec<String> {
    std::env::vars()
        .map(|(k, _)| k)
        .filter(|k| k.starts_with("CLAUDE") && k != "CLAUDE_CONFIG_DIR")
        .collect()
}

/// `claude` with the login PATH and none of a parent session's variables.
pub fn claude_cmd() -> Command {
    let mut cmd = Command::new("claude");
    cmd.env("PATH", login_path());
    for k in inherited_claude_vars() {
        cmd.env_remove(k);
    }
    // Plain text: OpenAdmiral parses what claude prints (e.g. the backgrounded id).
    cmd.env_remove("FORCE_COLOR").env("NO_COLOR", "1");
    cmd
}

/// A second instance for screenshots and checks (`OPENADMIRAL_PREVIEW=1`): it reads
/// everything but writes nothing shared and attaches no terminals.
pub fn preview() -> bool {
    std::env::var_os("OPENADMIRAL_PREVIEW").is_some()
}

/// The app's own data folder (costs cache, sidebar order, UI state, hand-offs).
/// A preview snapshotting itself (OPENADMIRAL_SHOT, demo data) reads none of the
/// person's: nothing of theirs ends up in a screenshot.
pub fn app_data_dir(app: &AppHandle) -> Option<PathBuf> {
    if preview() && std::env::var_os("OPENADMIRAL_SHOT").is_some() {
        return None;
    }
    app.path().app_data_dir().ok()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DevEnv {
    preview: bool,
    select: Option<String>,
    tab: Option<String>,
    /// Preview only: menu item ids to fire at start, comma-separated (`agent:remove:<sessionId>`).
    debug_menu: Option<String>,
    /// Preview only: open on this view (delegations, costs, artifacts) / with the sidebar as a rail.
    view: Option<String>,
    rail: bool,
    /// Preview only: start with the inspector hidden (OPENADMIRAL_INSPECTOR_HIDDEN).
    inspector_hidden: bool,
    /// Preview only: attach terminals (for a throwaway session) / run the terminal repaint probe.
    attach: bool,
    probe: bool,
    /// Preview only: a tooltip to open at start (OPENADMIRAL_TIP=<tip id>).
    tip: Option<String>,
    /// Preview only: snapshotting itself (OPENADMIRAL_SHOT, see shot.rs).
    shot: bool,
}

/// Uncaught errors and unhandled rejections from the webview, next to Rust's own
/// panics on stderr (a crash hunt reads one log).
#[tauri::command]
fn frontend_log(level: String, message: String) {
    eprintln!("[webview {level}] {message}");
}

#[tauri::command]
fn dev_env() -> DevEnv {
    let p = preview();
    DevEnv {
        preview: p,
        select: std::env::var("OPENADMIRAL_SELECT").ok(),
        tab: std::env::var("OPENADMIRAL_TAB").ok(),
        debug_menu: if p { std::env::var("OPENADMIRAL_DEBUG_MENU").ok() } else { None },
        view: if p { std::env::var("OPENADMIRAL_VIEW").ok() } else { None },
        rail: p && std::env::var_os("OPENADMIRAL_RAIL").is_some(),
        inspector_hidden: p && std::env::var_os("OPENADMIRAL_INSPECTOR_HIDDEN").is_some(),
        attach: p && std::env::var_os("OPENADMIRAL_PREVIEW_ATTACH").is_some(),
        probe: p && std::env::var_os("OPENADMIRAL_TERM_PROBE").is_some(),
        tip: if p { std::env::var("OPENADMIRAL_TIP").ok() } else { None },
        shot: p && std::env::var_os("OPENADMIRAL_SHOT").is_some(),
    }
}

pub fn claude_home() -> PathBuf {
    std::env::var_os("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| dirs::home_dir().unwrap_or_default().join(".claude"))
}

pub fn admiral_dir() -> PathBuf {
    claude_home().join("openadmiral")
}

#[derive(Serialize, Clone)]
struct Snapshot {
    sessions: Vec<Value>,
    delegations: Vec<Value>,
    /// sessionId → { queue, sent }: the user's queued prompts and what the mod submitted.
    queues: serde_json::Map<String, Value>,
    artifacts: Vec<Value>,
    /// sessionId → the pending request (hand-off or exit), with the mod's `waiting` note if any.
    requests: serde_json::Map<String, Value>,
}

fn read_requests(dir: &Path) -> serde_json::Map<String, Value> {
    let mut out = serde_json::Map::new();
    let Ok(entries) = std::fs::read_dir(dir) else { return out };
    for e in entries.filter_map(|e| e.ok()) {
        let name = e.file_name().to_string_lossy().to_string();
        let Some(id) = name.strip_suffix(".json") else { continue };
        if let Some(v) = std::fs::read_to_string(e.path()).ok().and_then(|s| serde_json::from_str::<Value>(&s).ok()) {
            out.insert(id.to_string(), v);
        }
    }
    out
}

fn read_queues(dir: &Path) -> serde_json::Map<String, Value> {
    let mut out = serde_json::Map::new();
    let Ok(entries) = std::fs::read_dir(dir) else { return out };
    for e in entries.filter_map(|e| e.ok()) {
        let name = e.file_name().to_string_lossy().to_string();
        let Some(stem) = name.strip_suffix(".json") else { continue };
        let (id, key) = match stem.strip_suffix(".sent") {
            Some(id) => (id.to_string(), "sent"),
            None => (stem.to_string(), "queue"),
        };
        let Some(v) = std::fs::read_to_string(e.path()).ok().and_then(|s| serde_json::from_str::<Value>(&s).ok()) else { continue };
        let entry = out.entry(id).or_insert_with(|| serde_json::json!({}));
        entry[key] = v;
    }
    out
}

/// Writes the app's queue for a session: whole file, temp + rename, `updatedAt`
/// stamped here. Fields the app does not know are passed back untouched by the UI.
#[tauri::command]
fn queue_save(session_id: String, mut queue: Value) -> Result<(), String> {
    if preview() {
        return Ok(());
    }
    if session_id.contains('/') || session_id.contains("..") {
        return Err("bad session id".into());
    }
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    queue["v"] = Value::from(1);
    queue["updatedAt"] = Value::from(now);
    let dir = admiral_dir().join("queue");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{session_id}.json"));
    let tmp = dir.join(format!(".{session_id}.json.tmp"));
    std::fs::write(&tmp, serde_json::to_string_pretty(&queue).unwrap_or_default()).map_err(|e| e.to_string())?;
    std::fs::rename(tmp, path).map_err(|e| e.to_string())
}

/// The user closes a delegation by hand (done or cancelled), e.g. one whose agents are gone.
/// Same shape the mod writes: status, a note saying who and why, updatedAt.
#[tauri::command]
fn delegation_close(id: String, status: String, note: String) -> Result<(), String> {
    if preview() {
        return Ok(());
    }
    if !id.starts_with("dlg_") || !id[4..].chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err("bad delegation id".into());
    }
    if status != "done" && status != "cancelled" {
        return Err("status must be done or cancelled".into());
    }
    let dir = admiral_dir().join("delegations");
    let path = dir.join(format!("{id}.json"));
    let mut d: Value = serde_json::from_str(&std::fs::read_to_string(&path).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    d["status"] = Value::from(status.clone());
    d["updatedAt"] = Value::from(now);
    if !d["notes"].is_array() {
        d["notes"] = Value::Array(vec![]);
    }
    if let Some(notes) = d["notes"].as_array_mut() {
        notes.push(serde_json::json!({ "at": now, "by": "OpenAdmiral", "status": status, "text": note }));
    }
    let tmp = dir.join(format!(".{id}.json.tmp"));
    std::fs::write(&tmp, serde_json::to_string_pretty(&d).unwrap_or_default()).map_err(|e| e.to_string())?;
    std::fs::rename(tmp, path).map_err(|e| e.to_string())
}

pub(crate) fn read_dir_json(dir: &Path) -> Vec<Value> {
    let Ok(entries) = std::fs::read_dir(dir) else { return vec![] };
    entries
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "json"))
        .filter_map(|p| std::fs::read_to_string(p).ok())
        // A file caught mid-write fails to parse; the next event re-reads it.
        .filter_map(|s| serde_json::from_str(&s).ok())
        .collect()
}

#[tauri::command]
fn load_snapshot() -> Snapshot {
    let dir = admiral_dir();
    Snapshot {
        // A session without a transcript never ran as a real session (see isPhantom in the UI).
        sessions: read_dir_json(&dir.join("sessions"))
            .into_iter()
            .map(|mut s| {
                let id = s.get("sessionId").and_then(Value::as_str).unwrap_or("").to_string();
                let cwd = s.get("cwd").and_then(Value::as_str).unwrap_or("").to_string();
                s["hasTranscript"] = Value::from(transcript::locate(&id, &cwd).is_some());
                s
            })
            .collect(),
        delegations: read_dir_json(&dir.join("delegations")),
        queues: read_queues(&dir.join("queue")),
        artifacts: artifacts::read_all(),
        requests: read_requests(&dir.join("requests")),
    }
}

pub fn claude_agents() -> Option<Value> {
    let out = claude_cmd().args(["agents", "--json"]).output().ok()?;
    serde_json::from_slice(&out.stdout).ok()
}

#[tauri::command]
async fn list_agents() -> Value {
    claude_agents().unwrap_or(Value::Array(vec![]))
}

/// Runs a `claude` invocation; on failure the error is what it printed, stderr
/// included, so the app can show it (an untrusted workspace, a bad flag).
pub fn run_cli(mut cmd: Command) -> Result<String, String> {
    let out = cmd.output().map_err(|e| e.to_string())?;
    let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if out.status.success() {
        return Ok(stdout);
    }
    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
    let msg = [stdout, stderr].into_iter().filter(|s| !s.is_empty()).collect::<Vec<_>>().join("\n");
    Err(if msg.is_empty() { format!("claude exited with {}", out.status) } else { msg })
}

/// Starts a background session in `cwd`; `claude --bg` returns once it is up.
#[tauri::command]
async fn new_agent(cwd: String, name: String, prompt: Option<String>) -> Result<String, String> {
    let mut cmd = claude_cmd();
    cmd.current_dir(&cwd).arg("--bg");
    if !name.trim().is_empty() {
        cmd.args(["-n", name.trim()]);
    }
    if let Some(p) = prompt.filter(|p| !p.trim().is_empty()) {
        cmd.args(["--", p.trim()]);
    }
    // The new job's short id, so the app can open it once it is listed ("" if claude did not say).
    run_cli(cmd).map(|out| backgrounded_id(&out).unwrap_or_default())
}

pub fn is_listed(agents: &Value, session_id: &str) -> bool {
    agents
        .as_array()
        .is_some_and(|list| list.iter().any(|a| a.get("sessionId").and_then(Value::as_str) == Some(session_id)))
}

/// `claude agents --json --all`: also the background jobs that have exited.
pub fn claude_agents_all() -> Option<Value> {
    let out = claude_cmd().args(["agents", "--json", "--all"]).output().ok()?;
    serde_json::from_slice(&out.stdout).ok()
}

/// The CLI's row for a session, if it is running.
pub fn agent_row(agents: &Value, session_id: &str) -> Option<Value> {
    agents.as_array()?.iter().find(|a| a.get("sessionId").and_then(Value::as_str) == Some(session_id)).cloned()
}

/// The short id in `claude --bg`'s answer ("backgrounded · 0b3f7c0f · name …"):
/// the session it actually started, which is a copy when it differs from the one asked for.
/// Drops terminal colour codes (ESC [ … letter), in case claude colours its output anyway.
fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\x1b' && chars.peek() == Some(&'[') {
            chars.next();
            for c in chars.by_ref() {
                if c.is_ascii_alphabetic() {
                    break;
                }
            }
        } else {
            out.push(c);
        }
    }
    out
}

pub fn backgrounded_id(output: &str) -> Option<String> {
    output.lines().find_map(|line| {
        let line = strip_ansi(line);
        let rest = line.trim().strip_prefix("backgrounded")?;
        let id = rest.split('·').nth(1)?.trim();
        (!id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')).then(|| id.to_string())
    })
}

/// Like `run_cli`, but gives up after `limit` (the command is killed).
pub fn run_cli_within(mut cmd: Command, limit: Duration) -> Result<String, String> {
    use std::process::Stdio;
    let mut child = cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|e| e.to_string())?;
    let start = std::time::Instant::now();
    loop {
        match child.try_wait().map_err(|e| e.to_string())? {
            Some(_) => break,
            None if start.elapsed() > limit => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("claude did not answer within {} s.", limit.as_secs()));
            }
            None => std::thread::sleep(Duration::from_millis(200)),
        }
    }
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if out.status.success() {
        return Ok(stdout);
    }
    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
    let msg = [stdout, stderr].into_iter().filter(|s| !s.is_empty()).collect::<Vec<_>>().join("\n");
    Err(if msg.is_empty() { format!("claude exited with {}", out.status) } else { msg })
}

/// Continues a session in the background. Answers the full id it runs under: the
/// same one (or the id its job carries now, see below), unless the CLI started a
/// copy (it says so; the caller cleans up).
///
/// A background session that exited keeps its job record (`claude agents --all`,
/// state stopped/done/failed). Resuming it *with flags* (`-n`) starts a copy
/// under a new id; without flags the CLI wakes the same job with its saved
/// options (name, model, worktree). So the name is passed only for a session
/// that has no job record (one that ran in a terminal).
///
/// After a /clear the job is listed under its ORIGINAL session id, not this one
/// (`jobs`): resume that id, without flags. The job wakes on its latest
/// conversation, so it comes back under the post-/clear id.
pub fn resume_session(session_id: &str, name: &str, cwd: &str) -> Result<String, String> {
    let agents = claude_agents().ok_or("could not ask claude which sessions are running")?;
    if jobs::is_running(&agents, session_id) {
        return Err("That session is still running.".into());
    }
    let job = claude_agents_all().and_then(|all| jobs::job_of(&all, session_id));
    let target = job.as_ref().map_or(session_id, |j| j.session_id.as_str());
    let mut cmd = claude_cmd();
    cmd.current_dir(cwd).args(["--bg", "--resume", target]);
    if job.is_none() && !name.trim().is_empty() {
        cmd.args(["-n", name.trim()]);
    }
    let out = run_cli_within(cmd, Duration::from_secs(30))?;
    let same = |id: &str| session_id.starts_with(id) || target.starts_with(id) || job.as_ref().is_some_and(|j| j.id == id);
    match backgrounded_id(&out) {
        Some(id) if !same(&id) => {
            // A copy: find its full id in the CLI's list (it registers within seconds).
            let start = std::time::Instant::now();
            while start.elapsed() < Duration::from_secs(30) {
                if let Some(full) = claude_agents().and_then(|a| {
                    a.as_array()?.iter().find_map(|r| {
                        let sid = r.get("sessionId").and_then(Value::as_str)?;
                        let rid = r.get("id").and_then(Value::as_str).unwrap_or("");
                        (rid == id || sid.starts_with(&id)).then(|| sid.to_string())
                    })
                }) {
                    return Ok(full);
                }
                std::thread::sleep(Duration::from_secs(1));
            }
            Err(format!("claude started it as {id}, but that session did not show up within 30 s."))
        }
        _ => {
            // The same job: wait until the CLI lists it, so the UI can open its terminal,
            // and answer the id it runs under now (the post-/clear one, after a /clear).
            let start = std::time::Instant::now();
            while start.elapsed() < Duration::from_secs(30) {
                if let Some(a) = claude_agents() {
                    if is_listed(&a, session_id) {
                        return Ok(session_id.to_string());
                    }
                    if let Some(j) = job.as_ref().and_then(|j| jobs::find(&a, &[session_id.to_string(), j.session_id.clone()]).filter(|l| l.id == j.id)) {
                        return Ok(j.session_id);
                    }
                }
                std::thread::sleep(Duration::from_secs(1));
            }
            Err("claude accepted the resume, but the session did not start within 30 s. Check `claude agents`, then retry or cancel.".into())
        }
    }
}

/// Drops what is left of a session that continues under another id: its exited
/// job (`claude rm`, unless it ran in a worktree, which rm could delete) and its
/// files under ~/.claude/openadmiral, so the list has no duplicate row. A job running
/// again (it woke under its post-/clear id) is the same agent: only the request
/// goes, and the superseded session files stay as the links `jobs` follows.
pub fn forget_session(session_id: &str, cwd: &str) {
    let chain = jobs::chain_of(session_id);
    // None: the CLI did not answer, so treat the job as possibly running.
    let running = claude_agents().map(|live| jobs::find(&live, &chain).is_some()).unwrap_or(true);
    let _ = std::fs::remove_file(admiral_dir().join("requests").join(format!("{session_id}.json")));
    if running {
        return;
    }
    if !cwd.contains("/.claude/worktrees/") {
        if let Some(job) = claude_agents_all().and_then(|all| jobs::find(&all, &chain)) {
            let mut cmd = claude_cmd();
            cmd.args(["rm", &job.id]);
            let _ = run_cli_within(cmd, Duration::from_secs(15));
        }
    }
    for id in &chain {
        for sub in ["sessions", "requests"] {
            let _ = std::fs::remove_file(admiral_dir().join(sub).join(format!("{id}.json")));
        }
    }
}

#[tauri::command]
async fn resume_agent(session_id: String, name: String, cwd: String) -> Result<String, String> {
    let id = resume_session(&session_id, &name, &cwd)?;
    if id != session_id {
        forget_session(&session_id, &cwd);
        let _ = scheduler::move_queue(&session_id, &id);
    }
    Ok(id)
}

const CCUSAGE: &str = "ccusage@20.0.26";

fn costs_cache(app: &AppHandle) -> Option<PathBuf> {
    app_data_dir(app).map(|d| d.join("ccusage-daily.json"))
}

/// The last good ccusage report, saved on disk, so the Costs view draws at once
/// and offline: `{ fetchedAt, data }`, or null before the first fetch.
#[tauri::command]
fn costs_cached(app: AppHandle) -> Value {
    costs_cache(&app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(Value::Null)
}

/// Runs ccusage for the last `days` days, per project, and caches the result.
#[tauri::command]
async fn costs_refresh(app: AppHandle, days: u32) -> Result<Value, String> {
    let since = {
        let out = Command::new("date")
            .args(["-v", &format!("-{days}d"), "+%Y%m%d"])
            .output()
            .map_err(|e| e.to_string())?;
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    };
    let out = tauri::async_runtime::spawn_blocking(move || {
        Command::new("npx")
            .args(["-y", CCUSAGE, "claude", "daily", "--json", "--instances", "--since", &since])
            .env("PATH", login_path())
            .output()
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| format!("could not run npx: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        let last = err.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("ccusage failed");
        return Err(last.trim().to_string());
    }
    let data: Value = serde_json::from_slice(&out.stdout).map_err(|e| format!("ccusage returned no JSON: {e}"))?;
    let fetched_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let report = serde_json::json!({ "fetchedAt": fetched_at, "data": data });
    // A preview writes nothing shared (its CLAUDE_CONFIG_DIR may be demo data).
    if let Some(path) = costs_cache(&app).filter(|_| !preview()) {
        let _ = std::fs::create_dir_all(path.parent().unwrap());
        let _ = std::fs::write(path, report.to_string());
    }
    Ok(report)
}

fn order_path(app: &AppHandle) -> Option<PathBuf> {
    app_data_dir(app).map(|d| d.join("sidebar-order.json"))
}

/// The sidebar order the person dragged into place: `{ projects, agents }`, or null.
#[tauri::command]
fn order_load(app: AppHandle) -> Value {
    order_path(&app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(Value::Null)
}

#[tauri::command]
fn order_save(app: AppHandle, order: Value) -> Result<(), String> {
    if preview() {
        return Ok(());
    }
    let path = order_path(&app).ok_or("no app data dir")?;
    std::fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
    // Write then rename, so a crash mid-write never leaves half a file.
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(&order).unwrap_or_default()).map_err(|e| e.to_string())?;
    std::fs::rename(tmp, path).map_err(|e| e.to_string())
}

/// What the macOS pasteboard holds, read natively (clipboard.js, JXA): file paths for
/// a Finder copy, `image` for raw image data, else `text`. The terminal's paste
/// decides from this instead of the web clipboard, which offers a copied file as its icon.
#[tauri::command]
async fn clipboard_read() -> Result<Value, String> {
    let out = tauri::async_runtime::spawn_blocking(|| {
        Command::new("osascript").args(["-l", "JavaScript", "-e", include_str!("clipboard.js")]).output()
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;
    serde_json::from_slice(&out.stdout).map_err(|_| String::from_utf8_lossy(&out.stderr).trim().to_string())
}

/// Puts a command in a session's prompt box, not submitted: the mod polls
/// fill/<id>.json and fills its draft (docs/CONTRACT.md). Preview: nothing is written.
/// Renames a session: the OpenAdmiral plugin runs `/rename <name>` in it (fill/<id>.json with a command).
#[tauri::command]
fn rename_session(session_id: String, name: String) -> Result<(), String> {
    if session_id.contains('/') || session_id.contains("..") {
        return Err("bad session id".into());
    }
    let name = name.split_whitespace().collect::<Vec<_>>().join(" ");
    if name.is_empty() || name.chars().count() > 80 {
        return Err("A name needs 1 to 80 characters.".into());
    }
    if preview() {
        eprintln!("[preview] rename {}: {name}", &session_id[..session_id.len().min(8)]);
        return Ok(());
    }
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    let dir = admiral_dir().join("fill");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let tmp = dir.join(format!(".{session_id}.json.tmp"));
    std::fs::write(&tmp, serde_json::json!({ "command": "rename", "args": name, "at": now }).to_string()).map_err(|e| e.to_string())?;
    std::fs::rename(tmp, dir.join(format!("{session_id}.json"))).map_err(|e| e.to_string())
}

#[tauri::command]
fn fill_session(session_id: String, text: String) -> Result<(), String> {
    if session_id.contains('/') || session_id.contains("..") {
        return Err("bad session id".into());
    }
    if preview() {
        eprintln!("[preview] fill {}: {text}", &session_id[..session_id.len().min(8)]);
        return Ok(());
    }
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    let dir = admiral_dir().join("fill");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let tmp = dir.join(format!(".{session_id}.json.tmp"));
    std::fs::write(&tmp, serde_json::json!({ "text": text, "at": now }).to_string()).map_err(|e| e.to_string())?;
    std::fs::rename(tmp, dir.join(format!("{session_id}.json"))).map_err(|e| e.to_string())
}

/// Plain text to the clipboard.
#[tauri::command]
fn copy_text(text: String) -> Result<(), String> {
    let mut child = Command::new("pbcopy").stdin(std::process::Stdio::piped()).spawn().map_err(|e| e.to_string())?;
    std::io::Write::write_all(child.stdin.as_mut().unwrap(), text.as_bytes()).map_err(|e| e.to_string())?;
    child.wait().map_err(|e| e.to_string())?;
    Ok(())
}

/// Shows a folder in Finder, selected in its parent.
#[tauri::command]
fn reveal_path(path: String) -> Result<(), String> {
    if !Path::new(&path).exists() {
        return Err(format!("{path} no longer exists."));
    }
    Command::new("open").arg("-R").arg(&path).status().map_err(|e| e.to_string())?;
    Ok(())
}

fn ui_state_path(app: &AppHandle) -> Option<PathBuf> {
    app_data_dir(app).map(|d| d.join("ui-state.json"))
}

/// Layout choices that outlive a restart (panels collapsed, focus mode).
#[tauri::command]
fn ui_state_load(app: AppHandle) -> Value {
    ui_state_path(&app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(Value::Null)
}

#[tauri::command]
fn ui_state_save(app: AppHandle, state: Value) -> Result<(), String> {
    if preview() {
        return Ok(());
    }
    let path = ui_state_path(&app).ok_or("no app data dir")?;
    std::fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, state.to_string()).map_err(|e| e.to_string())?;
    std::fs::rename(tmp, path).map_err(|e| e.to_string())
}

#[tauri::command]
fn set_attention(app: AppHandle, count: usize) {
    if let Some(tray) = app.tray_by_id("openadmiral") {
        let _ = tray.set_title(if count > 0 { Some(count.to_string()) } else { None });
        let _ = tray.set_tooltip(Some(match count {
            0 => "OpenAdmiral: nothing needs you".to_string(),
            1 => "OpenAdmiral: 1 agent needs you".to_string(),
            n => format!("OpenAdmiral: {n} agents need you"),
        }));
    }
}

/// Opens a new GitHub issue from the repo's form ("bug" or "feedback"), its type
/// preset by the form, with this app's version and macOS already filled in.
#[tauri::command]
fn open_issue(app: AppHandle, kind: String) -> Result<(), String> {
    let template = match kind.as_str() {
        "bug" => "bug.yml",
        "feedback" => "feedback.yml",
        _ => return Err(format!("unknown issue kind {kind}")),
    };
    let macos = format!("{} · {}", telemetry::os_version(), std::env::consts::ARCH);
    let url = format!(
        "https://github.com/OpenAdmiral/openadmiral/issues/new?template={template}&version={}&macos={}",
        query_escape(&app.package_info().version.to_string()),
        query_escape(&macos),
    );
    Command::new("open").arg(url).status().map(|_| ()).map_err(|e| e.to_string())
}

/// Percent-encodes everything but unreserved URL characters.
fn query_escape(s: &str) -> String {
    s.bytes()
        .map(|b| if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") })
        .collect()
}

#[tauri::command]
fn open_in_terminal(cwd: String) -> Result<(), String> {
    Command::new("open")
        .args(["-a", "Terminal", &cwd])
        .status()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

fn watch_admiral(app: AppHandle) {
    std::thread::spawn(move || {
        let dir = admiral_dir();
        let _ = std::fs::create_dir_all(dir.join("sessions"));
        let _ = std::fs::create_dir_all(dir.join("delegations"));
        let (tx, rx) = mpsc::channel();
        let Ok(mut watcher) = notify::recommended_watcher(tx) else { return };
        if watcher.watch(&dir, RecursiveMode::Recursive).is_err() {
            return;
        }
        // "Open in OpenAdmiral" from a session (focus.json): only a request newer than the one
        // there at start, and under 10 s old, raises the window and is handed to the UI.
        let read_focus = || {
            std::fs::read_to_string(dir.join("focus.json"))
                .ok()
                .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        };
        let at_of = |v: &Value| v.get("at").and_then(Value::as_u64).unwrap_or(0);
        let mut last_focus = read_focus().map(|v| at_of(&v)).unwrap_or(0);
        // Coalesce bursts (a mod rewrites its file several times per turn) into one snapshot.
        while rx.recv().is_ok() {
            while rx.recv_timeout(Duration::from_millis(120)).is_ok() {}
            let _ = app.emit("openadmiral://snapshot", load_snapshot());
            if let Some(focus) = read_focus() {
                let at = at_of(&focus);
                let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
                if at > last_focus && now.saturating_sub(at) < 10_000 && !preview() {
                    last_focus = at;
                    show_main(&app);
                    let _ = app.emit("openadmiral://focus", focus);
                }
            }
        }
    });
}

fn poll_agents(app: AppHandle) {
    std::thread::spawn(move || loop {
        if let Some(agents) = claude_agents() {
            if !preview() {
                handoff::tick(&app, &agents);
            }
            let _ = app.emit("openadmiral://agents", agents);
        }
        std::thread::sleep(Duration::from_secs(2));
    });
}

#[derive(serde::Deserialize)]
struct MenuSpec {
    id: Option<String>,
    text: Option<String>,
    enabled: Option<bool>,
    accelerator: Option<String>,
    separator: Option<bool>,
}

/// A native context menu built here rather than in JS: clicks come back through
/// the app's own menu handler (`openadmiral://menu` with the item's id), which does not
/// depend on JS-side menu resources staying alive.
#[tauri::command]
fn popup_menu(window: tauri::Window, items: Vec<MenuSpec>) -> Result<(), String> {
    let app = window.app_handle();
    let menu = Menu::new(app).map_err(|e| e.to_string())?;
    for it in items {
        if it.separator == Some(true) {
            menu.append(&PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        } else {
            let id = format!("ui:{}", it.id.unwrap_or_default());
            let item = MenuItem::with_id(app, id, it.text.unwrap_or_default(), it.enabled.unwrap_or(true), it.accelerator.as_deref())
                .map_err(|e| e.to_string())?;
            menu.append(&item).map_err(|e| e.to_string())?;
        }
    }
    window.popup_menu(&menu).map_err(|e| e.to_string())
}

/// Every menu click lands here; the UI's own items carry the `ui:` prefix.
fn handle_menu(app: &AppHandle, id: &str) {
    if let Some(rest) = id.strip_prefix("ui:") {
        let _ = app.emit("openadmiral://menu", rest.to_string());
    } else if id == "app:about" {
        show_main(app);
        let _ = app.emit("openadmiral://about", ());
    } else if id == "help:shortcuts" {
        let _ = app.emit("openadmiral://shortcuts", ());
    } else if let Some(kind) = id.strip_prefix("help:").filter(|k| *k == "bug" || *k == "feedback") {
        let _ = open_issue(app.clone(), kind.to_string());
    } else if id == "help:updates" {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let _ = updater::check(&app, true).await;
        });
    } else if id == "help:telemetry" {
        // The menu toggles its own checkmark; follow it.
        telemetry::set_enabled(app, !telemetry::enabled(app));
    }
}

/// Debug builds and previews: fire a menu item by id through the same handler a click reaches.
#[tauri::command]
fn debug_menu_event(app: AppHandle, id: String) -> Result<(), String> {
    if !(cfg!(debug_assertions) || preview()) {
        return Err("debug only".into());
    }
    // App-menu items keep their own ids; context-menu items carry the `ui:` prefix.
    handle_menu(&app, &if id.starts_with("help:") { id } else { format!("ui:{id}") });
    Ok(())
}

/// The statusline trusts attached.json for 30 s: refresh it well within that.
fn heartbeat_attached(app: AppHandle) {
    std::thread::spawn(move || loop {
        pty::refresh_attached(&app);
        std::thread::sleep(Duration::from_secs(10));
    });
}

/// The macOS menu bar without "Close Window", so ⌘W reaches the app (it closes
/// the selected agent); the red button still hides the window.
fn app_menu(app: &tauri::App) -> tauri::Result<Menu<tauri::Wry>> {
    let openadmiral = Submenu::with_items(app, "OpenAdmiral", true, &[
        // Our own About (AboutSheet.tsx): macOS's panel shows credits as a bare text box.
        &MenuItem::with_id(app, "app:about", "About OpenAdmiral", true, None::<&str>)?,
        &PredefinedMenuItem::separator(app)?,
        &PredefinedMenuItem::hide(app, None)?,
        &PredefinedMenuItem::hide_others(app, None)?,
        &PredefinedMenuItem::show_all(app, None)?,
        &PredefinedMenuItem::separator(app)?,
        &PredefinedMenuItem::quit(app, None)?,
    ])?;
    let edit = Submenu::with_items(app, "Edit", true, &[
        &PredefinedMenuItem::undo(app, None)?,
        &PredefinedMenuItem::redo(app, None)?,
        &PredefinedMenuItem::separator(app)?,
        &PredefinedMenuItem::cut(app, None)?,
        &PredefinedMenuItem::copy(app, None)?,
        &PredefinedMenuItem::paste(app, None)?,
        &PredefinedMenuItem::select_all(app, None)?,
    ])?;
    let window = Submenu::with_items(app, "Window", true, &[
        &PredefinedMenuItem::minimize(app, None)?,
        &PredefinedMenuItem::maximize(app, None)?,
        &PredefinedMenuItem::fullscreen(app, None)?,
    ])?;
    let help = Submenu::with_items(app, "Help", true, &[
        &MenuItem::with_id(app, "help:shortcuts", "Keyboard Shortcuts", true, Some("CmdOrCtrl+/"))?,
        &PredefinedMenuItem::separator(app)?,
        &MenuItem::with_id(app, "help:feedback", "Send Feedback…", true, None::<&str>)?,
        &MenuItem::with_id(app, "help:bug", "Report a Bug…", true, None::<&str>)?,
        &PredefinedMenuItem::separator(app)?,
        &MenuItem::with_id(app, "help:updates", "Check for Updates…", true, None::<&str>)?,
        &CheckMenuItem::with_id(app, "help:telemetry", "Share Anonymous Usage Stats", true, telemetry::enabled(app.handle()), None::<&str>)?,
    ])?;
    Menu::with_items(app, &[&openadmiral, &edit, &window, &help])
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    migrate::legacy();
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(updater::Pending::default())
        .manage(pty::Ptys::default())
        .manage(handoff::Handoffs::default())
        .manage(transcript::Transcripts::default())
        .manage(underway::Underway::default())
        .invoke_handler(tauri::generate_handler![
            load_snapshot,
            list_agents,
            new_agent,
            resume_agent,
            costs_cached,
            costs_refresh,
            dev_env,
            frontend_log,
            popup_menu,
            debug_menu_event,
            order_load,
            order_save,
            ui_state_load,
            ui_state_save,
            clipboard_read,
            fill_session,
            rename_session,
            copy_text,
            reveal_path,
            queue_save,
            scheduler::queue_move,
            delegation_close,
            artifacts::artifact_text,
            artifacts::artifact_action,
            artifacts::browser_open,
            handoff::handoff_start,
            handoff::handoff_cancel,
            handoff::handoff_list,
            set_attention,
            open_in_terminal,
            pty::pty_open,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            lifecycle::agent_close,
            lifecycle::agent_force_quit,
            lifecycle::agent_remove,
            transcript::transcript_open,
            transcript::transcript_close,
            open_issue,
            updater::update_check,
            updater::update_install,
            underway::underway_state,
            underway::underway_settings,
            underway::underway_helper,
            underway::underway_backup,
            underway::underway_join,
            underway::underway_networks,
            plugin_files::plugin_changed_at,
            plugin_files::plugin_reload,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            // The main window is built here rather than by the config alone, to give it a
            // download handler: without one WebKit drops downloads (an image's Download Image).
            if let Some(config) = app.config().app.windows.iter().find(|w| w.label == "main").cloned() {
                let started = Mutex::new(HashMap::<String, PathBuf>::new());
                tauri::WebviewWindowBuilder::from_config(app, &config)?
                    .on_download(move |webview, event| {
                        match event {
                            // WebKit's own pick: ~/Downloads, renamed rather than overwriting.
                            DownloadEvent::Requested { url, destination } => {
                                started.lock().unwrap().insert(url.to_string(), destination.clone());
                            }
                            // macOS reports no path when it finishes: use the one it started with.
                            DownloadEvent::Finished { url, success, .. } => {
                                let path = started.lock().unwrap().remove(url.as_str());
                                let _ = webview.emit("openadmiral://download", serde_json::json!({ "success": success, "path": path }));
                            }
                            _ => {}
                        }
                        true
                    })
                    .build()?;
            }
            app.set_menu(app_menu(app)?)?;
            updater::start(handle.clone());
            telemetry::start(handle.clone());
            // Underway: the lid, the network, auto-resume (a preview shows a canned state).
            app.state::<underway::Underway>().start(handle.clone());
            // Preview checks of either appearance without touching the system's (OPENADMIRAL_THEME=light|dark).
            if preview() {
                if let (Ok(theme), Some(w)) = (std::env::var("OPENADMIRAL_THEME"), app.get_webview_window("main")) {
                    let _ = w.set_theme(match theme.as_str() {
                        "light" => Some(tauri::Theme::Light),
                        "dark" => Some(tauri::Theme::Dark),
                        _ => None,
                    });
                }
                if let Ok(path) = std::env::var("OPENADMIRAL_SHOT") {
                    shot::keep_rendering(app.handle());
                    shot::schedule(handle.clone(), path);
                }
            }
            app.on_menu_event(|app, e| handle_menu(app, e.id().as_ref()));
            let show = MenuItem::with_id(app, "show", "Show OpenAdmiral", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit OpenAdmiral", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;
            if !preview() {
                TrayIconBuilder::with_id("openadmiral")
                    .icon(tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png"))?)
                    .icon_as_template(true)
                    .menu(&menu)
                    .show_menu_on_left_click(false)
                    .on_menu_event(|app, e| match e.id.as_ref() {
                        "show" => show_main(app),
                        "quit" => app.exit(0),
                        _ => {}
                    })
                    .on_tray_icon_event(|tray, e| {
                        if let TrayIconEvent::Click { button: tauri::tray::MouseButton::Left, .. } = e {
                            show_main(tray.app_handle());
                        }
                    })
                    .build(app)?;
            }
            handoff::load(&handle);
            watch_admiral(handle.clone());
            poll_agents(handle.clone());
            if !preview() {
                // Up next: resumes closed sessions whose scheduled items are due.
                scheduler::start(handle.clone());
                heartbeat_attached(handle);
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the window keeps OpenAdmiral in the menu bar, as a native utility does.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() != "main" {
                    return;
                }
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building OpenAdmiral")
        .run(|app, event| {
            // A clean quit tells the statusline nothing is attached any more, and
            // gives sleep back to macOS at once (the helper would after its lease).
            if let tauri::RunEvent::Exit = event {
                if !preview() {
                    pty::write_attached(&[]);
                    app.state::<underway::Underway>().shutdown();
                }
            }
        });
}

#[cfg(test)]
mod tests {
    #[test]
    fn query_escape_keeps_unreserved_and_encodes_the_rest() {
        assert_eq!(super::query_escape("0.1.1"), "0.1.1");
        assert_eq!(super::query_escape("26.0 · aarch64"), "26.0%20%C2%B7%20aarch64");
    }
}
