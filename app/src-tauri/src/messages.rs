//! What agents said to each other and what they were doing, from the transcripts: every
//! SendMessage, and their tool calls thinned out. Read on demand while a view shows it; each
//! transcript is read once, then only what it grew by.

use serde::Serialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::PathBuf;
use std::sync::Mutex;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    /// The tool call's id: a transcript can carry the same call twice.
    id: String,
    at: u64,
    from: String,
    /// A session id or a name, as the app resolves any address.
    to: String,
    summary: Option<String>,
    text: String,
}

/// One thing a session was doing: enough of them to replay who was working on what.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Work {
    at: u64,
    session: String,
    label: String,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Traffic {
    messages: Vec<Message>,
    work: Vec<Work>,
}

#[derive(Default)]
struct File {
    offset: u64,
    seen: HashSet<String>,
    messages: Vec<Message>,
    work: Vec<Work>,
}

#[derive(Default)]
struct State {
    files: HashMap<PathBuf, File>,
    /// A sender's socket → its name, from the messages received.
    sockets: HashMap<String, String>,
}

static STATE: Mutex<Option<State>> = Mutex::new(None);

/// What a view can show of one message, and how far back.
const TEXT_CHARS: usize = 800;
const KEEP_MS: u64 = 7 * 24 * 60 * 60_000;
const MAX_MESSAGES: usize = 3000;
/// Work kept per session: one call every so often says as much as all of them.
const WORK_EVERY_MS: u64 = 20_000;
/// Replay goes back this far.
const WORK_KEEP_MS: u64 = 12 * 60 * 60_000;

fn body(input: &Value) -> String {
    match input.get("message") {
        Some(Value::String(s)) => s.chars().take(TEXT_CHARS).collect(),
        Some(v) => v.to_string().chars().take(TEXT_CHARS).collect(),
        None => String::new(),
    }
}

/// `<cross-session-message from="uds:/tmp/cc-socks/1.sock" from-name="backend" …>`
fn sender(line: &str) -> Option<(String, String)> {
    let at = line.find("cross-session-message from=")?;
    let rest = line[at..].replace("\\\"", "\"");
    let from = rest.split("from=\"").nth(1)?.split('"').next()?.to_string();
    let name = rest.split("from-name=\"").nth(1)?.split('"').next()?.to_string();
    Some((from, name))
}

/// What a tool call says it is doing: its description, a file, a pattern, else the tool.
fn work_label(block: &Value) -> Option<String> {
    let name = block.get("name")?.as_str()?;
    if name == "SendMessage" || name.ends_with("__progress") {
        return None;
    }
    let input = block.get("input");
    let field = |k: &str| input.and_then(|i| i.get(k)).and_then(Value::as_str);
    let label = field("description").map(str::to_owned).or_else(|| field("file_path").or(field("path")).map(|p| p.rsplit('/').next().unwrap_or(p).to_owned())).or_else(|| field("pattern").map(str::to_owned));
    Some(label.unwrap_or_else(|| name.to_owned()).chars().take(80).collect())
}

/// The SendMessage calls in one transcript row, with their time.
fn calls(row: &Value) -> Vec<(String, String, Option<String>, String)> {
    let Some(blocks) = row.pointer("/message/content").and_then(Value::as_array) else { return vec![] };
    blocks
        .iter()
        .filter(|b| b.get("type").and_then(Value::as_str) == Some("tool_use") && b.get("name").and_then(Value::as_str) == Some("SendMessage"))
        .filter_map(|b| {
            let input = b.get("input")?;
            Some((b.get("id")?.as_str()?.to_string(), input.get("to")?.as_str()?.to_string(), input.get("summary").and_then(Value::as_str).map(str::to_owned), body(input)))
        })
        .collect()
}

fn read(path: &PathBuf, session: &str, file: &mut File, sockets: &mut HashMap<String, String>) {
    let Ok(mut f) = std::fs::File::open(path) else { return };
    if f.seek(SeekFrom::Start(file.offset)).is_err() {
        return;
    }
    let mut lines = BufReader::new(f);
    let mut line = String::new();
    while let Ok(n) = lines.read_line(&mut line) {
        // End of file, or a row still being written: read it next time.
        if n == 0 || !line.ends_with('\n') {
            break;
        }
        file.offset += n as u64;
        if line.contains("cross-session-message") {
            if let Some((from, name)) = sender(&line) {
                sockets.insert(from, name);
            }
        }
        if line.contains("\"tool_use\"") {
            if let Ok(row) = serde_json::from_str::<Value>(&line) {
                // A call is written once without a time and once with it.
                let at = row.get("timestamp").and_then(Value::as_str).and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok()).map(|t| t.timestamp_millis() as u64);
                if let Some(at) = at {
                    for (id, to, summary, text) in calls(&row) {
                        if file.seen.insert(id.clone()) {
                            file.messages.push(Message { id, at, from: session.to_string(), to, summary, text });
                        }
                    }
                    let blocks = row.pointer("/message/content").and_then(Value::as_array);
                    for label in blocks.into_iter().flatten().filter(|b| b.get("type").and_then(Value::as_str) == Some("tool_use")).filter_map(work_label) {
                        if file.work.last().is_none_or(|w| at.saturating_sub(w.at) >= WORK_EVERY_MS) {
                            file.work.push(Work { at, session: session.to_string(), label });
                        }
                    }
                }
            }
        }
        line.clear();
    }
}

