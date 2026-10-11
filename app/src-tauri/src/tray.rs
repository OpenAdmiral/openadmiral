//! The menu bar icon: quiet until someone needs you, and a fleet report on click.
//!
//! The icon itself only changes when it matters: a dot and a count when agents
//! wait for a permission or an answer, a horizon line under it while Underway keeps
//! the Mac awake. Clicking it opens a native menu: who needs you, who is working,
//! Underway, today's cost and plan, what runs next, open delegations, and the
//! usual Show / New Agent / Quit. It is rebuilt only when what it says changes.

use serde_json::Value;
use std::sync::Mutex;
use tauri::image::Image;
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
    pub holding: bool,
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

/// The icon: the template glyph, with a dot (someone needs you) or a horizon line
/// under it (Underway is keeping the Mac awake). Template images take the menu
/// bar's own colour, so the marks are cut out of and drawn in the same ink.
fn icon(base: &Image<'_>, dot: bool, horizon: bool) -> Image<'static> {
    let (w, h) = (base.width() as i64, base.height() as i64);
    let mut px = base.rgba().to_vec();
    let mut set = |x: i64, y: i64, a: u8| {
        if (0..w).contains(&x) && (0..h).contains(&y) {
            let i = ((y * w + x) * 4) as usize;
            px[i..i + 4].copy_from_slice(&[0, 0, 0, a]);
        }
    };
    if horizon {
        let t = (h / 16).max(1);
        for y in h - 3 * t..h {
            for x in 0..w {
                set(x, y, if y >= h - t { 255 } else { 0 });
            }
        }
    }
    if dot {
        let r = (w as f64 / 7.0).max(2.5);
        let (cx, cy) = (w as f64 - r - 0.5, h as f64 - r - 0.5 - if horizon { (h / 16 * 3) as f64 } else { 0.0 });
        for y in 0..h {
            for x in 0..w {
                let d = ((x as f64 + 0.5 - cx).powi(2) + (y as f64 + 0.5 - cy).powi(2)).sqrt();
                if d <= r {
                    set(x, y, 255);
                } else if d <= r + 3.0 {
                    set(x, y, 0);
                }
            }
        }
    }
    Image::new_owned(px, w as u32, h as u32)
}

fn base_icon() -> Option<Image<'static>> {
    Image::from_bytes(include_bytes!("../icons/tray.png")).ok().map(|i| i.to_owned())
}

fn build(app: &AppHandle, r: &Report) -> tauri::Result<Menu<tauri::Wry>> {
    let menu = Menu::new(app)?;
    let info = |text: &str| MenuItem::new(app, text, false, None::<&str>);
    let sep = || PredefinedMenuItem::separator(app);
    let mut summary = vec![format!("{} working", r.working.len())];
    if !r.waiting.is_empty() {
        summary.push(format!("{} need{} you", r.waiting.len(), if r.waiting.len() == 1 { "s" } else { "" }));
    }
    summary.push(format!("{} idle", r.idle));
    menu.append(&info(&summary.join(" · "))?)?;
    if !r.waiting.is_empty() {
        menu.append(&sep()?)?;
        menu.append(&info("Needs you")?)?;
        for row in &r.waiting {
            menu.append(&MenuItem::with_id(app, format!("tray:agent:{}", row.session_id), format!("⚠  {}  —  {}", row.name, row.detail), true, None::<&str>)?)?;
        }
    }
    if !r.working.is_empty() {
        menu.append(&sep()?)?;
        menu.append(&info("Working")?)?;
        for row in r.working.iter().take(WORKING_SHOWN) {
            menu.append(&MenuItem::with_id(app, format!("tray:agent:{}", row.session_id), format!("●  {}  —  {}", row.name, row.detail), true, None::<&str>)?)?;
        }
        if r.working.len() > WORKING_SHOWN {
            menu.append(&MenuItem::with_id(app, "tray:view:agents", format!("…and {} more", r.working.len() - WORKING_SHOWN), true, None::<&str>)?)?;
        }
    }
    if let Some((on, title, detail)) = &r.underway {
        menu.append(&sep()?)?;
        menu.append(&CheckMenuItem::with_id(app, "tray:underway", format!("Underway · {title}"), true, *on, None::<&str>)?)?;
        if !detail.is_empty() {
            menu.append(&info(&format!("     {}", clip(detail, 60)))?)?;
        }
    }
    let mut extra = vec![];
    if r.today.is_some() || r.plan.is_some() {
        let today = r.today.map(|usd| format!("Today ${usd:.2}")).unwrap_or_else(|| "Today".into());
        let plan = r.plan.as_ref().map(|p| format!("  ·  {p}")).unwrap_or_default();
        extra.push(MenuItem::with_id(app, "tray:view:costs", format!("{today}{plan}"), true, None::<&str>)?);
    }
    if let Some(next) = &r.next {
        extra.push(MenuItem::with_id(app, "tray:view:queue", next, true, None::<&str>)?);
    }
    if r.delegations.0 > 0 {
        let blocked = if r.delegations.1 > 0 { format!(" · {} blocked", r.delegations.1) } else { String::new() };
        let n = r.delegations.0;
        extra.push(MenuItem::with_id(app, "tray:view:delegations", format!("{n} delegation{} open{blocked}", if n == 1 { "" } else { "s" }), true, None::<&str>)?);
    }
    if !extra.is_empty() {
        menu.append(&sep()?)?;
        for item in &extra {
            menu.append(item)?;
        }
    }
    menu.append(&sep()?)?;
    menu.append(&MenuItem::with_id(app, "tray:show", "Show OpenAdmiral", true, None::<&str>)?)?;
    menu.append(&MenuItem::with_id(app, "tray:new", "New Agent…", true, None::<&str>)?)?;
    menu.append(&MenuItem::with_id(app, "tray:quit", "Quit OpenAdmiral", true, None::<&str>)?)?;
    Ok(menu)
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
        r.holding = u.hold && u.safe;
        r.underway = Some((u.settings.enabled, u.title.clone(), if u.settings.enabled { u.detail.clone() } else { String::new() }));
    }
    let mut last = state.last.lock().unwrap();
    if last.as_ref() == Some(&r) {
        return;
    }
    let icon_changed = last.as_ref().is_none_or(|l| l.waiting.is_empty() != r.waiting.is_empty() || l.holding != r.holding);
    *last = Some(r.clone());
    drop(last);
    if let Ok(menu) = build(app, &r) {
        let _ = tray.set_menu(Some(menu));
    }
    let _ = tray.set_title(if r.waiting.is_empty() { None } else { Some(r.waiting.len().to_string()) });
    if icon_changed {
        if let Some(base) = base_icon() {
            let _ = tray.set_icon(Some(icon(&base, !r.waiting.is_empty(), r.holding)));
            let _ = tray.set_icon_as_template(true);
        }
    }
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

#[cfg(test)]
mod icon_preview {
    /// Writes the icon variants as raw RGBA for a look: OPENADMIRAL_ICON_OUT=<dir> cargo test icon_preview -- --ignored
    #[test]
    #[ignore]
    fn write_variants() {
        let out = std::path::PathBuf::from(std::env::var("OPENADMIRAL_ICON_OUT").expect("OPENADMIRAL_ICON_OUT"));
        let base = super::base_icon().unwrap();
        for (name, dot, horizon) in [("plain", false, false), ("dot", true, false), ("horizon", false, true), ("both", true, true)] {
            let i = super::icon(&base, dot, horizon);
            std::fs::write(out.join(format!("{name}-{}x{}.rgba", i.width(), i.height())), i.rgba()).unwrap();
        }
    }
}
