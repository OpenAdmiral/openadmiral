//! Claude Code sessions OpenAdmiral can see without its plugin: the `claude`
//! processes running on this Mac (in a terminal, VS Code, Cursor…) and their
//! transcripts. They show in the app as "not connected": project, branch, whether
//! they are working, the conversation, and a way to connect them (the plugin). The
//! sessions that do run the plugin, and background jobs `claude agents` lists, are
//! known already and left out.

use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

/// An open turn whose transcript has not moved for this long is not working (a
/// session left mid-turn, or a process the transcript no longer belongs to).
const STUCK_MS: i64 = 10 * 60_000;
/// Transcripts older than this are not the live session of a process in that folder.
const LIVE_MS: i64 = 12 * 3600 * 1000;

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Discovered {
    pub session_id: String,
    pub cwd: String,
    pub project: String,
    pub branch: Option<String>,
    /// "working" or "idle", read from the transcript.
    pub status: &'static str,
    pub last_prompt: Option<String>,
    pub last_reply: Option<String>,
    pub updated_at: i64,
    /// Where it runs: "VS Code", "Cursor", "Terminal"…
    pub via: String,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Discovery {
    /// The OpenAdmiral plugin is installed and enabled for this user.
    pub plugin_installed: bool,
    pub sessions: Vec<Discovered>,
}

#[derive(Debug, Clone)]
struct Proc {
    pid: u32,
    ppid: u32,
    command: String,
}

fn ps() -> Vec<Proc> {
    let out = crate::power::run("/bin/ps", &["-axww", "-o", "pid=,ppid=,command="]);
    out.lines()
        .filter_map(|l| {
            let mut it = l.split_whitespace();
            let pid = it.next()?.parse().ok()?;
            let ppid = it.next()?.parse().ok()?;
            let command = it.collect::<Vec<_>>().join(" ");
            Some(Proc { pid, ppid, command })
        })
        .collect()
}

/// A Claude Code session process: the `claude` binary, not one of its helpers
/// (daemon, background spares, attach, agents…), which other paths cover.
fn is_session(command: &str) -> bool {
    let mut args = command.split_whitespace();
    let Some(bin) = args.next() else { return false };
    if bin.rsplit('/').next() != Some("claude") {
        return false;
    }
    let first = args.next();
    // Helpers that are not conversations: the Chrome bridge, MCP servers, one-shot prints.
    if command.contains("--chrome-native-host") || command.contains(" mcp serve") {
        return false;
    }
    !matches!(first, Some("daemon" | "bg-pty-host" | "bg-spare" | "attach" | "agents" | "plugin" | "mcp" | "config" | "update" | "doctor" | "install" | "setup-token"))
}

/// The app it runs in, from its ancestors.
fn via(pid: u32, by_pid: &HashMap<u32, &Proc>) -> String {
    let mut p = by_pid.get(&pid).map(|p| p.ppid);
    for _ in 0..12 {
        let Some(proc_) = p.and_then(|id| by_pid.get(&id)) else { break };
        let c = proc_.command.as_str();
        for (needle, name) in [("Visual Studio Code", "VS Code"), ("Code Helper", "VS Code"), ("Cursor", "Cursor"), ("Windsurf", "Windsurf"), ("Zed", "Zed"), ("JetBrains", "JetBrains"), ("iTerm", "iTerm"), ("Ghostty", "Ghostty"), ("Warp", "Warp"), ("Terminal.app", "Terminal")] {
            if c.contains(needle) {
                return name.into();
            }
        }
        p = Some(proc_.ppid).filter(|id| *id > 1);
    }
    "Terminal".into()
}

/// "VS Code" for the editor's own extension (its bundled binary), "VS Code terminal"
/// for `claude` typed in its terminal; as the plugin says it (plugin/hooks/host.ts).
fn label(app: &str, command: &str) -> String {
    let editor = matches!(app, "VS Code" | "Cursor" | "Windsurf" | "Zed" | "JetBrains");
    if editor && !command.contains("/extensions/") && !command.contains("native-binary") {
        format!("{app} terminal")
    } else {
        app.to_string()
    }
}

/// Working folders of these pids (`lsof`, one call).
fn cwds(pids: &[u32]) -> HashMap<u32, String> {
    if pids.is_empty() {
        return HashMap::new();
    }
    let list = pids.iter().map(u32::to_string).collect::<Vec<_>>().join(",");
    let out = crate::power::run("/usr/sbin/lsof", &["-a", "-d", "cwd", "-Fn", "-p", &list]);
    let mut map = HashMap::new();
    let mut pid = None;
    for line in out.lines() {
        if let Some(p) = line.strip_prefix('p') {
            pid = p.parse().ok();
        } else if let (Some(path), Some(p)) = (line.strip_prefix('n'), pid) {
            map.insert(p, path.to_string());
        }
    }
    map
}

/// The session id a process was started with, when its arguments say.
fn session_arg(command: &str) -> Option<String> {
    let args: Vec<&str> = command.split_whitespace().collect();
    args.windows(2).find(|w| matches!(w[0], "--session-id" | "--resume" | "-r")).map(|w| w[1].to_string()).filter(|id| id.len() >= 32)
}

/// What Claude Code says about a running process in `~/.claude/sessions/<pid>.json`:
/// its current session id and "busy"/"idle". Every session writes it, the VS Code
/// extension's too (one process per conversation tab), so no guessing from transcripts.
fn session_file(pid: u32) -> Option<(String, Option<String>)> {
    let v = crate::scheduler::read_json(&crate::claude_home().join("sessions").join(format!("{pid}.json")))?;
    if v.get("pid").and_then(Value::as_u64) != Some(pid as u64) {
        return None;
    }
    let id = v.get("sessionId")?.as_str()?.to_string();
    Some((id, v.get("status").and_then(Value::as_str).map(String::from)))
}

fn mtime_ms(p: &Path) -> Option<i64> {
    p.metadata().ok()?.modified().ok()?.duration_since(UNIX_EPOCH).ok().map(|d| d.as_millis() as i64)
}

/// The `n` most recently written transcripts in this folder's project directory,
/// leaving out sessions already known (a connected session in the same folder).
fn newest_transcripts(cwd: &str, n: usize, now: i64, known: &std::collections::HashSet<String>) -> Vec<(PathBuf, i64)> {
    let dir = crate::claude_home().join("projects").join(crate::transcript::escape(cwd));
    let mut all: Vec<(PathBuf, i64)> = std::fs::read_dir(&dir)
        .into_iter()
        .flatten()
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "jsonl"))
        .filter(|p| p.file_stem().is_none_or(|s| !known.contains(s.to_string_lossy().as_ref())))
        .filter_map(|p| mtime_ms(&p).map(|m| (p, m)))
        .filter(|(_, m)| now - m < LIVE_MS)
        .collect();
    all.sort_by_key(|(_, m)| -m);
    all.truncate(n);
    all
}

