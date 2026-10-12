//! Moving an interactive session into OpenAdmiral. The app asks the session to exit
//! (the OpenAdmiral plugin polls `~/.claude/openadmiral/requests/<id>.json` and runs /exit when
//! idle), waits until `claude agents` no longer lists it, then resumes it in the
//! background under the same id and name. A session that is not running (an
//! ended background job, a closed terminal session) skips the exit and is
//! resumed at once. A running background session is already in OpenAdmiral: no hand-off. The work lives here, not in the UI,
//! so it survives a closed sheet, another view or a restart.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};

/// A request older than this is dropped: the mod ignores it too.
const EXPIRE_MS: u64 = 10 * 60_000;

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Handoff {
    pub session_id: String,
    pub name: String,
    pub cwd: String,
    pub requested_at: u64,
    /// requested → served (the mod ran /exit) → resuming → gone on success;
    /// error keeps the reason; expired when nothing happened in time.
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// "terminal": an interactive session asked to exit; "ended": just resumed.
    #[serde(default = "terminal")]
    pub from: String,
}

fn terminal() -> String {
    "terminal".into()
}

#[derive(Default)]
pub struct Handoffs(Mutex<Vec<Handoff>>);

/// A hand-off of this session is under way (the scheduler leaves it alone).
pub fn is_busy(app: &AppHandle, session_id: &str) -> bool {
    app.state::<Handoffs>().0.lock().map(|l| l.iter().any(|h| h.session_id == session_id && h.state != "error" && h.state != "expired")).unwrap_or(false)
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn store_path(app: &AppHandle) -> Option<PathBuf> {
    crate::app_data_dir(app).map(|d| d.join("handoffs.json"))
}

fn request_path(session_id: &str) -> PathBuf {
    crate::admiral_dir().join("requests").join(format!("{session_id}.json"))
}

fn persist_and_emit(app: &AppHandle, list: &[Handoff]) {
    if let Some(p) = store_path(app) {
        let _ = std::fs::create_dir_all(p.parent().unwrap());
        let _ = std::fs::write(p, serde_json::to_string(list).unwrap_or_default());
    }
    let _ = app.emit("openadmiral://handoffs", list.to_vec());
}

pub fn load(app: &AppHandle) {
    let saved: Vec<Handoff> = store_path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    let saved = saved
        .into_iter()
        .map(|mut h| {
            // The app closed mid-resume: nothing finishes it now, so say so instead of spinning.
            if h.state == "resuming" {
                h.state = "error".into();
                h.error = Some("OpenAdmiral closed while resuming it. Retry, or cancel if it is already running.".into());
            }
            h
        })
        .collect();
    *app.state::<Handoffs>().0.lock().unwrap() = saved;
}

#[tauri::command]
pub fn handoff_list(handoffs: State<'_, Handoffs>) -> Vec<Handoff> {
    handoffs.0.lock().unwrap().clone()
}

/// Asks an interactive session to hand over (writes the mod's request file), or
/// resumes a session that is not running right away. Refuses a running
/// background session: it is already in OpenAdmiral, and the request would make it exit.
/// Runs in an editor's Claude Code panel (the plugin says so in `host`): /exit does not
/// close it, so it can never hand over.
fn in_extension(session_id: &str) -> bool {
    crate::scheduler::read_json(&crate::admiral_dir().join("sessions").join(format!("{session_id}.json")))
        .is_some_and(|s| s.pointer("/host/kind").and_then(Value::as_str) == Some("extension"))
}

/// Still open in an editor's panel: it would never exit. Once its tab (or the editor)
/// is closed its process is gone, and it resumes like any ended session.
pub fn panel_open(session_id: &str) -> bool {
    in_extension(session_id) && crate::discover::session_running(session_id)
}

#[tauri::command]
pub async fn handoff_start(app: AppHandle, session_id: String, name: String, cwd: String) -> Result<(), String> {
    if panel_open(&session_id) {
        return Err(format!("{name} is still open in its editor's Claude Code panel, which can't hand it over: close its tab there, then resume it here."));
    }
    let agents = crate::claude_agents().ok_or("could not ask claude which sessions are running")?;
    let from = match crate::agent_row(&agents, &session_id) {
        Some(r) if r.get("kind").and_then(Value::as_str) == Some("interactive") => "terminal",
        Some(_) => return Err(format!("{name} is already running in OpenAdmiral.")),
        // Its job may be running under another id (a /clear changed it).
        None if crate::jobs::job_of(&agents, &session_id).is_some() => return Err(format!("{name} is already running in OpenAdmiral.")),
        None => "ended",
    };
    let at = now();
    let path = request_path(&session_id);
    if from == "terminal" {
        std::fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
        std::fs::write(&path, serde_json::json!({ "action": "handoff", "at": at }).to_string()).map_err(|e| e.to_string())?;
    } else {
        // A leftover request would make the resumed session exit again.
        let _ = std::fs::remove_file(&path);
    }
    let h = Handoff { session_id: session_id.clone(), name, cwd, requested_at: at, state: if from == "terminal" { "requested" } else { "resuming" }.into(), error: None, from: from.into() };
    let state = app.state::<Handoffs>();
    {
        let mut list = state.0.lock().unwrap();
        list.retain(|x| x.session_id != session_id);
        list.push(h.clone());
        persist_and_emit(&app, &list);
    }
    if from == "ended" {
        spawn_resume(app.clone(), h);
    }
    Ok(())
}

#[tauri::command]
pub fn handoff_cancel(app: AppHandle, handoffs: State<'_, Handoffs>, session_id: String) {
    let _ = std::fs::remove_file(request_path(&session_id));
    let mut list = handoffs.0.lock().unwrap();
    list.retain(|h| h.session_id != session_id);
    persist_and_emit(&app, &list);
}

/// Called with every `claude agents --json` reading.
pub fn tick(app: &AppHandle, agents: &Value) {
    let state = app.state::<Handoffs>();
    // Decide under the lock, resume outside it: resuming takes seconds.
    let mut to_resume: Vec<Handoff> = vec![];
    {
        let mut list = state.0.lock().unwrap();
        if list.is_empty() {
            return;
        }
        let mut changed = false;
        // Hand-offs asked of a session in an editor's panel (before OpenAdmiral knew better)
        // can never finish: drop them and their request.
        let before = list.len();
        list.retain(|h| {
            let stuck = h.from == "terminal" && h.state != "resuming" && in_extension(&h.session_id);
            if stuck {
                let _ = std::fs::remove_file(request_path(&h.session_id));
            }
            !stuck
        });
        changed |= list.len() != before;
        for h in list.iter_mut() {
            if matches!(h.state.as_str(), "error" | "expired" | "resuming") {
                continue;
            }
            if crate::is_listed(agents, &h.session_id) {
                if h.state == "requested" && served(&h.session_id) {
                    h.state = "served".into();
                    changed = true;
                }
                // The mod is waiting (background agents still running): time spent so does not
                // count toward the drop. Renew the request before either side would expire it.
                if waiting(&h.session_id) && now().saturating_sub(h.requested_at) > EXPIRE_MS - 2 * 60_000 {
                    if renew(&h.session_id) {
                        h.requested_at = now();
                        changed = true;
                    }
                }
                if now().saturating_sub(h.requested_at) > EXPIRE_MS {
                    h.state = "expired".into();
                    let _ = std::fs::remove_file(request_path(&h.session_id));
                    changed = true;
                }
                continue;
            }
            // Gone from the list: the session has exited. Resume it, once.
            h.state = "resuming".into();
            changed = true;
            to_resume.push(h.clone());
        }
        if changed {
            persist_and_emit(app, &list);
        }
    }
    for h in to_resume {
        spawn_resume(app.clone(), h);
    }
}

/// Resumes on its own thread (it can take up to a minute), then finishes the job:
/// success selects the session it runs under; a copy under a new id replaces the old row.
fn spawn_resume(app: AppHandle, h: Handoff) {
    std::thread::spawn(move || {
        let result = crate::resume_session(&h.session_id, &h.name, &h.cwd);
        let state = app.state::<Handoffs>();
        let mut list = state.0.lock().unwrap();
        match result {
            Ok(id) => {
                list.retain(|x| x.session_id != h.session_id);
                let _ = std::fs::remove_file(request_path(&h.session_id));
                if id != h.session_id {
                    crate::forget_session(&h.session_id, &h.cwd);
                    let _ = crate::scheduler::move_queue(&h.session_id, &id);
                }
                let _ = app.emit("openadmiral://handoff-done", serde_json::json!({ "from": h.session_id, "to": id }));
            }
            Err(e) => {
                if let Some(x) = list.iter_mut().find(|x| x.session_id == h.session_id) {
                    x.state = "error".into();
                    x.error = Some(e);
                }
            }
        }
        persist_and_emit(&app, &list);
    });
}

/// The mod's note while it cannot exit yet, e.g. "1 background agent(s) still running".
fn waiting(session_id: &str) -> bool {
    std::fs::read_to_string(request_path(session_id))
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .is_some_and(|v| v.get("waiting").and_then(Value::as_str).is_some_and(|w| !w.is_empty()))
}

/// Gives the request a fresh `at`, keeping every other field (the mod's included).
fn renew(session_id: &str) -> bool {
    let path = request_path(session_id);
    let Some(mut v) = std::fs::read_to_string(&path).ok().and_then(|s| serde_json::from_str::<Value>(&s).ok()) else { return false };
    v["at"] = Value::from(now());
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, v.to_string()).is_ok() && std::fs::rename(tmp, path).is_ok()
}

