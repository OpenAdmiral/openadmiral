//! A session's conversation, read from its transcript (`~/.claude/projects/<escaped
//! cwd>/<sessionId>.jsonl`) and tailed as it grows: one turn per prompt, plus the
//! task list replayed from TaskCreate / TaskUpdate / TodoWrite.

use notify::{RecursiveMode, Watcher};
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};

/// Replies are long; the panel trims them anyway. Enough for "show more".
const REPLY_MAX: usize = 24_000;
/// Tool input and result snippets: enough to recognise a call, not the whole payload.
const SNIPPET_MAX: usize = 700;

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Tool {
    name: String,
    summary: String,
    at: Option<String>,
    /// The call's input, as compact JSON, cut short.
    #[serde(skip_serializing_if = "Option::is_none")]
    input: Option<String>,
    /// The start of what it returned, once its result row arrives.
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<String>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    is_error: bool,
    #[serde(skip)]
    id: String,
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Turn {
    index: usize,
    prompt: String,
    /// "prompt", "command" (a /slash command) or "shell" (a `!` command).
    kind: String,
    at: Option<String>,
    end_at: Option<String>,
    reply: String,
    tools: Vec<Tool>,
    /// Set when the prompt came from a plugin rather than the keyboard ("queue" for OpenAdmiral's own queue).
    #[serde(skip_serializing_if = "Option::is_none")]
    source: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    id: String,
    subject: String,
    status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    active_form: Option<String>,
}

#[derive(Default)]
struct Parsed {
    turns: Vec<Turn>,
    tasks: Vec<Task>,
    tasks_at: Option<String>,
    /// tool_use id → TaskCreate input, until its result names the task id.
    pending_creates: HashMap<String, Value>,
    offset: u64,
    partial: Vec<u8>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Update {
    session_id: String,
    /// Turns from this index on replace what the UI holds.
    from: usize,
    turns: Vec<Turn>,
    tasks: Vec<Task>,
    tasks_at: Option<String>,
    found: bool,
}

struct Tail {
    parsed: Parsed,
    path: Option<PathBuf>,
    _watcher: Option<notify::RecommendedWatcher>,
}

#[derive(Default)]
pub struct Transcripts(Mutex<HashMap<String, Arc<Mutex<Tail>>>>);

fn escape(path: &str) -> String {
    path.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect()
}

/// The transcript file: the escaped cwd's folder first, else any project folder holding it.
pub fn locate(session_id: &str, cwd: &str) -> Option<PathBuf> {
    let projects = crate::claude_home().join("projects");
    let direct = projects.join(escape(cwd)).join(format!("{session_id}.jsonl"));
    if direct.exists() {
        return Some(direct);
    }
    std::fs::read_dir(&projects).ok()?.filter_map(|e| e.ok()).map(|e| e.path().join(format!("{session_id}.jsonl"))).find(|p| p.exists())
}

fn truncate(s: &str, n: usize) -> String {
    let s = s.trim();
    if s.chars().count() <= n { s.to_string() } else { format!("{}…", s.chars().take(n).collect::<String>()) }
}

fn between<'a>(s: &'a str, open: &str, close: &str) -> Option<&'a str> {
    let a = s.find(open)? + open.len();
    let b = s[a..].find(close)? + a;
    Some(&s[a..b])
}

/// Drops `<system-reminder>…</system-reminder>` blocks the harness folds into prompts.
fn strip_reminders(text: &str) -> String {
    let mut out = String::new();
    let mut rest = text;
    while let Some(i) = rest.find("<system-reminder") {
        out.push_str(&rest[..i]);
        match rest[i..].find("</system-reminder>") {
            Some(j) => rest = &rest[i + j + "</system-reminder>".len()..],
            None => {
                rest = "";
                break;
            }
        }
    }
    out.push_str(rest);
    out.trim().to_string()
}