fn text_of(content: &Value) -> Option<String> {
    match content {
        Value::String(s) => Some(s.clone()),
        Value::Array(blocks) => blocks.iter().find(|b| b.get("type").and_then(Value::as_str) == Some("text")).and_then(|b| b.get("text")?.as_str().map(String::from)),
        _ => None,
    }
}

fn clip(s: &str, n: usize) -> String {
    let s = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if s.chars().count() <= n {
        s
    } else {
        format!("{}…", s.chars().take(n - 1).collect::<String>().trim_end())
    }
}

/// What a transcript's tail says: (branch, last prompt, last reply, mid-turn).
pub fn read_tail(lines: &[&str]) -> (Option<String>, Option<String>, Option<String>, bool) {
    let (mut branch, mut prompt, mut reply, mut open) = (None, None, None, None);
    for line in lines.iter().rev() {
        let Ok(e) = serde_json::from_str::<Value>(line) else { continue };
        if e.get("isSidechain").and_then(Value::as_bool) == Some(true) || e.get("isMeta").and_then(Value::as_bool) == Some(true) {
            continue;
        }
        if branch.is_none() {
            branch = e.get("gitBranch").and_then(Value::as_str).filter(|b| !b.is_empty()).map(String::from);
        }
        let kind = e.get("type").and_then(Value::as_str).unwrap_or("");
        let content = e.pointer("/message/content");
        let tool_result = content.and_then(Value::as_array).is_some_and(|a| a.iter().any(|b| b.get("type").and_then(Value::as_str) == Some("tool_result")));
        if open.is_none() && (kind == "user" || kind == "assistant") {
            // The turn is still open while the last word is the person's, a tool's
            // result, or a tool call; it closed with a reply that called no tool.
            let calls_tool = content.and_then(Value::as_array).is_some_and(|a| a.iter().any(|b| b.get("type").and_then(Value::as_str) == Some("tool_use")));
            open = Some(kind == "user" || calls_tool);
        }
        if kind == "assistant" && reply.is_none() {
            reply = content.and_then(text_of).filter(|t| !t.trim().is_empty()).map(|t| clip(&t, 200));
        }
        if kind == "user" && prompt.is_none() && !tool_result {
            prompt = content.and_then(text_of).filter(|t| !t.trim_start().starts_with('<')).map(|t| clip(&t, 120));
        }
        if branch.is_some() && prompt.is_some() && reply.is_some() && open.is_some() {
            break;
        }
    }
    (branch, prompt, reply, open.unwrap_or(false))
}

