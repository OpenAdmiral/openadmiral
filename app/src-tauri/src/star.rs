//! Asking for a GitHub star, rarely and at a good moment: after the first agent's
//! first turn, after Underway kept agents working with the lid closed, or once the
//! person has answered a few waiting agents. At most three times, two weeks apart,
//! never again after a star or two dismissals, and never when they already starred.
//!
//! With the GitHub CLI signed in, one click stars the repo through `gh`; otherwise
//! the button opens the repo in the browser. State lives in the app data folder
//! (`star.json`); nothing about it leaves the Mac.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};

const REPO: &str = "OpenAdmiral/openadmiral";
pub const REPO_URL: &str = "https://github.com/OpenAdmiral/openadmiral";
const DAY_MS: u64 = 24 * 3600 * 1000;
const MAX_SHOWN: u32 = 3;
const MAX_DISMISSED: u32 = 2;
const COOLDOWN_MS: u64 = 14 * DAY_MS;
/// Answered waiting agents before asking, and days of use before that counts.
const ANSWERS: u32 = 5;
const ANSWER_DAYS_MS: u64 = 3 * DAY_MS;
/// Minutes of lid-closed work worth mentioning.
const UNDERWAY_MIN: u64 = 15;

#[derive(Serialize, Deserialize, Default, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct State {
    /// First time this app saw a star event (stands in for the install date).
    pub first_seen_at: u64,
    pub shown: u32,
    pub last_shown_at: u64,
    pub dismissed: u32,
    /// Starred, or went to GitHub to star: never ask again.
    pub done: bool,
    /// The first finished turn was already considered.
    pub first_turn: bool,
    pub answered: u32,
}

/// Something that happened in the app that may be a good moment to ask.
#[derive(Deserialize, Debug, Clone)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Event {
    /// A connected agent finished a turn.
    Turn,
    /// The person answered an agent that was waiting on them.
    Answered,
    /// The lid opened after Underway kept agents working for this many minutes.
    Underway { minutes: u64 },
}

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Prompt {
    /// "turn", "answered" or "underway": picks the card's wording.
    pub reason: &'static str,
    pub minutes: Option<u64>,
    /// "gh": one click stars through the GitHub CLI as `login`; "web": opens GitHub.
    pub mode: &'static str,
    pub login: Option<String>,
}

/// Applies an event to the state and says whether to ask now, by the rules alone
/// (the caller still checks whether the person already starred).
pub fn decide(s: &mut State, ev: &Event, now: u64) -> Option<(&'static str, Option<u64>)> {
    if s.first_seen_at == 0 {
        s.first_seen_at = now;
    }
    let hit = match ev {
        Event::Turn => {
            let first = !s.first_turn;
            s.first_turn = true;
            first.then_some(("turn", None))
        }
        Event::Answered => {
            s.answered += 1;
            (s.answered >= ANSWERS && now.saturating_sub(s.first_seen_at) >= ANSWER_DAYS_MS).then_some(("answered", None))
        }
        Event::Underway { minutes } => (*minutes >= UNDERWAY_MIN).then_some(("underway", Some(*minutes))),
    }?;
    let allowed = !s.done
        && s.shown < MAX_SHOWN
        && s.dismissed < MAX_DISMISSED
        && (s.last_shown_at == 0 || now.saturating_sub(s.last_shown_at) >= COOLDOWN_MS);
    allowed.then_some(hit)
}

static STATE: Mutex<Option<State>> = Mutex::new(None);

fn path(app: &AppHandle) -> Option<PathBuf> {
    crate::app_data_dir(app).map(|d| d.join("star.json"))
}