/// A prompt as the person typed it, or None for rows that are not prompts.
fn prompt_of(text: &str) -> Option<(String, &'static str)> {
    let t = text.trim_start();
    if t.starts_with("<command-name>") {
        let name = between(t, "<command-name>", "</command-name>").unwrap_or("").trim().to_string();
        let args = between(t, "<command-args>", "</command-args>").unwrap_or("").trim().to_string();
        let name = if name.starts_with('/') { name } else { format!("/{name}") };
        return Some((if args.is_empty() { name } else { format!("{name} {args}") }, "command"));
    }
    if t.starts_with("<bash-input>") {
        return Some((format!("! {}", between(t, "<bash-input>", "</bash-input>").unwrap_or("").trim()), "shell"));
    }
    // Command output, task notifications and other wrappers are not prompts.
    if t.starts_with('<') && (t.starts_with("<local-command") || t.starts_with("<bash-std") || t.starts_with("<task-notification") || t.starts_with("<command-message>")) {
        return None;
    }
    let clean = strip_reminders(text);
    if clean.is_empty() { None } else { Some((clean, "prompt")) }
}

/// A short description of a tool call, like the mod's activity lines.
fn tool_summary(name: &str, input: &Value) -> String {
    let s = |k: &str| input.get(k).and_then(Value::as_str).unwrap_or("");
    let path = |p: &str| p.rsplit('/').take(2).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("/");
    let raw = match name {
        "Bash" => if s("description").is_empty() { s("command").to_string() } else { s("description").to_string() },
        "Read" | "Edit" | "Write" | "NotebookEdit" => path(s("file_path")),
        "Grep" | "Glob" => s("pattern").to_string(),
        "Agent" | "Task" => s("description").to_string(),
        "WebFetch" => s("url").to_string(),
        "WebSearch" => s("query").to_string(),
        "Skill" => s("skill").to_string(),
        "TaskCreate" => s("subject").to_string(),
        "TaskUpdate" => format!("#{} {}", s("taskId"), s("status")),
        "SendMessage" => format!("→ {}", input.get("to").map(|v| v.as_str().map(str::to_string).unwrap_or(v.to_string())).unwrap_or_default()),
        _ => input.as_object().and_then(|o| o.values().find_map(|v| v.as_str().map(str::to_string))).unwrap_or_default(),
    };
    truncate(&raw.replace('\n', " "), 90)
}

fn apply_task_tool(p: &mut Parsed, name: &str, id: &str, input: &Value, at: Option<&str>) {
    let s = |k: &str| input.get(k).and_then(Value::as_str).map(str::to_string);
    match name {
        "TaskCreate" => {
            p.pending_creates.insert(id.to_string(), input.clone());
        }
        "TaskUpdate" => {
            let Some(task_id) = s("taskId") else { return };
            if s("status").as_deref() == Some("deleted") {
                p.tasks.retain(|t| t.id != task_id);
            } else if let Some(t) = p.tasks.iter_mut().find(|t| t.id == task_id) {
                if let Some(v) = s("status") { t.status = v; }
                if let Some(v) = s("subject") { t.subject = v; }
                if let Some(v) = s("activeForm") { t.active_form = Some(v); }
            }
            p.tasks_at = at.map(str::to_string);
        }
        "TodoWrite" => {
            let todos = input.get("todos").and_then(Value::as_array).cloned().unwrap_or_default();
            p.tasks = todos
                .iter()
                .enumerate()
                .map(|(i, t)| Task {
                    id: format!("todo-{i}"),
                    subject: t.get("content").and_then(Value::as_str).unwrap_or("").to_string(),
                    status: t.get("status").and_then(Value::as_str).unwrap_or("pending").to_string(),
                    active_form: t.get("activeForm").and_then(Value::as_str).map(str::to_string),
                })
                .collect();
            p.tasks_at = at.map(str::to_string);
        }
        _ => {}
    }
}