/// The mod writes `servedAt` into the request when it runs /exit.
fn served(session_id: &str) -> bool {
    std::fs::read_to_string(request_path(session_id))
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .is_some_and(|v| v.get("servedAt").is_some())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_id_claude_actually_started() {
        let same = "note: woke session 28e28aad with its saved options (-n, --model).\nbackgrounded \u{b7} 28e28aad \u{b7} admiral-rmtest-2 (idle \u{2014} send a prompt to start)\n  claude agents             list sessions\n  claude attach 28e28aad    open in this terminal";
        assert_eq!(crate::backgrounded_id(same).as_deref(), Some("28e28aad"));
        let copy = "note: background session 6bb26897 keeps its own saved options, so the flags you passed started a copy as 0b3f7c0f. Without flags, the same command continues 6bb26897 itself.\nbackgrounded \u{b7} 0b3f7c0f \u{b7} admiral-rmtest-1 (idle \u{2014} send a prompt to start)\n  claude stop 0b3f7c0f      stop this session";
        assert_eq!(crate::backgrounded_id(copy).as_deref(), Some("0b3f7c0f"));
        assert_eq!(crate::backgrounded_id("backgrounded \u{b7} cfc607d6 \u{b7} ai-tooling-71").as_deref(), Some("cfc607d6"));
        assert_eq!(crate::backgrounded_id("Workspace not trusted. Run `claude` in /tmp once"), None);
        assert_eq!(crate::backgrounded_id(""), None);
    }

    /// Against a real, stopped throwaway background session:
    /// OPENADMIRAL_TEST_SESSION=<full id> OPENADMIRAL_TEST_CWD=<dir> cargo test resumes_a_stopped_job -- --ignored
    #[test]
    #[ignore]
    fn resumes_a_stopped_job_under_its_own_id() {
        let id = std::env::var("OPENADMIRAL_TEST_SESSION").unwrap();
        let cwd = std::env::var("OPENADMIRAL_TEST_CWD").unwrap();
        assert_eq!(crate::resume_session(&id, "ignored-name", &cwd), Ok(id.clone()));
    }

    #[test]
    fn waiting_requests_are_renewed_with_their_fields() {
        let home = std::env::temp_dir().join(format!("admiral-handoff-{}", std::process::id()));
        std::env::set_var("CLAUDE_CONFIG_DIR", &home);
        let path = request_path("s1");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, r#"{"action":"handoff","at":1,"waiting":"1 background agent(s) still running"}"#).unwrap();
        assert!(waiting("s1"));
        assert!(renew("s1"));
        let v: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert!(v["at"].as_u64().unwrap() > 1);
        assert_eq!(v["waiting"], "1 background agent(s) still running");
        assert_eq!(v["action"], "handoff");
        std::fs::write(&path, r#"{"action":"handoff","at":1}"#).unwrap();
        assert!(!waiting("s1"));
        std::fs::remove_dir_all(home).unwrap();
    }
}

#[cfg(test)]
mod e2e {
    /// A session in an editor's panel, end to end (scratch session only):
    /// E2E_SESSION=<id> E2E_PHASE=open|closed cargo test handoff::e2e -- --ignored --nocapture
    #[test]
    #[ignore]
    fn editor_panel_session() {
        let id = std::env::var("E2E_SESSION").expect("E2E_SESSION");
        match std::env::var("E2E_PHASE").as_deref() {
            Ok("open") => assert!(super::panel_open(&id), "an open panel session must be refused"),
            Ok("closed") => {
                assert!(!super::panel_open(&id), "a closed panel session must resume");
                let cwd = std::env::var("E2E_CWD").expect("E2E_CWD");
                let resumed = crate::resume_session(&id, "e2e-panel-probe", &cwd).expect("resume");
                println!("resumed as {resumed}");
                assert_eq!(resumed, id, "same conversation, same id");
            }
            other => panic!("E2E_PHASE: {other:?}"),
        }
    }
}
