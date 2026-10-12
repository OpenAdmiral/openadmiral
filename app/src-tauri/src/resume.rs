//! Auto-resume: when a turn ends because the connection dropped (a tunnel, a network
//! switch, the Mac sleeping mid-response), Claude Code retries for a while and then
//! gives up, leaving the agent idle with "API Error: Connection…" as its last word.
//! Once the Mac is back online, OpenAdmiral queues a "continue" for each such agent
//! as a Run now item in its Up next (docs/CONTRACT.md "queue/", "Auto-resume"), so the
//! session's own mod submits it like any other queued prompt.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

pub const PROMPT: &str = "The connection dropped before you finished. Continue where you left off.";
/// Back online at least this long before anything is resumed (a flapping link is not).
const STABLE_MS: i64 = 15_000;
/// Errors older than this are history, not a stall (the app was closed meanwhile).
const MAX_AGE_MS: i64 = 6 * 3600 * 1000;
/// A session that keeps failing is resumed at most this often per hour.
const PER_HOUR: usize = 3;
const TAIL_BYTES: u64 = 256 * 1024;

/// An API error worth retrying: the network or the server, not limits, billing or auth.
pub fn is_resumable(entry: &Value) -> bool {
    if entry.get("isApiErrorMessage").and_then(Value::as_bool) != Some(true) {
        return false;
    }
    let error = entry.get("error").and_then(Value::as_str).unwrap_or("");
    if matches!(error, "rate_limit" | "authentication_failed" | "billing_error" | "invalid_request" | "max_output_tokens") {
        return false;
    }
    let text = entry
        .pointer("/message/content")
        .and_then(Value::as_array)
        .and_then(|c| c.iter().find_map(|b| b.get("text").and_then(Value::as_str)))
        .unwrap_or("");
    const SIGNS: [&str; 8] = ["Connection", "connection", "timed out", "went to sleep", "fetch failed", "ECONNRESET", "socket hang up", "verloaded"];
    error == "server_error" || SIGNS.iter().any(|s| text.contains(s))
}

/// The last thing that happened in the main conversation, if it is a resumable
/// error: (its uuid, when, epoch ms). Lines are a transcript's tail, oldest first.
pub fn stalled_on(lines: &[&str]) -> Option<(String, i64)> {
    for line in lines.iter().rev() {
        let Ok(e) = serde_json::from_str::<Value>(line) else { continue };
        let kind = e.get("type").and_then(Value::as_str).unwrap_or("");
        let side = e.get("isSidechain").and_then(Value::as_bool) == Some(true) || e.get("isMeta").and_then(Value::as_bool) == Some(true);
        if side || !(kind == "user" || kind == "assistant") {
            continue;
        }
        if kind == "assistant" && is_resumable(&e) {
            let uuid = e.get("uuid").and_then(Value::as_str)?.to_string();
            let at = e.get("timestamp").and_then(Value::as_str).and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok())?.timestamp_millis();
            return Some((uuid, at));
        }
        return None;
    }
    None
}

pub(crate) fn tail(path: &Path) -> Option<String> {
    let mut f = std::fs::File::open(path).ok()?;
    let len = f.metadata().ok()?.len();
    f.seek(SeekFrom::Start(len.saturating_sub(TAIL_BYTES))).ok()?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf).ok()?;
    Some(String::from_utf8_lossy(&buf).into_owned())
}

fn new_item_id() -> String {
    let mut b = [0u8; 8];
    let _ = std::fs::File::open("/dev/urandom").and_then(|mut f| f.read_exact(&mut b));
    let digits = b"0123456789abcdefghijklmnopqrstuvwxyz";
    format!("q_{}", b.iter().map(|x| digits[(*x as usize) % 36] as char).collect::<String>())
}