/// Applies one transcript row; answers the index of the first turn it changed.
fn apply(p: &mut Parsed, r: &Value) -> Option<usize> {
    if r.get("isSidechain").and_then(Value::as_bool) == Some(true) || r.get("isMeta").and_then(Value::as_bool) == Some(true) {
        return None;
    }
    let at = r.get("timestamp").and_then(Value::as_str);
    let msg = r.get("message")?;
    let content = msg.get("content")?;
    match r.get("type").and_then(Value::as_str)? {
        "user" => {
            // Tool results: attached to their call; a TaskCreate's names the task it made.
            let mut result_turn: Option<usize> = None;
            if let Some(blocks) = content.as_array() {
                for b in blocks.iter().filter(|b| b.get("type").and_then(Value::as_str) == Some("tool_result")) {
                    let tool_id = b.get("tool_use_id").and_then(Value::as_str).unwrap_or("");
                    let text = match b.get("content") {
                        Some(Value::String(s)) => s.clone(),
                        Some(Value::Array(parts)) => parts.iter().filter_map(|x| x.get("text").and_then(Value::as_str)).collect::<Vec<_>>().join("\n"),
                        _ => String::new(),
                    };
                    let is_error = b.get("is_error").and_then(Value::as_bool) == Some(true);
                    // Results arrive in the turn their call was made in: search back from the newest turn.
                    'find: for turn in p.turns.iter_mut().rev().take(3) {
                        for tool in turn.tools.iter_mut().rev() {
                            if tool.id == tool_id {
                                tool.result = Some(truncate(&text, SNIPPET_MAX));
                                tool.is_error = is_error;
                                result_turn = Some(result_turn.map_or(turn.index, |t: usize| t.min(turn.index)));
                                break 'find;
                            }
                        }
                    }
                    if let Some(input) = p.pending_creates.remove(tool_id) {
                        let task_id = r.pointer("/toolUseResult/task/id").and_then(Value::as_str);
                        if let Some(task_id) = task_id {
                            let s = |k: &str| input.get(k).and_then(Value::as_str).map(str::to_string);
                            p.tasks.push(Task { id: task_id.to_string(), subject: s("subject").unwrap_or_default(), status: "pending".into(), active_form: s("activeForm") });
                            p.tasks_at = at.map(str::to_string);
                        }
                    }
                }
            }
            // Typed prompts, and prompts a plugin submitted as the person (OpenAdmiral's Up next queue).
            let kind = r.pointer("/origin/kind").and_then(Value::as_str);
            let as_user = r.pointer("/origin/asUser").and_then(Value::as_bool) == Some(true);
            let source = match kind {
                None | Some("human") => None,
                Some("plugin") if as_user => Some(match r.pointer("/origin/name").and_then(Value::as_str) {
                    Some("openadmiral") => "queue".to_string(),
                    other => other.unwrap_or("plugin").to_string(),
                }),
                _ => return result_turn,
            };
            let text = match content {
                Value::String(s) => s.clone(),
                Value::Array(blocks) => blocks.iter().filter_map(|b| (b.get("type").and_then(Value::as_str) == Some("text")).then(|| b.get("text").and_then(Value::as_str)).flatten()).collect::<Vec<_>>().join("\n"),
                _ => String::new(),
            };
            let Some((prompt, kind)) = prompt_of(&text) else { return result_turn };
            let index = p.turns.len();
            p.turns.push(Turn { index, prompt, kind: kind.into(), at: at.map(str::to_string), end_at: at.map(str::to_string), source, ..Default::default() });
            Some(index)
        }
        "assistant" => {
            if msg.get("model").and_then(Value::as_str) == Some("<synthetic>") {
                return None;
            }
            let blocks = content.as_array()?;
            for b in blocks {
                if b.get("type").and_then(Value::as_str) == Some("tool_use") {
                    let name = b.get("name").and_then(Value::as_str).unwrap_or("");
                    let id = b.get("id").and_then(Value::as_str).unwrap_or("");
                    let input = b.get("input").cloned().unwrap_or(Value::Null);
                    apply_task_tool(p, name, id, &input, at);
                }
            }
            let turn = p.turns.last_mut()?;
            for b in blocks {
                match b.get("type").and_then(Value::as_str) {
                    Some("text") => {
                        let t = b.get("text").and_then(Value::as_str).unwrap_or("").trim();
                        if !t.is_empty() && turn.reply.len() < REPLY_MAX {
                            if !turn.reply.is_empty() { turn.reply.push_str("\n\n"); }
                            turn.reply.push_str(t);
                            if turn.reply.len() > REPLY_MAX {
                                turn.reply = truncate(&turn.reply, REPLY_MAX);
                            }
                        }
                    }
                    Some("tool_use") => {
                        let name = b.get("name").and_then(Value::as_str).unwrap_or("").to_string();
                        let input = b.get("input").unwrap_or(&Value::Null);
                        let summary = tool_summary(&name, input);
                        let id = b.get("id").and_then(Value::as_str).unwrap_or("").to_string();
                        let input = Some(truncate(&input.to_string(), SNIPPET_MAX));
                        turn.tools.push(Tool { name, summary, at: at.map(str::to_string), input, result: None, is_error: false, id });
                    }
                    _ => {}
                }
            }
            turn.end_at = at.map(str::to_string).or(turn.end_at.take());
            Some(turn.index)
        }
        _ => None,
    }
}

