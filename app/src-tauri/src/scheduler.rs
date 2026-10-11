//! Up next scheduling, the app's half (docs/CONTRACT.md "queue/"). A live session's mod
//! submits its own due items; this thread covers the sessions that are NOT running:
//! when one has a queued item that is due (its time came, or Run now was pressed),
//! it resumes the session in the background (`resume_session`, the hand-off path),
//! and the mod drains the queue once it is up. The due rules mirror
//! `plugin/hooks/queue.ts`; keep the two in step.

use chrono::{Datelike, Local, TimeZone};
use serde_json::Value;
use std::collections::HashMap;
use std::path::Path;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

/// How often closed sessions are checked for due items.
const EVERY: Duration = Duration::from_secs(15);
/// A session that could not be resumed is not tried again before this.
const BACKOFF: Duration = Duration::from_secs(10 * 60);

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn num(v: &Value, k: &str) -> Option<i64> {
    v.get(k).and_then(|x| x.as_f64()).map(|f| f as i64)
}

fn parse_time(hhmm: &str) -> Option<(u32, u32)> {
    let (h, m) = hhmm.trim().split_once(':')?;
    let (h, m): (u32, u32) = (h.parse().ok()?, m.parse().ok()?);
    (h < 24 && m < 60 && hhmm.trim().len() <= 5).then_some((h, m))
}

/// First local occurrence of `hh:mm` on one of `days` (0 = Sunday) strictly after `after` (ms).
pub fn next_occurrence(time: &str, days: &[u32], after: i64) -> Option<i64> {
    let (h, m) = parse_time(time)?;
    let all = [0, 1, 2, 3, 4, 5, 6];
    let days = if days.is_empty() { &all[..] } else { days };
    let base = Local.timestamp_millis_opt(after).single()?;
    for i in 0..8 {
        let date = base.date_naive() + chrono::Duration::days(i);
        let Some(ndt) = date.and_hms_opt(h, m, 0) else { continue };
        // A time that does not exist that day (DST gap) is skipped.
        let Some(dt) = Local.from_local_datetime(&ndt).earliest() else { continue };
        if dt.timestamp_millis() > after && days.contains(&dt.weekday().num_days_from_sunday()) {
            return Some(dt.timestamp_millis());
        }
    }
    None
}

fn last_run(sent: &[Value], id: &str) -> Option<i64> {
    sent.iter().filter(|s| s.get("id").and_then(Value::as_str) == Some(id)).filter_map(|s| num(s, "at")).max()
}

fn kind(item: &Value) -> Option<&str> {
    item.get("after")?.get("kind")?.as_str()
}

fn run_now_pending(item: &Value, sent: &[Value]) -> bool {
    let Some(at) = num(item, "runNowAt") else { return false };
    let id = item.get("id").and_then(Value::as_str).unwrap_or("");
    last_run(sent, id).is_none_or(|last| at > last)
}

fn is_done(item: &Value, sent: &[Value]) -> bool {
    if kind(item) == Some("schedule") {
        return false;
    }
    let id = item.get("id").and_then(Value::as_str).unwrap_or("");
    match last_run(sent, id) {
        None => false,
        Some(last) => !num(item, "runNowAt").is_some_and(|at| at > last),
    }
}

/// When a time or schedule item is due next (None for other kinds or a spent one-shot).
pub fn next_due(item: &Value, sent: &[Value]) -> Option<i64> {
    let after = item.get("after")?;
    match kind(item)? {
        "time" => (!is_done(item, sent)).then(|| num(after, "at")).flatten(),
        "schedule" => {
            let id = item.get("id").and_then(Value::as_str).unwrap_or("");
            let armed = num(item, "armedAt").or_else(|| num(item, "createdAt")).unwrap_or(0);
            let base = last_run(sent, id).unwrap_or(0).max(armed);
            let days: Vec<u32> = after.get("days").and_then(Value::as_array).map(|d| d.iter().filter_map(|x| x.as_u64().map(|n| n as u32)).collect()).unwrap_or_default();
            next_occurrence(after.get("time").and_then(Value::as_str)?, &days, base)
        }
        _ => None,
    }
}