/// Puts `text` (a prompt or a slash command) first in the session's Up next, as Run
/// now. Err when the queue is paused (the person paused it: leave the agent alone).
pub fn enqueue(session_id: &str, text: &str, now: i64) -> Result<(), String> {
    if session_id.is_empty() || session_id.contains('/') || session_id.contains("..") {
        return Err("bad session id".into());
    }
    let dir = crate::admiral_dir().join("queue");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{session_id}.json"));
    let mut queue = std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .unwrap_or_else(|| json!({ "v": 1, "paused": false, "items": [] }));
    if queue.get("paused").and_then(Value::as_bool) == Some(true) {
        return Err("queue paused".into());
    }
    if !queue["items"].is_array() {
        queue["items"] = json!([]);
    }
    let items = queue["items"].as_array_mut().unwrap();
    // One is enough: an earlier one that has not run yet will.
    items.retain(|i| i.get("text").and_then(Value::as_str) != Some(text));
    items.insert(0, json!({ "id": new_item_id(), "text": text, "createdAt": now, "runNowAt": now }));
    queue["v"] = json!(1);
    queue["updatedAt"] = json!(now);
    crate::scheduler::write_json(&path, &queue)
}

/// Remembers what was resumed, so one error is resumed once and a failing session
/// is not hammered.
#[derive(Default)]
pub struct Resumer {
    done: HashMap<String, Vec<(String, i64)>>,
}

impl Resumer {
    /// Sessions to resume now: idle, alive, and stalled on a recent resumable error.
    /// Returns (sessionId, name) of each one queued.
    pub fn tick(&mut self, sessions: &[Value], now: i64, online_since: Option<i64>) -> Vec<(String, String)> {
        let Some(since) = online_since else { return vec![] };
        if now - since < STABLE_MS {
            return vec![];
        }
        let mut out = vec![];
        for s in sessions {
            let str_of = |k: &str| s.get(k).and_then(Value::as_str).unwrap_or("");
            let fresh = s.get("updatedAt").and_then(Value::as_f64).is_some_and(|u| now - (u as i64) < 90_000);
            if str_of("status") != "idle" || !fresh || s.get("supersededBy").is_some() {
                continue;
            }
            let id = str_of("sessionId").to_string();
            let Some(text) = crate::transcript::locate(&id, str_of("cwd")).and_then(|p| tail(&p)) else { continue };
            let lines: Vec<&str> = text.lines().collect();
            let Some((uuid, at)) = stalled_on(&lines) else { continue };
            if now - at > MAX_AGE_MS {
                continue;
            }
            let done = self.done.entry(id.clone()).or_default();
            done.retain(|(_, when)| now - when < 3600 * 1000);
            if done.iter().any(|(u, _)| *u == uuid) || done.len() >= PER_HOUR {
                continue;
            }
            done.push((uuid, now));
            if enqueue(&id, PROMPT, now).is_ok() {
                out.push((id, str_of("name").to_string()));
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn err(text: &str, error: &str) -> String {
        json!({ "type": "assistant", "uuid": "u1", "timestamp": "2026-10-11T10:00:00.000Z", "isApiErrorMessage": true, "error": error,
                "message": { "role": "assistant", "content": [{ "type": "text", "text": text }] } })
        .to_string()
    }

    #[test]
    fn connection_errors_resume_limits_do_not() {
        let at = chrono::DateTime::parse_from_rfc3339("2026-10-11T10:00:00Z").unwrap().timestamp_millis();
        let lost = err("API Error: Connection lost mid-response. The response above may be incomplete.", "server_error");
        let system = json!({ "type": "system", "subtype": "turn_duration" }).to_string();
        assert_eq!(stalled_on(&[&lost, &system]), Some(("u1".into(), at)));
        let sleep = err("API Error: Your computer went to sleep mid-response.", "unknown");
        assert!(stalled_on(&[&sleep]).is_some());
        let limit = err("You've hit your session limit · resets 3:40am", "rate_limit");
        assert_eq!(stalled_on(&[&limit]), None);
    }

    #[test]
    fn anything_after_the_error_means_it_moved_on() {
        let lost = err("API Error: Connection error.", "server_error");
        let prompt = json!({ "type": "user", "message": { "role": "user", "content": "keep going" } }).to_string();
        assert_eq!(stalled_on(&[&lost, &prompt]), None);
        // A subagent's or a meta line does not count.
        let side = json!({ "type": "user", "isSidechain": true }).to_string();
        let meta = json!({ "type": "user", "isMeta": true }).to_string();
        assert!(stalled_on(&[&lost, &side, &meta]).is_some());
    }

    #[test]
    fn nothing_is_resumed_until_the_link_is_stable() {
        let mut r = Resumer::default();
        assert!(r.tick(&[], 100_000, None).is_empty());
        assert!(r.tick(&[], 100_000, Some(90_000)).is_empty());
    }
}