/// Reads what was appended since the last read; answers the first changed turn.
fn read_more(p: &mut Parsed, path: &Path) -> Option<usize> {
    let mut f = std::fs::File::open(path).ok()?;
    let len = f.metadata().ok()?.len();
    if len < p.offset {
        // Rewritten from scratch (compaction rewrites nothing, but be safe).
        *p = Parsed::default();
    }
    f.seek(SeekFrom::Start(p.offset)).ok()?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf).ok()?;
    p.offset += buf.len() as u64;
    let mut data = std::mem::take(&mut p.partial);
    data.extend_from_slice(&buf);
    let mut first: Option<usize> = None;
    let mut start = 0;
    for (i, b) in data.iter().enumerate() {
        if *b == b'\n' {
            if let Ok(v) = serde_json::from_slice::<Value>(&data[start..i]) {
                if let Some(idx) = apply(p, &v) {
                    first = Some(first.map_or(idx, |f: usize| f.min(idx)));
                }
            }
            start = i + 1;
        }
    }
    // A line still being written waits for the rest.
    p.partial = data[start..].to_vec();
    first
}

fn update(session_id: &str, tail: &Tail, from: usize) -> Update {
    Update {
        session_id: session_id.to_string(),
        from,
        turns: tail.parsed.turns.get(from..).map(<[Turn]>::to_vec).unwrap_or_default(),
        tasks: tail.parsed.tasks.clone(),
        tasks_at: tail.parsed.tasks_at.clone(),
        found: tail.path.is_some(),
    }
}

/// Starts following a session's transcript: answers everything so far, then
/// emits `transcript://update` as it grows.
#[tauri::command]
pub async fn transcript_open(app: AppHandle, session_id: String, cwd: String) -> Result<Update, String> {
    let state = app.state::<Transcripts>();
    if let Some(tail) = state.0.lock().unwrap().get(&session_id).cloned() {
        return Ok(update(&session_id, &tail.lock().unwrap(), 0));
    }
    let path = locate(&session_id, &cwd);
    let tail = Arc::new(Mutex::new(Tail { parsed: Parsed::default(), path: path.clone(), _watcher: None }));
    if let Some(path) = path.clone() {
        // The first read of a long transcript takes a moment: off the main thread.
        let t = tail.clone();
        let p = path.clone();
        tauri::async_runtime::spawn_blocking(move || {
            read_more(&mut t.lock().unwrap().parsed, &p);
        })
        .await
        .map_err(|e| e.to_string())?;
        let (tx, rx) = mpsc::channel();
        if let Ok(mut watcher) = notify::recommended_watcher(tx) {
            if watcher.watch(&path, RecursiveMode::NonRecursive).is_ok() {
                tail.lock().unwrap()._watcher = Some(watcher);
                let (t, app2, sid) = (tail.clone(), app.clone(), session_id.clone());
                std::thread::spawn(move || {
                    while rx.recv().is_ok() {
                        while rx.recv_timeout(Duration::from_millis(150)).is_ok() {}
                        let mut guard = t.lock().unwrap();
                        let Some(path) = guard.path.clone() else { break };
                        if let Some(from) = read_more(&mut guard.parsed, &path) {
                            let _ = app2.emit("transcript://update", update(&sid, &guard, from));
                        } else if guard._watcher.is_none() {
                            break;
                        }
                    }
                });
            }
        }
    }
    let first = update(&session_id, &tail.lock().unwrap(), 0);
    state.0.lock().unwrap().insert(session_id, tail);
    Ok(first)
}