/// Does this queue need its session now: an item with Run now pending, or a timed item that is due.
pub fn needs_session_now(queue: &Value, sent: &[Value], now: i64) -> bool {
    if queue.get("paused").and_then(Value::as_bool) == Some(true) {
        return false;
    }
    let Some(items) = queue.get("items").and_then(Value::as_array) else { return false };
    items.iter().any(|i| {
        let live = i.get("paused").and_then(Value::as_bool) != Some(true)
            && i.get("text").and_then(Value::as_str).is_some_and(|t| !t.trim().is_empty());
        live && (run_now_pending(i, sent) || next_due(i, sent).is_some_and(|due| due <= now))
    })
}

/// Queued work that will start within `window` ms (Underway keeps the Mac awake for
/// it): Run now pending, a plain item when its session is running (`live`: it runs
/// as soon as that session is idle; a closed one is not woken for it), or a
/// time/schedule item due by then. Items gated on a delegation or another
/// session wait on agents that are working, which count on their own.
pub fn work_ahead(queue: &Value, sent: &[Value], now: i64, window: i64, live: bool) -> bool {
    if queue.get("paused").and_then(Value::as_bool) == Some(true) {
        return false;
    }
    let Some(items) = queue.get("items").and_then(Value::as_array) else { return false };
    items.iter().any(|i| {
        let active = i.get("paused").and_then(Value::as_bool) != Some(true)
            && i.get("text").and_then(Value::as_str).is_some_and(|t| !t.trim().is_empty());
        active && (run_now_pending(i, sent)
            || match kind(i) {
                None => live && !is_done(i, sent),
                Some("time") | Some("schedule") => next_due(i, sent).is_some_and(|due| due <= now + window),
                _ => false,
            })
    })
}

pub(crate) fn read_json(path: &Path) -> Option<Value> {
    std::fs::read_to_string(path).ok().and_then(|s| serde_json::from_str(&s).ok())
}

pub(crate) fn write_json(path: &Path, v: &Value) -> Result<(), String> {
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(v).unwrap_or_default()).map_err(|e| e.to_string())?;
    std::fs::rename(tmp, path).map_err(|e| e.to_string())
}

pub(crate) fn sent_of(dir: &Path, id: &str) -> Vec<Value> {
    read_json(&dir.join(format!("{id}.sent.json")))
        .and_then(|v| v.get("sent").and_then(Value::as_array).cloned())
        .unwrap_or_default()
}

/// Moves a session's queue to the id it continues under (a /clear, or a resume that
/// started a copy), merging with anything already there. Nothing to move is fine.
pub fn move_queue(from: &str, to: &str) -> Result<(), String> {
    let bad = |s: &str| s.is_empty() || s.contains('/') || s.contains("..");
    if bad(from) || bad(to) || from == to {
        return Err("bad session id".into());
    }
    let dir = crate::admiral_dir().join("queue");
    let (qf, qt) = (dir.join(format!("{from}.json")), dir.join(format!("{to}.json")));
    let (sf, st) = (dir.join(format!("{from}.sent.json")), dir.join(format!("{to}.sent.json")));
    if let Some(old) = read_json(&qf) {
        match read_json(&qt) {
            None => std::fs::rename(&qf, &qt).map_err(|e| e.to_string())?,
            Some(mut new) => {
                let have: Vec<String> = new.get("items").and_then(Value::as_array).map(|a| a.iter().filter_map(|i| i.get("id").and_then(Value::as_str).map(String::from)).collect()).unwrap_or_default();
                let extra: Vec<Value> = old.get("items").and_then(Value::as_array).map(|a| a.iter().filter(|i| !have.iter().any(|h| Some(h.as_str()) == i.get("id").and_then(Value::as_str))).cloned().collect()).unwrap_or_default();
                if !new["items"].is_array() {
                    new["items"] = Value::Array(vec![]);
                }
                new["items"].as_array_mut().unwrap().extend(extra);
                new["updatedAt"] = Value::from(now_ms());
                write_json(&qt, &new)?;
                let _ = std::fs::remove_file(&qf);
            }
        }
    }
    if sf.exists() {
        let mut all = sent_of(&dir, from);
        all.extend(sent_of(&dir, to));
        all.sort_by_key(|s| num(s, "at").unwrap_or(0));
        let keep = all.len().saturating_sub(200);
        write_json(&st, &serde_json::json!({ "v": 1, "sent": all[keep..].to_vec() }))?;
        let _ = std::fs::remove_file(&sf);
    }
    Ok(())
}

