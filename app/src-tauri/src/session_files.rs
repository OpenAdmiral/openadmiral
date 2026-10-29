//! The session files under `~/.claude/openadmiral/sessions`, read once and kept: a file is
//! read again only when its modification time or size changes. The window's snapshot, the
//! menu bar and Underway all ask often, and the folder holds hundreds of files, most of
//! them sessions that ended long ago.

use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime};

struct Entry {
    stamp: (SystemTime, u64),
    value: Value,
    /// Whether Claude Code saved a transcript for it, and when that was last looked up.
    transcript: (bool, Instant),
}

static CACHE: Mutex<Option<HashMap<PathBuf, Entry>>> = Mutex::new(None);

/// A session not yet seen with a transcript is looked for again this often (a new session
/// gets one at its first message); one that has it keeps it.
const RECHECK_MISSING: Duration = Duration::from_secs(60);

/// Every session file, parsed, with `hasTranscript` added. A file caught mid-write is
/// skipped (the next change reads it again).
pub fn all() -> Vec<Value> {
    let dir = crate::admiral_dir().join("sessions");
    let Ok(entries) = std::fs::read_dir(&dir) else { return vec![] };
    let mut guard = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    let cache = guard.get_or_insert_with(HashMap::new);
    let mut seen = Vec::new();
    let mut out = Vec::new();
    for path in entries.filter_map(|e| e.ok()).map(|e| e.path()).filter(|p| p.extension().is_some_and(|x| x == "json")) {
        let Ok(meta) = std::fs::metadata(&path) else { continue };
        let stamp = (meta.modified().unwrap_or(SystemTime::UNIX_EPOCH), meta.len());
        seen.push(path.clone());
        let fresh = cache.get(&path).is_some_and(|e| e.stamp == stamp);
        if !fresh {
            let Some(value) = std::fs::read_to_string(&path).ok().and_then(|s| serde_json::from_str::<Value>(&s).ok()) else {
                cache.remove(&path);
                continue;
            };
            let found = located(&value);
            cache.insert(path.clone(), Entry { stamp, value, transcript: (found, Instant::now()) });
        }
        let entry = cache.get_mut(&path).unwrap();
        if !entry.transcript.0 && entry.transcript.1.elapsed() > RECHECK_MISSING {
            entry.transcript = (located(&entry.value), Instant::now());
        }
        let mut value = entry.value.clone();
        value["hasTranscript"] = Value::from(entry.transcript.0);
        out.push(value);
    }
    cache.retain(|p, _| seen.contains(p));
    out
}

fn located(session: &Value) -> bool {
    let id = session.get("sessionId").and_then(Value::as_str).unwrap_or("");
    let cwd = session.get("cwd").and_then(Value::as_str).unwrap_or("");
    crate::transcript::locate(id, cwd).is_some()
}

/// What changed since the last call with the same `last`: sessions new or different, and the
/// ids gone. `last` is the caller's own record (the window's), so callers do not steal changes.
pub fn delta(last: &mut HashMap<String, Value>) -> (Vec<Value>, Vec<String>) {
    diff(last, all())
}

fn diff(last: &mut HashMap<String, Value>, sessions: Vec<Value>) -> (Vec<Value>, Vec<String>) {
    let now: HashMap<String, Value> = sessions.into_iter().filter_map(|s| Some((s.get("sessionId")?.as_str()?.to_string(), s))).collect();
    let upsert: Vec<Value> = now.iter().filter(|(id, s)| last.get(*id) != Some(*s)).map(|(_, s)| s.clone()).collect();
    let remove: Vec<String> = last.keys().filter(|id| !now.contains_key(*id)).cloned().collect();
    *last = now;
    (upsert, remove)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_diff_has_only_what_changed_and_what_went() {
        let mut last = HashMap::new();
        let (upsert, remove) = diff(&mut last, vec![json!({ "sessionId": "a", "v": 1 }), json!({ "sessionId": "b", "v": 1 })]);
        assert_eq!((upsert.len(), remove.len()), (2, 0));
        let (upsert, remove) = diff(&mut last, vec![json!({ "sessionId": "a", "v": 2 }), json!({ "sessionId": "b", "v": 1 })]);
        assert_eq!(upsert, vec![json!({ "sessionId": "a", "v": 2 })]);
        assert!(remove.is_empty());
        let (upsert, remove) = diff(&mut last, vec![json!({ "sessionId": "a", "v": 2 })]);
        assert!(upsert.is_empty());
        assert_eq!(remove, vec!["b".to_string()]);
    }
}