/// `uds:/tmp/cc-socks/1881.sock` → the session of process 1881 while it lives, else the name
/// the socket's messages arrived under.
fn resolve(to: &str, sockets: &HashMap<String, String>) -> String {
    let Some(sock) = to.strip_prefix("uds:") else { return to.to_string() };
    let pid = sock.rsplit('/').next().and_then(|f| f.strip_suffix(".sock")).unwrap_or("");
    crate::scheduler::read_json(&crate::claude_home().join("sessions").join(format!("{pid}.json")))
        .and_then(|f| f.get("sessionId").and_then(Value::as_str).map(str::to_owned))
        .or_else(|| sockets.get(to).cloned())
        .unwrap_or_else(|| to.to_string())
}

/// The last week's messages between sessions and the last hours' work, oldest first.
#[tauri::command]
pub async fn agent_traffic() -> Traffic {
    tauri::async_runtime::spawn_blocking(collect).await.unwrap_or_default()
}

fn collect() -> Traffic {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    let since = now.saturating_sub(KEEP_MS);
    let mut guard = STATE.lock().unwrap_or_else(|e| e.into_inner());
    let state = guard.get_or_insert_with(State::default);
    for s in crate::session_files::all() {
        let (Some(id), Some(cwd)) = (s.get("sessionId").and_then(Value::as_str), s.get("cwd").and_then(Value::as_str)) else { continue };
        if s.get("updatedAt").and_then(Value::as_u64).unwrap_or(0) < since {
            continue;
        }
        let Some(path) = crate::transcript::locate(id, cwd) else { continue };
        let State { files, sockets } = &mut *state;
        read(&path, id, files.entry(path.clone()).or_default(), sockets);
    }
    let mut out: Vec<Message> = state.files.values().flat_map(|f| f.messages.iter().filter(|m| m.at >= since).cloned()).collect();
    out.sort_by_key(|m| m.at);
    if out.len() > MAX_MESSAGES {
        out.drain(..out.len() - MAX_MESSAGES);
    }
    for m in &mut out {
        m.to = resolve(&m.to, &state.sockets);
    }
    let work_since = now.saturating_sub(WORK_KEEP_MS);
    let mut work: Vec<Work> = state.files.values().flat_map(|f| f.work.iter().filter(|w| w.at >= work_since).cloned()).collect();
    work.sort_by_key(|w| w.at);
    Traffic { messages: out, work }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn finds_the_sender_of_a_received_message() {
        let line = r#"{"content":"<cross-session-message from=\"uds:/tmp/cc-socks/9.sock\" from-name=\"backend\" from-mode=\"x\">hi"}"#;
        assert_eq!(sender(line), Some(("uds:/tmp/cc-socks/9.sock".into(), "backend".into())));
    }

    #[test]
    fn reads_a_transcript_once_and_each_call_once() {
        let dir = std::env::temp_dir().join(format!("oa-messages-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t.jsonl");
        let call = json!({ "type": "tool_use", "id": "c1", "name": "SendMessage", "input": { "to": "backend", "summary": "s", "message": "hello" } });
        let row = |t: Option<&str>| {
            let mut r = json!({ "message": { "content": [call.clone()] } });
            if let Some(t) = t {
                r["timestamp"] = json!(t);
            }
            r.to_string()
        };
        std::fs::write(&path, format!("{}\n{}\n{}\n", row(None), row(Some("2026-10-31T10:00:00Z")), row(Some("2026-10-31T10:00:01Z")))).unwrap();
        let (mut file, mut sockets) = (File::default(), HashMap::new());
        read(&path, "s1", &mut file, &mut sockets);
        assert_eq!(file.messages.len(), 1);
        assert_eq!((file.messages[0].to.as_str(), file.messages[0].text.as_str()), ("backend", "hello"));
        let before = file.offset;
        read(&path, "s1", &mut file, &mut sockets);
        assert_eq!((file.offset, file.messages.len()), (before, 1));
        assert!(file.work.is_empty(), "a message is not work");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_socket_with_no_session_goes_by_the_name_it_wrote_under() {
        let sockets = HashMap::from([("uds:/tmp/cc-socks/999999.sock".to_string(), "backend".to_string())]);
        assert_eq!(resolve("uds:/tmp/cc-socks/999999.sock", &sockets), "backend");
        assert_eq!(resolve("dashboard", &sockets), "dashboard");
    }

    #[test]
    fn says_what_a_tool_call_is_doing() {
        let label = |b: Value| work_label(&b);
        assert_eq!(label(json!({ "name": "Bash", "input": { "description": "Run the tests" } })).as_deref(), Some("Run the tests"));
        assert_eq!(label(json!({ "name": "Edit", "input": { "file_path": "/a/b/c.ts" } })).as_deref(), Some("c.ts"));
        assert_eq!(label(json!({ "name": "TaskList", "input": {} })).as_deref(), Some("TaskList"));
        assert_eq!(label(json!({ "name": "mcp__openadmiral__progress", "input": {} })), None);
    }
}