fn plugin_installed() -> bool {
    let plugins = crate::claude_home().join("plugins").join("installed_plugins.json");
    let installed = crate::scheduler::read_json(&plugins).is_some_and(|v| v.get("plugins").unwrap_or(&v).get("openadmiral@openadmiral").is_some());
    let disabled = crate::scheduler::read_json(&crate::claude_home().join("settings.json"))
        .and_then(|s| s.pointer("/enabledPlugins/openadmiral@openadmiral").and_then(Value::as_bool))
        == Some(false);
    installed && !disabled
}

/// Sessions running without the plugin, and whether the plugin is installed at all.
#[tauri::command]
pub async fn discover_sessions() -> Discovery {
    tauri::async_runtime::spawn_blocking(discover).await.unwrap_or(Discovery { plugin_installed: true, sessions: vec![] })
}

fn discover() -> Discovery {
    let plugin = plugin_installed();
    if crate::preview() {
        // Screenshots: OPENADMIRAL_UNPLUGGED=1 adds a VS Code session without the plugin,
        // OPENADMIRAL_NO_PLUGIN=1 says the plugin is not installed.
        let now = crate::underway::now_ms();
        let sessions = if std::env::var_os("OPENADMIRAL_UNPLUGGED").is_some() {
            vec![Discovered {
                session_id: "0000ff01-0000-4000-8000-0000000000ff".into(),
                cwd: "/Users/alex/code/billing".into(),
                project: "billing".into(),
                branch: Some("fix/invoice-rounding".into()),
                status: "working",
                last_prompt: Some("Round invoice totals per line, not per invoice".into()),
                last_reply: None,
                updated_at: now - 4_000,
                via: "VS Code".into(),
            }]
        } else {
            vec![]
        };
        return Discovery { plugin_installed: std::env::var_os("OPENADMIRAL_NO_PLUGIN").is_none(), sessions };
    }
    let now = crate::underway::now_ms();
    let procs = ps();
    let by_pid: HashMap<u32, &Proc> = procs.iter().map(|p| (p.pid, p)).collect();
    let sessions_procs: Vec<&Proc> = procs.iter().filter(|p| is_session(&p.command)).collect();
    let dirs = cwds(&sessions_procs.iter().map(|p| p.pid).collect::<Vec<_>>());
    // Known already: sessions whose plugin writes a fresh file. Those that are not
    // background jobs run as one of the processes found here, in their folder.
    let fresh: Vec<(String, String)> = crate::read_dir_json(&crate::admiral_dir().join("sessions"))
        .iter()
        .filter(|s| s.get("updatedAt").and_then(Value::as_f64).is_some_and(|u| now - (u as i64) < 90_000))
        .filter_map(|s| Some((s.get("sessionId")?.as_str()?.to_string(), s.get("cwd")?.as_str()?.to_string())))
        .collect();
    let known: std::collections::HashSet<String> = fresh.iter().map(|(id, _)| id.clone()).collect();
    let background: std::collections::HashSet<String> = crate::claude_agents()
        .and_then(|v| v.as_array().cloned())
        .unwrap_or_default()
        .iter()
        .filter_map(|r| r.get("sessionId").and_then(Value::as_str).map(String::from))
        .collect();
    let connected_here = |cwd: &str| fresh.iter().filter(|(id, c)| c == cwd && !background.contains(id)).count();
    // Processes per folder: each takes one of that folder's newest transcripts.
    let mut by_cwd: HashMap<String, Vec<&Proc>> = HashMap::new();
    for p in &sessions_procs {
        if let Some(cwd) = dirs.get(&p.pid) {
            by_cwd.entry(cwd.clone()).or_default().push(p);
        }
    }
    let mut out = vec![];
    for (cwd, ps) in by_cwd {
        let mut pinned: Vec<(PathBuf, i64, &Proc)> = vec![];
        let mut rest: Vec<&Proc> = vec![];
        let mut busy: HashMap<u32, bool> = HashMap::new();
        for p in &ps {
            let told = session_file(p.pid);
            if let Some((_, Some(status))) = &told {
                busy.insert(p.pid, status == "busy");
            }
            let id = told.as_ref().map(|(id, _)| id.clone()).or_else(|| session_arg(&p.command));
            let path = id.and_then(|id| crate::transcript::locate(&id, &cwd));
            match path.and_then(|path| mtime_ms(&path).map(|m| (path, m))) {
                Some((path, m)) => pinned.push((path, m, p)),
                // A session that says its id but has no transcript yet (a new, empty
                // tab) has nothing to show; only older versions without the file guess.
                None if told.is_some() => {}
                None => rest.push(p),
            }
        }
        let taken: Vec<PathBuf> = pinned.iter().map(|(p, _, _)| p.clone()).collect();
        let free: Vec<(PathBuf, i64)> = newest_transcripts(&cwd, rest.len().saturating_sub(connected_here(&cwd)), now, &known).into_iter().filter(|(p, _)| !taken.contains(p)).collect();
        let found = pinned.into_iter().chain(free.into_iter().zip(rest).map(|((path, m), p)| (path, m, p)));
        for (path, mtime, p) in found {
            let id = path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
            if id.is_empty() || known.contains(&id) {
                continue;
            }
            // Attachment lines (skill and tool lists) are large: when the last prompt is
            // not in the usual tail, look further back once.
            let read = |bytes| {
                let text = crate::resume::tail_bytes(&path, bytes).unwrap_or_default();
                read_tail(&text.lines().collect::<Vec<_>>())
            };
            let mut found = read(256 * 1024);
            if found.1.is_none() {
                found = read(4 * 1024 * 1024);
            }
            let (branch, last_prompt, last_reply, open) = found;
            // An idle session keeps writing housekeeping lines, so the file's age says
            // nothing: a turn is under way while its last word is not a final reply.
            let working = busy.get(&p.pid).copied().unwrap_or(open && now - mtime < STUCK_MS);
            out.push(Discovered {
                session_id: id,
                project: Path::new(&cwd).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| cwd.clone()),
                cwd: cwd.clone(),
                branch,
                status: if working { "working" } else { "idle" },
                last_prompt,
                last_reply,
                updated_at: mtime,
                via: label(&via(p.pid, &by_pid), &p.command),
            });
        }
    }
    out.sort_by(|a, b| a.project.cmp(&b.project).then(b.updated_at.cmp(&a.updated_at)));
    Discovery { plugin_installed: plugin, sessions: out }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn only_session_processes_count() {
        assert!(is_session("/Users/x/.vscode/extensions/anthropic.claude-code-2.1.0/resources/native-binary/claude --output-format stream-json --verbose"));
        assert!(is_session("claude"));
        assert!(is_session("/Users/x/.local/bin/claude --model opus"));
        assert!(!is_session("claude bg-spare --bg-spare /tmp/x.sock"));
        assert!(!is_session("/Users/x/.local/bin/claude daemon run"));
        assert!(!is_session("claude attach aee3888e"));
        assert!(!is_session("/usr/bin/grep claude"));
        assert!(!is_session("/Users/x/.local/bin/claude --chrome-native-host"));
        assert_eq!(label("VS Code", "/Users/x/.vscode/extensions/anthropic.claude-code-2/resources/native-binary/claude --output-format stream-json"), "VS Code");
        assert_eq!(label("VS Code", "claude"), "VS Code terminal");
        assert_eq!(label("iTerm", "claude"), "iTerm");
        assert_eq!(session_arg("claude --resume 0123456789abcdef0123456789abcdef0123"), Some("0123456789abcdef0123456789abcdef0123".into()));
        assert_eq!(session_arg("claude -r short"), None);
    }

    #[test]
    fn the_tail_gives_branch_prompt_reply_and_whether_the_turn_is_open() {
        let prompt = json!({ "type": "user", "gitBranch": "feat/x", "message": { "role": "user", "content": "Add the endpoint" } }).to_string();
        let call = json!({ "type": "assistant", "gitBranch": "feat/x", "message": { "content": [{ "type": "text", "text": "Reading the routes." }, { "type": "tool_use", "name": "Read" }] } }).to_string();
        let result = json!({ "type": "user", "message": { "content": [{ "type": "tool_result", "content": "..." }] } }).to_string();
        let done = json!({ "type": "assistant", "message": { "content": [{ "type": "text", "text": "Done: POST /orders is idempotent." }] } }).to_string();
        let (branch, p, r, open) = read_tail(&[&prompt, &call, &result]);
        assert_eq!((branch.as_deref(), p.as_deref(), r.as_deref(), open), (Some("feat/x"), Some("Add the endpoint"), Some("Reading the routes."), true));
        let (_, _, r, open) = read_tail(&[&prompt, &call, &result, &done]);
        assert_eq!((r.as_deref(), open), (Some("Done: POST /orders is idempotent."), false));
    }
}

#[cfg(test)]
mod live {
    /// What this Mac shows right now: cargo test discover::live -- --ignored --nocapture
    #[test]
    #[ignore]
    fn print_discovery() {
        let d = super::discover();
        println!("plugin installed: {}", d.plugin_installed);
        for s in &d.sessions {
            println!("{} {} [{}] via {} · {:?} · {:?}", &s.session_id[..8], s.project, s.status, s.via, s.branch, s.last_prompt);
        }
    }
}

#[cfg(test)]
mod tail_file {
    /// OPENADMIRAL_TAIL=<transcript.jsonl> cargo test discover::tail_file -- --ignored --nocapture
    #[test]
    #[ignore]
    fn print_tail() {
        let p = std::path::PathBuf::from(std::env::var("OPENADMIRAL_TAIL").unwrap());
        let text = crate::resume::tail_bytes(&p, 4 * 1024 * 1024).unwrap();
        let lines: Vec<&str> = text.lines().collect();
        println!("{:?}", super::read_tail(&lines));
    }
}