/// Stops following it; the watcher's thread ends with its channel.
#[tauri::command]
pub fn transcript_close(transcripts: State<'_, Transcripts>, session_id: String) {
    if let Some(tail) = transcripts.0.lock().unwrap().remove(&session_id) {
        tail.lock().unwrap()._watcher = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(lines: &[Value]) -> Parsed {
        let mut p = Parsed::default();
        for l in lines {
            apply(&mut p, l);
        }
        p
    }

    #[test]
    fn prompts_replies_tools_and_tasks() {
        let p = run(&[
            serde_json::json!({"type":"user","origin":{"kind":"human"},"timestamp":"t1","message":{"content":"Fix the build<system-reminder>ignore</system-reminder>"}}),
            serde_json::json!({"type":"assistant","timestamp":"t2","message":{"content":[{"type":"text","text":"On it."},{"type":"tool_use","id":"a","name":"TaskCreate","input":{"subject":"Run tests","activeForm":"Running tests"}}]}}),
            serde_json::json!({"type":"user","timestamp":"t3","toolUseResult":{"task":{"id":"7","subject":"Run tests"}},"message":{"content":[{"type":"tool_result","tool_use_id":"a","content":"ok"}]}}),
            serde_json::json!({"type":"assistant","timestamp":"t4","message":{"content":[{"type":"tool_use","id":"b","name":"TaskUpdate","input":{"taskId":"7","status":"in_progress"}},{"type":"tool_use","id":"c","name":"Bash","input":{"command":"pnpm test","description":"Run the suite"}}]}}),
            serde_json::json!({"type":"user","origin":{"kind":"task-notification"},"message":{"content":"<task-notification>done</task-notification>"}}),
            serde_json::json!({"type":"user","isMeta":true,"message":{"content":"meta"}}),
            serde_json::json!({"type":"user","origin":{"kind":"human"},"message":{"content":"<command-name>/compact</command-name><command-args>keep the plan</command-args>"}}),
            serde_json::json!({"type":"user","origin":{"kind":"plugin","name":"openadmiral","asUser":true},"message":{"content":"queued prompt"}}),
            serde_json::json!({"type":"user","origin":{"kind":"plugin","name":"other"},"message":{"content":"not a prompt"}}),
        ]);
        assert_eq!(p.turns.len(), 3);
        assert_eq!(p.turns[2].source.as_deref(), Some("queue"));
        assert_eq!(p.turns[0].prompt, "Fix the build");
        assert_eq!(p.turns[0].reply, "On it.");
        assert_eq!(p.turns[0].tools.len(), 3);
        assert_eq!(p.turns[0].tools[2].summary, "Run the suite");
        assert_eq!(p.turns[0].tools[0].result.as_deref(), Some("ok"));
        assert!(p.turns[0].tools[0].input.as_deref().unwrap_or("").contains("Run tests"));
        assert_eq!(p.turns[0].end_at.as_deref(), Some("t4"));
        assert_eq!(p.turns[1].prompt, "/compact keep the plan");
        assert_eq!(p.turns[1].kind, "command");
        assert_eq!(p.tasks.len(), 1);
        assert_eq!(p.tasks[0].id, "7");
        assert_eq!(p.tasks[0].status, "in_progress");
    }

    #[test]
    fn partial_lines_wait_for_the_rest() {
        let dir = std::env::temp_dir().join(format!("admiral-transcript-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t.jsonl");
        let a = serde_json::json!({"type":"user","origin":{"kind":"human"},"message":{"content":"first"}}).to_string();
        std::fs::write(&path, format!("{a}\n{{\"type\":\"us")).unwrap();
        let mut p = Parsed::default();
        assert_eq!(read_more(&mut p, &path), Some(0));
        let mut f = std::fs::OpenOptions::new().append(true).open(&path).unwrap();
        std::io::Write::write_all(&mut f, b"er\",\"origin\":{\"kind\":\"human\"},\"message\":{\"content\":\"second\"}}\n").unwrap();
        assert_eq!(read_more(&mut p, &path), Some(1));
        assert_eq!(p.turns[1].prompt, "second");
        assert_eq!(escape("/Users/alex/dev/ai-tooling"), "-Users-alex-dev-ai-tooling");
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// `OPENADMIRAL_TRANSCRIPT=<path> cargo test --lib real_transcript -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn real_transcript() {
        let path = PathBuf::from(std::env::var("OPENADMIRAL_TRANSCRIPT").unwrap());
        let start = std::time::Instant::now();
        let mut p = Parsed::default();
        read_more(&mut p, &path);
        println!("{} bytes → {} turns, {} tasks in {:?}", p.offset, p.turns.len(), p.tasks.len(), start.elapsed());
        for t in p.turns.iter().rev().take(3) {
            println!("  [{}] {} {:?} · {} tools · reply {} chars", t.index, t.kind, truncate(&t.prompt, 60), t.tools.len(), t.reply.len());
        }
    }
}
