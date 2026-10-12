//! The menu bar icon: quiet until someone needs you, and a fleet report on click.
//!
//! The icon stays the plain template glyph (colours read badly on some menu bar
//! backgrounds); a count beside it says how many agents wait for a permission or
//! an answer. Everything else is in the menu. Clicking it opens a native menu: who needs you, who is working,
//! Underway, today's cost and plan, what runs next, open delegations, and the
//! usual Show / New Agent / Quit. It is rebuilt only when what it says changes.

use serde_json::Value;
use std::sync::Mutex;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::{AppHandle, Emitter, Manager};

pub const ID: &str = "openadmiral";
const WORKING_SHOWN: usize = 5;

/// What the menu says; rebuilt from the files and the CLI listing every poll.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Report {
    pub working: Vec<Row>,
    pub waiting: Vec<Row>,
    pub idle: usize,
    pub underway: Option<(bool, String, String)>,
    pub today: Option<f64>,
    pub plan: Option<String>,
    pub next: Option<String>,
    pub delegations: (usize, usize),
}

#[derive(Debug, Clone, PartialEq)]
pub struct Row {
    pub session_id: String,
    pub name: String,
    /// "Approve Bash · 4m", "12m · Apple Pay button".
    pub detail: String,
}

#[derive(Default)]
pub struct Tray {
    last: Mutex<Option<Report>>,
    /// Today's cost, from the app's cost report (the webview computes it).
    today: Mutex<Option<f64>>,
    live: Mutex<Option<(Vec<Line>, Vec<Handle>)>>,
}

fn clip(s: &str, n: usize) -> String {
    let s = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if s.chars().count() <= n {
        s
    } else {
        format!("{}…", s.chars().take(n - 1).collect::<String>().trim_end())
    }
}

/// "4m", "2h 5m", "3d".
fn span(ms: i64) -> String {
    let m = (ms.max(0) / 60_000) as i64;
    match m {
        0 => "now".into(),
        1..=59 => format!("{m}m"),
        60..=1439 => if m % 60 == 0 { format!("{}h", m / 60) } else { format!("{}h {}m", m / 60, m % 60) },
        _ => format!("{}d", m / 1440),
    }
}

fn num(v: &Value, k: &str) -> Option<i64> {
    v.get(k).and_then(Value::as_f64).map(|f| f as i64)
}