fn with_state<T>(app: &AppHandle, f: impl FnOnce(&mut State) -> T) -> T {
    let mut guard = STATE.lock().unwrap_or_else(|e| e.into_inner());
    let s = guard.get_or_insert_with(|| {
        path(app).and_then(|p| std::fs::read_to_string(p).ok()).and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
    });
    let before = s.clone();
    let out = f(s);
    if *s != before && !crate::preview() {
        if let Some(p) = path(app) {
            let _ = std::fs::create_dir_all(p.parent().unwrap());
            let tmp = p.with_extension("json.tmp");
            if std::fs::write(&tmp, serde_json::to_string(s).unwrap_or_default()).is_ok() {
                let _ = std::fs::rename(tmp, p);
            }
        }
    }
    out
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn gh() -> Command {
    let mut cmd = Command::new("gh");
    cmd.env("PATH", crate::login_path()).env("GH_PROMPT_DISABLED", "1").env("NO_COLOR", "1");
    cmd
}

/// The GitHub CLI's signed-in account, if there is one.
fn gh_login() -> Option<String> {
    let out = gh().args(["api", "user", "--jq", ".login"]).output().ok()?;
    let login = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (out.status.success() && !login.is_empty()).then_some(login)
}

/// Whether that account already starred the repo (204 starred, 404 not).
fn gh_starred() -> bool {
    gh().args(["api", &format!("user/starred/{REPO}")]).output().is_ok_and(|o| o.status.success())
}

fn gh_star() -> bool {
    gh().args(["api", "-X", "PUT", &format!("user/starred/{REPO}")]).output().is_ok_and(|o| o.status.success())
}

fn mode() -> (&'static str, Option<String>) {
    match gh_login() {
        Some(login) => ("gh", Some(login)),
        None => ("web", None),
    }
}

/// An event from the UI: answers with a card to show, or nothing.
#[tauri::command]
pub async fn star_event(app: AppHandle, event: Event) -> Option<Prompt> {
    if crate::preview() {
        return None;
    }
    let (reason, minutes) = with_state(&app, |s| decide(s, &event, now_ms()))?;
    tauri::async_runtime::spawn_blocking(move || {
        let (mode, login) = mode();
        if mode == "gh" && gh_starred() {
            with_state(&app, |s| s.done = true);
            return None;
        }
        with_state(&app, |s| {
            s.shown += 1;
            s.last_shown_at = now_ms();
        });
        Some(Prompt { reason, minutes, mode, login })
    })
    .await
    .ok()
    .flatten()
}

/// The card's or a menu's star button: stars through `gh` when it can ("starred"),
/// else opens the repo in the browser ("opened"). Either way, no more asking.
#[tauri::command]
pub async fn star_now(app: AppHandle) -> Result<&'static str, String> {
    let starred = tauri::async_runtime::spawn_blocking(|| gh_login().is_some() && gh_star()).await.unwrap_or(false);
    with_state(&app, |s| s.done = true);
    let how = if starred {
        "starred"
    } else {
        Command::new("open").arg(REPO_URL).status().map_err(|e| e.to_string())?;
        "opened"
    };
    // Every window drops its star links.
    let _ = app.emit("openadmiral://starred", how);
    Ok(how)
}

/// "Not now" or the close button.
#[tauri::command]
pub fn star_dismiss(app: AppHandle) {
    with_state(&app, |s| s.dismissed += 1);
}

/// Whether the person starred (hides the footer's star link).
#[tauri::command]
pub fn star_done(app: AppHandle) -> bool {
    with_state(&app, |s| s.done)
}

#[cfg(test)]
mod tests {
    use super::*;

    const T0: u64 = 1_800_000_000_000;

    #[test]
    fn first_turn_asks_once() {
        let mut s = State::default();
        assert_eq!(decide(&mut s, &Event::Turn, T0), Some(("turn", None)));
        s.shown = 1;
        s.last_shown_at = T0;
        assert_eq!(decide(&mut s, &Event::Turn, T0 + 30 * DAY_MS), None);
    }

    #[test]
    fn answers_need_five_and_three_days() {
        let mut s = State::default();
        for _ in 0..5 {
            assert_eq!(decide(&mut s, &Event::Answered, T0), None);
        }
        assert_eq!(decide(&mut s, &Event::Answered, T0 + 3 * DAY_MS), Some(("answered", None)));
    }

    #[test]
    fn underway_needs_fifteen_minutes() {
        let mut s = State::default();
        assert_eq!(decide(&mut s, &Event::Underway { minutes: 10 }, T0), None);
        assert_eq!(decide(&mut s, &Event::Underway { minutes: 47 }, T0), Some(("underway", Some(47))));
    }

    #[test]
    fn cooldown_between_asks() {
        let mut s = State { shown: 1, last_shown_at: T0, ..Default::default() };
        assert_eq!(decide(&mut s, &Event::Underway { minutes: 30 }, T0 + 13 * DAY_MS), None);
        assert!(decide(&mut s, &Event::Underway { minutes: 30 }, T0 + 14 * DAY_MS).is_some());
    }

    #[test]
    fn stops_for_good() {
        let ev = Event::Underway { minutes: 30 };
        assert_eq!(decide(&mut State { done: true, ..Default::default() }, &ev, T0), None);
        assert_eq!(decide(&mut State { shown: 3, ..Default::default() }, &ev, T0), None);
        assert_eq!(decide(&mut State { dismissed: 2, ..Default::default() }, &ev, T0), None);
    }

    #[test]
    fn events_still_count_while_quiet() {
        // A turn during the cooldown uses up the first-turn moment; answers keep counting.
        let mut s = State { shown: 1, last_shown_at: T0, first_seen_at: T0, ..Default::default() };
        decide(&mut s, &Event::Turn, T0);
        assert!(s.first_turn);
        decide(&mut s, &Event::Answered, T0);
        assert_eq!(s.answered, 1);
    }
}