#[tauri::command]
pub fn queue_move(from: String, to: String) -> Result<(), String> {
    if crate::preview() {
        return Ok(());
    }
    move_queue(&from, &to)
}

/// Sessions (ids) whose queue needs them now while they are not running.
fn due_closed_sessions(agents: &Value, now: i64) -> Vec<String> {
    let dir = crate::admiral_dir().join("queue");
    let Ok(entries) = std::fs::read_dir(&dir) else { return vec![] };
    let mut out = vec![];
    for e in entries.filter_map(|e| e.ok()) {
        let name = e.file_name().to_string_lossy().to_string();
        let Some(id) = name.strip_suffix(".json") else { continue };
        if id.ends_with(".sent") || id.starts_with('.') {
            continue;
        }
        let Some(queue) = read_json(&e.path()) else { continue };
        if needs_session_now(&queue, &sent_of(&dir, id), now) && !crate::jobs::is_running(agents, id) {
            out.push(id.to_string());
        }
    }
    out
}

/// Resumes a closed session for its queue: `Ok((name, id it now runs under))`,
/// or None when it should be left alone (removed, or continued under another id).
fn resume_queued(id: &str) -> Option<(String, Result<String, String>)> {
    let session = read_json(&crate::admiral_dir().join("sessions").join(format!("{id}.json")))?;
    if session.get("supersededBy").is_some() {
        return None;
    }
    let cwd = session.get("cwd").and_then(Value::as_str).unwrap_or("").to_string();
    let name = crate::claude_agents_all()
        .and_then(|all| crate::jobs::job_of(&all, id))
        .and_then(|j| j.name)
        .or_else(|| session.get("name").and_then(Value::as_str).map(String::from))
        .unwrap_or_default();
    let result = crate::resume_session(id, &name, &cwd).inspect(|to| {
        if to != id {
            crate::forget_session(id, &cwd);
            let _ = move_queue(id, to);
        }
    });
    Some((name, result))
}

fn resume_for_queue(app: &AppHandle, id: &str) {
    let _ = app.emit("openadmiral://scheduler", serde_json::json!({ "sessionId": id, "state": "resuming" }));
    match resume_queued(id) {
        None => {}
        Some((name, Ok(to))) => {
            let _ = app.emit("openadmiral://scheduler", serde_json::json!({ "sessionId": id, "state": "resumed", "to": to, "name": name }));
        }
        Some((name, Err(e))) => {
            let _ = app.emit("openadmiral://scheduler", serde_json::json!({ "sessionId": id, "state": "error", "error": e, "name": name }));
        }
    }
}