/// Builds the report from session files, the CLI listing (names), queues and delegations.
pub fn report(sessions: &[Value], agents: &Value, queues: &[(String, Value, Vec<Value>)], delegations: &[Value], now: i64) -> Report {
    let name_of = |id: &str, s: &Value| {
        agents
            .as_array()
            .and_then(|rows| rows.iter().find(|r| r.get("sessionId").and_then(Value::as_str) == Some(id)))
            .and_then(|r| r.get("name").and_then(Value::as_str))
            .or_else(|| s.get("name").and_then(Value::as_str))
            .or_else(|| s.get("project").and_then(Value::as_str))
            .unwrap_or("agent")
            .to_string()
    };
    let mut r = Report::default();
    let mut freshest_limits: Option<(i64, &Value)> = None;
    let mut names = std::collections::HashMap::new();
    for s in sessions {
        let updated = num(s, "updatedAt").unwrap_or(0);
        if now - updated > 90_000 || s.get("supersededBy").is_some() {
            continue;
        }
        let id = s.get("sessionId").and_then(Value::as_str).unwrap_or("").to_string();
        let name = name_of(&id, s);
        names.insert(id.clone(), name.clone());
        if let Some(l) = s.get("rateLimits").filter(|l| l.as_array().is_some_and(|a| !a.is_empty())) {
            if freshest_limits.is_none_or(|(u, _)| updated > u) {
                freshest_limits = Some((updated, l));
            }
        }
        match s.get("status").and_then(Value::as_str).unwrap_or("") {
            "waiting" => {
                let w = s.get("waiting");
                let what = match w.and_then(|w| w.get("reason")).and_then(Value::as_str) {
                    Some("permission") => w.and_then(|w| w.get("detail")).and_then(Value::as_str).map(|d| clip(d, 28)).unwrap_or_else(|| "Needs a permission".into()),
                    _ => "Asked a question".into(),
                };
                let since = w.and_then(|w| num(w, "since")).map(|t| format!(" · {}", span(now - t))).unwrap_or_default();
                r.waiting.push(Row { session_id: id, name, detail: format!("{what}{since}") });
            }
            "working" | "starting" => {
                let turn = s.get("turn");
                let since = turn.and_then(|t| num(t, "startedAt")).map(|t| span(now - t)).unwrap_or_default();
                let on = turn.and_then(|t| t.get("prompt")).and_then(Value::as_str).map(|p| format!(" · {}", clip(p, 26))).unwrap_or_default();
                r.working.push(Row { session_id: id, name, detail: format!("{since}{on}") });
            }
            "idle" => r.idle += 1,
            _ => {}
        }
    }
    r.working.sort_by(|a, b| a.name.cmp(&b.name));
    // The plan's 5-hour window, from whichever session reported it last.
    r.plan = freshest_limits.and_then(|(_, l)| {
        let five = l.as_array()?.iter().find(|x| x.get("kind").and_then(Value::as_str) == Some("five_hour"))?;
        let pct = five.get("percentUsed").and_then(Value::as_f64)?.round() as i64;
        let reset = five
            .get("resetsAt")
            .and_then(Value::as_str)
            .and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok())
            .map(|t| t.timestamp_millis() - now)
            .filter(|ms| *ms > 0)
            .map(|ms| format!(" · resets {}", span(ms)))
            .unwrap_or_default();
        Some(format!("5-hour {pct}%{reset}"))
    });
    // The next scheduled Up next item, across every queue.
    r.next = queues
        .iter()
        .filter(|(_, q, _)| q.get("paused").and_then(Value::as_bool) != Some(true))
        .flat_map(|(id, q, sent)| {
            q.get("items").and_then(Value::as_array).into_iter().flatten().filter_map(move |i| {
                if i.get("paused").and_then(Value::as_bool) == Some(true) {
                    return None;
                }
                let due = crate::scheduler::next_due(i, sent)?;
                Some((due, id.clone(), i.get("text").and_then(Value::as_str).unwrap_or("").to_string()))
            })
        })
        .filter(|(due, _, _)| *due >= now - 60_000)
        .min_by_key(|(due, _, _)| *due)
        .map(|(due, id, text)| {
            let when = chrono::DateTime::from_timestamp_millis(due).map(|t| t.with_timezone(&chrono::Local));
            let today = chrono::Local::now().date_naive();
            let at = match when {
                Some(t) if t.date_naive() == today => t.format("%H:%M").to_string(),
                Some(t) => t.format("%a %H:%M").to_string(),
                None => String::new(),
            };
            let who = names.get(&id).map(|n| format!(" · {n}")).unwrap_or_default();
            format!("Next: {}{who} at {at}", clip(&text, 30))
        });
    // Open delegations (quiet for two days counts as stale, as on the board).
    let open: Vec<&Value> = delegations
        .iter()
        .filter(|d| matches!(d.get("status").and_then(Value::as_str), Some("draft" | "sent" | "accepted" | "in_progress" | "blocked")))
        .filter(|d| now - num(d, "updatedAt").unwrap_or(0) < 2 * 86_400_000)
        .filter(|d| !d.get("id").and_then(Value::as_str).unwrap_or("").starts_with("fixture-"))
        .collect();
    let blocked = open.iter().filter(|d| d.get("status").and_then(Value::as_str) == Some("blocked")).count();
    r.delegations = (open.len(), blocked);
    r
}

/// One line of the menu. Its `key` and kind make the menu's structure; text and
/// check state may change in place without rebuilding it.
#[derive(Debug, Clone, PartialEq)]
enum Line {
    Sep,
    /// Greyed out, not clickable.
    Info(String),
    /// Clickable: (menu id, text).
    Item(String, String),
    /// Underway's switch: (text, on).
    Check(String, bool),
}

impl Line {
    fn shape(&self) -> String {
        match self {
            Line::Sep => "sep".into(),
            Line::Info(_) => "info".into(),
            Line::Item(id, _) => format!("item:{id}"),
            Line::Check(..) => "check".into(),
        }
    }
}