/// Runs for the app's life (the window may be closed; the tray keeps OpenAdmiral up).
pub fn start(app: AppHandle) {
    std::thread::spawn(move || {
        let mut tried: HashMap<String, Instant> = HashMap::new();
        loop {
            std::thread::sleep(EVERY);
            let Some(agents) = crate::claude_agents() else { continue };
            for id in due_closed_sessions(&agents, now_ms()) {
                if tried.get(&id).is_some_and(|t| t.elapsed() < BACKOFF) || crate::handoff::is_busy(&app, &id) {
                    continue;
                }
                tried.insert(id.clone(), Instant::now());
                resume_for_queue(&app, &id);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Live check against the real CLI (throwaway sessions only):
    /// OPENADMIRAL_SCHED_TEST=<session id prefix> cargo test scheduler::tests::live -- --ignored --nocapture
    #[test]
    #[ignore]
    fn live_resume_of_a_due_closed_session() {
        let prefix = std::env::var("OPENADMIRAL_SCHED_TEST").expect("OPENADMIRAL_SCHED_TEST");
        let agents = crate::claude_agents().expect("claude agents");
        let due: Vec<String> = due_closed_sessions(&agents, now_ms()).into_iter().filter(|id| id.starts_with(&prefix)).collect();
        println!("due: {due:?}");
        assert_eq!(due.len(), 1);
        let (name, result) = resume_queued(&due[0]).expect("resumable");
        println!("resumed {name}: {result:?}");
        assert!(result.is_ok());
    }

    fn local(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> i64 {
        Local.with_ymd_and_hms(y, mo, d, h, mi, 0).earliest().unwrap().timestamp_millis()
    }

    #[test]
    fn next_occurrence_skips_to_the_next_allowed_day() {
        // Wednesday 2026-10-07 10:00; weekdays 09:00 → Thursday 09:00.
        let wed10 = local(2026, 10, 7, 10, 0);
        assert_eq!(next_occurrence("09:00", &[1, 2, 3, 4, 5], wed10), Some(local(2026, 10, 8, 9, 0)));
        // Friday 10:00 → Monday 09:00.
        assert_eq!(next_occurrence("09:00", &[1, 2, 3, 4, 5], local(2026, 10, 9, 10, 0)), Some(local(2026, 10, 12, 9, 0)));
        // Same day, later time.
        assert_eq!(next_occurrence("18:30", &[], wed10), Some(local(2026, 10, 7, 18, 30)));
        assert_eq!(next_occurrence("25:00", &[], wed10), None);
    }

    #[test]
    fn a_schedule_is_due_once_after_missed_runs_then_rearms() {
        let created = local(2026, 10, 5, 8, 0); // Monday
        let item = json!({ "id": "q_d", "text": "report", "createdAt": created, "after": { "kind": "schedule", "time": "09:00", "days": [0,1,2,3,4,5,6] } });
        let queue = json!({ "paused": false, "items": [item.clone()] });
        let wed = local(2026, 10, 7, 15, 0);
        assert!(needs_session_now(&queue, &[], wed)); // missed Mon, Tue, Wed: due (one catch-up)
        let sent = vec![json!({ "id": "q_d", "at": wed })];
        assert!(!needs_session_now(&queue, &sent, wed + 60_000)); // ran: next is Thursday 09:00
        assert_eq!(next_due(&item, &sent), Some(local(2026, 10, 8, 9, 0)));
        let paused = json!({ "paused": true, "items": [item] });
        assert!(!needs_session_now(&paused, &[], wed));
    }

    #[test]
    fn work_ahead_sees_plain_soon_and_run_now_items() {
        let t = local(2026, 10, 7, 9, 0);
        let plain = json!({ "items": [{ "id": "q_p", "text": "y", "createdAt": 0 }] });
        assert!(work_ahead(&plain, &[], t, 0, true));
        assert!(!work_ahead(&plain, &[], t, 0, false)); // its session is closed
        assert!(!work_ahead(&plain, &[json!({ "id": "q_p", "at": t })], t, 0, true)); // done
        let later = json!({ "items": [{ "id": "q_t", "text": "x", "createdAt": 0, "after": { "kind": "time", "at": t + 2 * 3600_000 } }] });
        assert!(!work_ahead(&later, &[], t, 3600_000, true));
        assert!(work_ahead(&later, &[], t + 3600_000, 3600_000, false));
        let gated = json!({ "items": [{ "id": "q_d", "text": "x", "createdAt": 0, "after": { "kind": "delegation", "id": "dlg_1", "status": ["done"] } }] });
        assert!(!work_ahead(&gated, &[], t, 3600_000, true));
        let paused = json!({ "paused": true, "items": [{ "id": "q_p", "text": "y", "createdAt": 0 }] });
        assert!(!work_ahead(&paused, &[], t, 0, true));
    }

    #[test]
    fn one_shots_and_run_now() {
        let t = local(2026, 10, 7, 9, 0);
        let item = json!({ "id": "q_t", "text": "x", "createdAt": 0, "after": { "kind": "time", "at": t } });
        let q = json!({ "items": [item] });
        assert!(!needs_session_now(&q, &[], t - 1));
        assert!(needs_session_now(&q, &[], t));
        assert!(!needs_session_now(&q, &[json!({ "id": "q_t", "at": t + 5 })], t + 10));
        // Plain items never wake a session; Run now does, once.
        let plain = json!({ "items": [{ "id": "q_p", "text": "y", "createdAt": 0 }] });
        assert!(!needs_session_now(&plain, &[], t));
        let forced = json!({ "items": [{ "id": "q_p", "text": "y", "createdAt": 0, "runNowAt": t }] });
        assert!(needs_session_now(&forced, &[], t));
        assert!(!needs_session_now(&forced, &[json!({ "id": "q_p", "at": t + 1 })], t + 2));
    }
}