fn lines(r: &Report) -> Vec<Line> {
    let mut out = vec![];
    let mut summary = vec![format!("{} working", r.working.len())];
    if !r.waiting.is_empty() {
        summary.push(format!("{} need{} you", r.waiting.len(), if r.waiting.len() == 1 { "s" } else { "" }));
    }
    summary.push(format!("{} idle", r.idle));
    out.push(Line::Info(summary.join(" · ")));
    if !r.waiting.is_empty() {
        out.push(Line::Sep);
        out.push(Line::Info("Needs you".into()));
        for row in &r.waiting {
            out.push(Line::Item(format!("tray:agent:{}", row.session_id), format!("⚠  {}  —  {}", row.name, row.detail)));
        }
    }
    if !r.working.is_empty() {
        out.push(Line::Sep);
        out.push(Line::Info("Working".into()));
        for row in r.working.iter().take(WORKING_SHOWN) {
            out.push(Line::Item(format!("tray:agent:{}", row.session_id), format!("●  {}  —  {}", row.name, row.detail)));
        }
        if r.working.len() > WORKING_SHOWN {
            out.push(Line::Item("tray:view:agents".into(), format!("…and {} more", r.working.len() - WORKING_SHOWN)));
        }
    }
    if let Some((on, title, detail)) = &r.underway {
        out.push(Line::Sep);
        out.push(Line::Check(format!("Underway · {title}"), *on));
        if !detail.is_empty() {
            out.push(Line::Info(format!("     {}", clip(detail, 60))));
        }
    }
    let mut extra = vec![];
    if r.today.is_some() || r.plan.is_some() {
        let today = r.today.map(|usd| format!("Today ${usd:.2}")).unwrap_or_else(|| "Today".into());
        let plan = r.plan.as_ref().map(|p| format!("  ·  {p}")).unwrap_or_default();
        extra.push(Line::Item("tray:view:costs".into(), format!("{today}{plan}")));
    }
    if let Some(next) = &r.next {
        extra.push(Line::Item("tray:view:queue".into(), next.clone()));
    }
    if r.delegations.0 > 0 {
        let blocked = if r.delegations.1 > 0 { format!(" · {} blocked", r.delegations.1) } else { String::new() };
        let n = r.delegations.0;
        extra.push(Line::Item("tray:view:delegations".into(), format!("{n} delegation{} open{blocked}", if n == 1 { "" } else { "s" })));
    }
    if !extra.is_empty() {
        out.push(Line::Sep);
        out.extend(extra);
    }
    out.push(Line::Sep);
    out.push(Line::Item("tray:show".into(), "Show OpenAdmiral".into()));
    out.push(Line::Item("tray:new".into(), "New Agent…".into()));
    out.push(Line::Item("tray:quit".into(), "Quit OpenAdmiral".into()));
    out
}

/// The live menu's items, to change their text in place.
enum Handle {
    None,
    Item(MenuItem<tauri::Wry>),
    Check(CheckMenuItem<tauri::Wry>),
}

fn build(app: &AppHandle, lines: &[Line]) -> tauri::Result<(Menu<tauri::Wry>, Vec<Handle>)> {
    let menu = Menu::new(app)?;
    let mut handles = vec![];
    for line in lines {
        match line {
            Line::Sep => {
                menu.append(&PredefinedMenuItem::separator(app)?)?;
                handles.push(Handle::None);
            }
            Line::Info(text) => {
                let item = MenuItem::new(app, text, false, None::<&str>)?;
                menu.append(&item)?;
                handles.push(Handle::Item(item));
            }
            Line::Item(id, text) => {
                let item = MenuItem::with_id(app, id, text, true, None::<&str>)?;
                menu.append(&item)?;
                handles.push(Handle::Item(item));
            }
            Line::Check(text, on) => {
                let item = CheckMenuItem::with_id(app, "tray:underway", text, true, *on, None::<&str>)?;
                menu.append(&item)?;
                handles.push(Handle::Check(item));
            }
        }
    }
    Ok((menu, handles))
}

/// Brings the menu up to `next`. Replacing the menu closes it if it is open, so
/// when only words or a check mark changed (minutes ticking, battery) the items
/// are updated in place; the menu is rebuilt only when its lines come or go.
fn apply(app: &AppHandle, tray: &tauri::tray::TrayIcon, live: &mut Option<(Vec<Line>, Vec<Handle>)>, next: Vec<Line>) {
    if let Some((shown, handles)) = live.as_mut() {
        let same_shape = shown.len() == next.len() && shown.iter().zip(&next).all(|(a, b)| a.shape() == b.shape());
        if same_shape {
            for ((old, new), handle) in shown.iter().zip(&next).zip(handles.iter()) {
                if old == new {
                    continue;
                }
                match (new, handle) {
                    (Line::Info(text) | Line::Item(_, text), Handle::Item(item)) => {
                        let _ = item.set_text(text);
                    }
                    (Line::Check(text, on), Handle::Check(item)) => {
                        let _ = item.set_text(text);
                        let _ = item.set_checked(*on);
                    }
                    _ => {}
                }
            }
            *shown = next;
            return;
        }
    }
    if let Ok((menu, handles)) = build(app, &next) {
        let _ = tray.set_menu(Some(menu));
        *live = Some((next, handles));
    }
}

/// Rebuilds the menu and icon when the report changed. Called from the agents poll.
pub fn refresh(app: &AppHandle, agents: &Value) {
    let Some(tray) = app.tray_by_id(ID) else { return };
    let dir = crate::admiral_dir();
    let sessions = crate::read_dir_json(&dir.join("sessions"));
    let delegations = crate::read_dir_json(&dir.join("delegations"));
    let qdir = dir.join("queue");
    let queues: Vec<(String, Value, Vec<Value>)> = std::fs::read_dir(&qdir)
        .into_iter()
        .flatten()
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            let id = name.strip_suffix(".json").filter(|id| !id.ends_with(".sent") && !id.starts_with('.'))?.to_string();
            let q = crate::scheduler::read_json(&e.path())?;
            let sent = crate::scheduler::sent_of(&qdir, &id);
            Some((id, q, sent))
        })
        .collect();
    let now = crate::underway::now_ms();
    let state = app.state::<Tray>();
    let mut r = report(&sessions, agents, &queues, &delegations, now);
    r.today = *state.today.lock().unwrap();
    if let Some(u) = app.state::<crate::underway::Underway>().state() {
        r.underway = Some((u.settings.enabled, u.title.clone(), if u.settings.enabled { u.detail.clone() } else { String::new() }));
    }
    let mut last = state.last.lock().unwrap();
    if last.as_ref() == Some(&r) {
        return;
    }
    *last = Some(r.clone());
    drop(last);
    apply(app, &tray, &mut state.live.lock().unwrap(), lines(&r));
    let _ = tray.set_title(if r.waiting.is_empty() { None } else { Some(r.waiting.len().to_string()) });
}

/// Today's cost, as the app's cost report has it.
#[tauri::command]
pub fn tray_today(app: AppHandle, usd: Option<f64>) {
    *app.state::<Tray>().today.lock().unwrap() = usd;
}

/// A click in the menu.
pub fn on_menu(app: &AppHandle, id: &str) {
    let show = || crate::show_main(app);
    if let Some(session) = id.strip_prefix("tray:agent:") {
        show();
        let _ = app.emit("openadmiral://navigate", serde_json::json!({ "kind": "agent", "id": session }));
    } else if let Some(view) = id.strip_prefix("tray:view:") {
        show();
        let _ = app.emit("openadmiral://navigate", serde_json::json!({ "kind": view }));
    } else if id == "tray:underway" {
        let u = app.state::<crate::underway::Underway>();
        let s = u.settings();
        if !s.enabled && !s.acknowledged {
            // The first time goes through the panel, with its warning about heat and battery.
            show();
            let _ = app.emit("openadmiral://underway-panel", ());
        } else {
            let _ = crate::underway::set_enabled(app, !s.enabled);
        }
        // The check mark follows the setting, not the click.
        *app.state::<Tray>().last.lock().unwrap() = None;
    } else if id == "tray:show" {
        show();
    } else if id == "tray:new" {
        show();
        let _ = app.emit("openadmiral://new-agent", ());
    } else if id == "tray:quit" {
        app.exit(0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_report_sorts_the_fleet_and_finds_what_is_next() {
        let now = 10_000_000_000i64;
        let sessions = vec![
            json!({ "sessionId": "a", "project": "api", "status": "waiting", "updatedAt": now, "waiting": { "reason": "permission", "detail": "Approve Bash", "since": now - 4 * 60_000 } }),
            json!({ "sessionId": "b", "project": "app", "status": "working", "updatedAt": now, "turn": { "startedAt": now - 12 * 60_000, "prompt": "Add the Apple Pay button to checkout" } }),
            json!({ "sessionId": "c", "project": "docs", "status": "idle", "updatedAt": now }),
            json!({ "sessionId": "d", "project": "old", "status": "working", "updatedAt": now - 200_000 }),
        ];
        let agents = json!([{ "sessionId": "b", "name": "checkout-redesign" }]);
        let at = now + 3 * 3_600_000;
        let queues = vec![("c".to_string(), json!({ "items": [{ "id": "q1", "text": "Run the e2e suite", "createdAt": 0, "after": { "kind": "time", "at": at } }] }), vec![])];
        let delegations = vec![json!({ "id": "dlg_1", "status": "blocked", "updatedAt": now }), json!({ "id": "dlg_2", "status": "done", "updatedAt": now })];
        let r = report(&sessions, &agents, &queues, &delegations, now);
        assert_eq!(r.waiting, vec![Row { session_id: "a".into(), name: "api".into(), detail: "Approve Bash · 4m".into() }]);
        assert_eq!(r.working.len(), 1, "a stale session is not counted");
        assert_eq!(r.working[0].name, "checkout-redesign");
        assert_eq!(r.working[0].detail, "12m · Add the Apple Pay button…");
        assert_eq!(r.idle, 1);
        assert!(r.next.as_deref().unwrap().starts_with("Next: Run the e2e suite · docs at "));
        assert_eq!(r.delegations, (1, 1));
    }

    #[test]
    fn spans_read_like_people_say_them() {
        assert_eq!(span(30_000), "now");
        assert_eq!(span(4 * 60_000), "4m");
        assert_eq!(span(125 * 60_000), "2h 5m");
        assert_eq!(span(3 * 86_400_000), "3d");
    }
}
