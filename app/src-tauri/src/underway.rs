//! Underway: close the lid and the fleet keeps sailing.
//!
//! macOS sleeps when the lid closes, and no app-level assertion (caffeinate, which
//! Claude Code already runs) prevents that. Only `pmset disablesleep` does, and it
//! needs root, so a small privileged helper (`bin/openadmiral-helper.rs`, registered
//! with SMAppService) does it under a lease this module renews every few seconds.
//! If OpenAdmiral quits, crashes or hangs, the lease runs out and the helper puts
//! sleep back by itself.
//!
//! Every tick this module reads the power source, the lid, the temperature, the
//! network (`netwatch.rs`) and whether any agent has work, decides whether to hold
//! sleep off, and tells the UI one plain answer: is it safe to close the lid now?
//! It also stops on its own: below the battery floor, after the time limit, when
//! the Mac runs too hot, and (with "only while agents have work") once the fleet
//! is idle, so the Mac goes back to sleeping as usual.
//!
//! Auto-resume (`resume.rs`) runs from the same tick, whether Underway is on or not.

use crate::netwatch::{Net, NetWatch};
use crate::power::{self, Battery};
use crate::resume::Resumer;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

const EVERY: Duration = Duration::from_secs(5);
/// The helper keeps sleep off this long after the last renewal.
const LEASE_SECS: u64 = 90;
/// Work keeps Underway holding this long after the last agent went idle: between
/// turns, while Up next submits the next item, while a delegation bounces back.
const LINGER_MS: i64 = 5 * 60 * 1000;
/// Up next items due within this window count as work.
const AHEAD_MS: i64 = 60 * 60 * 1000;
/// What the bundled helper speaks; an older running helper is restarted.
const HELPER_VERSION: u64 = 1;
const PLIST: &str = "com.openadmiral.helper.plist";

pub fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// The person turned Underway on.
    pub enabled: bool,
    /// Keep the Mac awake only while agents have work (then let it sleep as usual).
    pub only_while_work: bool,
    /// On battery, stop below this percentage.
    pub battery_floor: u8,
    /// Stop after this many hours on (0: no limit).
    pub max_hours: u32,
    /// Queue a "continue" for agents a dropped connection stopped.
    pub auto_resume: bool,
    /// Wi-Fi network to join when the connection is gone (an iPhone's hotspot).
    pub backup_ssid: Option<String>,
    /// The first-time warning (heat, battery) was read.
    pub acknowledged: bool,
    pub enabled_at: Option<i64>,
}

impl Default for Settings {
    fn default() -> Self {
        Settings { enabled: false, only_while_work: true, battery_floor: 20, max_hours: 8, auto_resume: true, backup_ssid: None, acknowledged: false, enabled_at: None }
    }
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum HelperState {
    /// Not installed yet.
    Missing,
    /// Installed, waiting for the person in System Settings → Login Items.
    Approval,
    Ready,
    /// This build has no helper (development), or it does not answer.
    Unavailable,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, PartialOrd)]
#[serde(rename_all = "camelCase")]
pub enum Level {
    Ok,
    Warn,
    Bad,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Check {
    pub id: &'static str,
    pub level: Level,
    pub label: String,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum Mode {
    /// Off: the lid sleeps the Mac (unless it is in clamshell mode).
    Docked,
    /// On and holding sleep off.
    Underway,
    /// On, nothing to do: the Mac sleeps as usual until an agent works.
    Standby,
    /// On but something stops it (helper, heat).
    Blocked,
}

/// What the tick reads from the system.
#[derive(Clone, Debug, Default)]
pub struct Inputs {
    pub battery: Battery,
    pub lid_closed: bool,
    pub sleep_disabled: bool,
    pub external_display: bool,
    /// NSProcessInfo thermal state: 0 nominal … 3 critical.
    pub thermal: u8,
    pub low_power: bool,
    pub helper: Option<HelperState>,
    pub helper_error: Option<String>,
    pub net: Net,
    pub working: usize,
    pub work_ahead: bool,
    pub last_work: Option<i64>,
}

/// Why Underway turned itself off.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Stop {
    Battery,
    TimeLimit,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct State {
    pub mode: Mode,
    /// The pill: ok (green), warn (amber), bad (red), neutral (grey).
    pub tone: &'static str,
    pub pill: String,
    /// The one answer: "Safe to close the lid", "Closing the lid pauses your agents"…
    pub title: String,
    pub detail: String,
    /// Closing the lid now keeps agents running.
    pub safe: bool,
    pub hold: bool,
    pub checks: Vec<Check>,
    pub settings: Settings,
    pub helper: Option<HelperState>,
    pub helper_error: Option<String>,
    pub battery: Battery,
    pub lid_closed: bool,
    pub low_power: bool,
    pub net: Net,
    pub working: usize,
    /// Epoch ms when it will stop on its own (time limit), if on.
    pub until: Option<i64>,
}

fn hours(min: u32) -> String {
    if min >= 90 {
        format!("about {} h", (min + 30) / 60)
    } else {
        format!("about {min} min")
    }
}

fn plural(n: usize, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}

/// The whole decision, apart from the system: what to do and what to tell the person.
pub fn evaluate(i: &Inputs, s: &Settings, now: i64) -> (State, Option<Stop>) {
    let floor = s.battery_floor;
    let on_battery = !i.battery.ac && i.battery.percent.is_some();
    let below_floor = on_battery && i.battery.percent.is_some_and(|p| p < floor);
    let clamshell = i.battery.ac && i.external_display;
    let has_work = i.working > 0 || i.work_ahead || i.last_work.is_some_and(|t| now - t < LINGER_MS);
    let until = s.enabled_at.filter(|_| s.max_hours > 0).map(|t| t + s.max_hours as i64 * 3600 * 1000);
    let stop = match () {
        _ if s.enabled && below_floor => Some(Stop::Battery),
        _ if s.enabled && until.is_some_and(|u| now >= u) => Some(Stop::TimeLimit),
        _ => None,
    };
    let enabled = s.enabled && stop.is_none();
    let helper_ready = i.helper == Some(HelperState::Ready);
    let too_hot = i.thermal >= 3;
    let hold = enabled && helper_ready && !too_hot && (!s.only_while_work || has_work);

    let mut checks = vec![];
    let mut check = |id, level, label: String| checks.push(Check { id, level, label });
    if clamshell {
        check("sleep", Level::Ok, "On the charger with a display: the lid can close".into());
    } else if i.sleep_disabled && hold {
        check("sleep", Level::Ok, "Sleep on lid close is off".into());
    } else if hold {
        check("sleep", Level::Warn, "Turning sleep on lid close off…".into());
    } else {
        check("sleep", if enabled && has_work { Level::Bad } else { Level::Warn }, "Closing the lid puts the Mac to sleep".into());
    }
    if enabled || i.helper != Some(HelperState::Ready) {
        match i.helper {
            Some(HelperState::Ready) => check("helper", Level::Ok, "Helper allowed and running".into()),
            Some(HelperState::Missing) | None => check("helper", Level::Bad, "Install the helper that keeps the Mac awake".into()),
            Some(HelperState::Approval) => check("helper", Level::Bad, "Waiting for your approval in System Settings → Login Items".into()),
            Some(HelperState::Unavailable) => check("helper", Level::Bad, i.helper_error.clone().unwrap_or_else(|| "The helper is not available".into())),
        }
    }
    match i.battery.percent {
        _ if i.battery.ac => check("power", Level::Ok, "On the charger".into()),
        Some(p) => {
            let left = i.battery.remaining_min.map(|m| format!(" · {} left", hours(m))).unwrap_or_default();
            let level = if p < floor { Level::Bad } else if p < floor.saturating_add(10) { Level::Warn } else { Level::Ok };
            let label = if p < floor { format!("Battery {p}%, below the {floor}% floor") } else { format!("Battery {p}%, stops at {floor}%{left}") };
            check("power", level, label);
        }
        None => {}
    }
    match i.thermal {
        0 | 1 => check("thermal", Level::Ok, "Temperature normal".into()),
        2 => check("thermal", Level::Warn, "Running hot: give it some air".into()),
        _ => check("thermal", Level::Bad, "Too hot: Underway is paused".into()),
    }
    if i.net.online {
        let via = i.net.via.clone().unwrap_or_else(|| "the network".into());
        check("network", Level::Ok, if i.net.hotspot { format!("Online through the iPhone hotspot ({via})") } else { format!("Online via {via}") });
    } else {
        let mins = i.net.offline_for_ms.unwrap_or(0) / 60_000;
        check("network", Level::Warn, if mins >= 1 { format!("Offline for {mins} min") } else { "Offline".into() });
    }
    if i.net.iphone_usb {
        check("backup", Level::Ok, "Backup: iPhone connected by cable".into());
    } else if let Some(ssid) = &s.backup_ssid {
        check("backup", Level::Ok, format!("Backup: {ssid}"));
    } else if !i.net.hotspot {
        check("backup", Level::Warn, "No backup network".into());
    }
    if s.auto_resume {
        check("resume", Level::Ok, "Agents resume after a network drop".into());
    } else {
        check("resume", Level::Warn, "Auto-resume is off".into());
    }

    let blocking = |c: &&Check| matches!(c.id, "sleep" | "helper" | "power" | "thermal") && c.level == Level::Bad;
    let first_bad = checks.iter().find(blocking).map(|c| c.label.clone());
    // What stops it outright, ahead of its consequence ("the lid sleeps the Mac").
    let stopper = checks.iter().find(|c| matches!(c.id, "helper" | "thermal") && c.level == Level::Bad).map(|c| c.label.clone());
    let warned = checks.iter().any(|c| c.level != Level::Ok);
    let lid_ok = clamshell || (hold && i.sleep_disabled);
    let work = if i.working > 0 {
        plural(i.working, "agent working", "agents working")
    } else if has_work {
        "Up next has work soon".into()
    } else {
        "No agent working".into()
    };
    let power_note = if i.battery.ac || i.battery.percent.is_none() {
        "on the charger".to_string()
    } else {
        i.battery.remaining_min.map(|m| format!("{} on battery", hours(m))).unwrap_or_else(|| "on battery".into())
    };
    let safe = lid_ok && first_bad.is_none();
    let (mode, tone, pill, title, detail) = if !enabled {
        if clamshell {
            (Mode::Docked, "ok", "Docked", "Safe to close the lid".to_string(), "On the charger with a display connected: macOS keeps running with the lid closed.".to_string())
        } else {
            let why = match stop {
                Some(Stop::Battery) => format!("Underway stopped at {floor}% battery. "),
                Some(Stop::TimeLimit) => format!("Underway stopped after {} h. ", s.max_hours),
                None => String::new(),
            };
            (Mode::Docked, "neutral", "Docked", "Closing the lid pauses your agents".to_string(), format!("{why}Turn on Underway to keep them working with the lid closed."))
        }
    } else if !helper_ready || too_hot {
        (Mode::Blocked, "bad", "Not safe", "Not safe to close the lid yet".to_string(), stopper.or(first_bad.clone()).unwrap_or_default())
    } else if !hold {
        (Mode::Standby, "neutral", "Standing by", "Nothing to keep awake for".to_string(), "As soon as an agent works, Underway keeps the Mac awake. Until then, closing the lid sleeps it as usual.".to_string())
    } else if !lid_ok {
        (Mode::Underway, "warn", "Underway", "Getting ready…".to_string(), first_bad.clone().unwrap_or_else(|| "Turning sleep on lid close off.".into()))
    } else if first_bad.is_some() {
        (Mode::Underway, "bad", "Underway", "Not safe to close the lid yet".to_string(), first_bad.unwrap_or_default())
    } else {
        (Mode::Underway, if warned { "warn" } else { "ok" }, "Underway", "Safe to close the lid".to_string(), format!("{work} · {power_note}"))
    };
        let state = State {
        mode,
        tone,
        pill: pill.into(),
        title,
        detail,
        safe,
        hold,
        checks,
        settings: Settings { enabled, ..s.clone() },
        helper: i.helper,
        helper_error: i.helper_error.clone(),
        battery: i.battery.clone(),
        lid_closed: i.lid_closed,
        low_power: i.low_power,
        net: i.net.clone(),
        working: i.working,
        until: until.filter(|_| enabled),
    };
    (state, stop)
}

// ---- the system ------------------------------------------------------------

#[cfg(target_os = "macos")]
mod mac {
    use objc2::rc::Retained;
    use objc2::runtime::ProtocolObject;
    use objc2_foundation::{NSActivityOptions, NSObjectProtocol, NSProcessInfo, NSString};
    use objc2_service_management::{SMAppService, SMAppServiceStatus};

    pub fn thermal_and_low_power() -> (u8, bool) {
        let info = NSProcessInfo::processInfo();
        (info.thermalState().0.clamp(0, 3) as u8, info.isLowPowerModeEnabled())
    }

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGGetOnlineDisplayList(max: u32, displays: *mut u32, count: *mut u32) -> i32;
        fn CGDisplayIsBuiltin(display: u32) -> u32;
    }

    pub fn external_display() -> bool {
        let mut ids = [0u32; 16];
        let mut n = 0u32;
        // SAFETY: the buffer holds 16 ids and the count says how many were written.
        unsafe {
            if CGGetOnlineDisplayList(16, ids.as_mut_ptr(), &mut n) != 0 {
                return false;
            }
            ids[..n as usize].iter().any(|d| CGDisplayIsBuiltin(*d) == 0)
        }
    }

    /// Keeps App Nap from slowing OpenAdmiral down behind a closed lid (idle sleep
    /// stays allowed: the helper decides about sleep).
    pub struct Activity(Retained<ProtocolObject<dyn NSObjectProtocol>>);
    // SAFETY: the token is only handed back to NSProcessInfo, which is thread-safe.
    unsafe impl Send for Activity {}

    pub fn begin_activity() -> Activity {
        let reason = NSString::from_str("Underway: agents keep working with the lid closed");
        Activity(NSProcessInfo::processInfo().beginActivityWithOptions_reason(NSActivityOptions::UserInitiatedAllowingIdleSystemSleep, &reason))
    }

    pub fn end_activity(a: Activity) {
        // SAFETY: `a` came from beginActivityWithOptions_reason.
        unsafe { NSProcessInfo::processInfo().endActivity(&a.0) }
    }

    fn service() -> Retained<SMAppService> {
        // SAFETY: plain class method with a valid NSString.
        unsafe { SMAppService::daemonServiceWithPlistName(&NSString::from_str(super::PLIST)) }
    }

    /// 0 not registered, 1 enabled, 2 needs approval, 3 not found (not in this bundle).
    pub fn service_status() -> isize {
        // SAFETY: status has no preconditions.
        let s: SMAppServiceStatus = unsafe { service().status() };
        s.0
    }

    pub fn register() -> Result<(), String> {
        // SAFETY: as above; errors come back as NSError.
        unsafe { service().registerAndReturnError() }.map_err(|e| e.localizedDescription().to_string())
    }

    pub fn unregister() -> Result<(), String> {
        // SAFETY: as above.
        unsafe { service().unregisterAndReturnError() }.map_err(|e| e.localizedDescription().to_string())
    }

    pub fn open_login_items() {
        // SAFETY: opens System Settings; no arguments.
        unsafe { SMAppService::openSystemSettingsLoginItems() }
    }
}

fn helper_socket() -> String {
    let default = "/var/run/com.openadmiral.helper.sock".to_string();
    if cfg!(debug_assertions) {
        std::env::var("OPENADMIRAL_HELPER_SOCKET").unwrap_or(default)
    } else {
        default
    }
}

/// One request to the helper, one answer.
fn helper_call(req: Value) -> Result<Value, String> {
    let mut s = UnixStream::connect(helper_socket()).map_err(|e| e.to_string())?;
    let _ = s.set_read_timeout(Some(Duration::from_secs(3)));
    let _ = s.set_write_timeout(Some(Duration::from_secs(3)));
    writeln!(s, "{req}").map_err(|e| e.to_string())?;
    let mut line = String::new();
    BufReader::new(&s).read_line(&mut line).map_err(|e| e.to_string())?;
    let v: Value = serde_json::from_str(line.trim()).map_err(|e| e.to_string())?;
    if v.get("ok").and_then(Value::as_bool) == Some(true) {
        Ok(v)
    } else {
        Err(v.get("error").and_then(Value::as_str).unwrap_or("helper error").to_string())
    }
}

/// The helper's launchd plist inside this app bundle (Contents/Library/LaunchDaemons).
fn bundled_plist() -> bool {
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent()?.parent().map(|contents| contents.join("Library/LaunchDaemons").join(PLIST)))
        .is_some_and(|p| p.exists())
}

/// The helper as the app sees it, and its answer when it is up.
fn helper_state() -> (HelperState, Option<Value>, Option<String>) {
    #[cfg(target_os = "macos")]
    {
        // A debug build may talk to a helper started by hand (OPENADMIRAL_HELPER_SOCKET).
        let registered = if cfg!(debug_assertions) && std::env::var_os("OPENADMIRAL_HELPER_SOCKET").is_some() { 1 } else { mac::service_status() };
        match registered {
            0 => (HelperState::Missing, None, None),
            2 => (HelperState::Approval, None, None),
            1 => match helper_call(json!({ "op": "status" })) {
                Ok(v) => (HelperState::Ready, Some(v), None),
                Err(_) => (HelperState::Unavailable, None, Some("The helper is installed but not answering".into())),
            },
            // SMAppService says "not found" for a daemon it has not registered yet, not
            // only for one missing from the bundle: look for the plist ourselves.
            3 if bundled_plist() => (HelperState::Missing, None, None),
            _ => (HelperState::Unavailable, None, Some("This build has no helper (install the app from openadmiral.com)".into())),
        }
    }
    #[cfg(not(target_os = "macos"))]
    (HelperState::Unavailable, None, Some("macOS only".into()))
}

struct Inner {
    settings: Settings,
    state: Option<State>,
    last_work: Option<i64>,
    #[cfg(target_os = "macos")]
    activity: Option<mac::Activity>,
    resumer: Resumer,
    last_restart: Option<Instant>,
    /// Sleep is held off by us (as the helper last said).
    held: bool,
}

#[derive(Clone)]
pub struct Underway {
    inner: Arc<Mutex<Inner>>,
    pub net: NetWatch,
}

impl Default for Underway {
    fn default() -> Self {
        Underway {
            inner: Arc::new(Mutex::new(Inner {
                settings: Settings::default(),
                state: None,
                last_work: None,
                #[cfg(target_os = "macos")]
                activity: None,
                resumer: Resumer::default(),
                last_restart: None,
                held: false,
            })),
            net: NetWatch::default(),
        }
    }
}

fn settings_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    crate::app_data_dir(app).map(|d| d.join("underway.json"))
}

fn save(app: &AppHandle, s: &Settings) {
    if crate::preview() {
        return;
    }
    if let Some(p) = settings_path(app) {
        let _ = std::fs::create_dir_all(p.parent().unwrap());
        let _ = std::fs::write(p, serde_json::to_string_pretty(s).unwrap_or_default());
    }
}

/// Agents working now, and queued work coming up.
fn work(now: i64) -> (usize, bool) {
    let dir = crate::admiral_dir();
    let sessions = crate::read_dir_json(&dir.join("sessions"));
    let mut live = std::collections::HashSet::new();
    let mut working = 0;
    for s in &sessions {
        let fresh = s.get("updatedAt").and_then(Value::as_f64).is_some_and(|u| now - (u as i64) < 90_000);
        if !fresh || s.get("supersededBy").is_some() {
            continue;
        }
        let id = s.get("sessionId").and_then(Value::as_str).unwrap_or("").to_string();
        let status = s.get("status").and_then(Value::as_str).unwrap_or("");
        // An agent waiting on a permission counts while a phone or claude.ai is
        // attached through Remote Control: it can be answered from there.
        let remote = s.pointer("/remote/clients").and_then(Value::as_u64).unwrap_or(0) > 0;
        if status == "working" || status == "starting" || (status == "waiting" && remote) {
            working += 1;
        }
        if status != "ended" {
            live.insert(id);
        }
    }
    let qdir = dir.join("queue");
    let ahead = std::fs::read_dir(&qdir).into_iter().flatten().filter_map(|e| e.ok()).any(|e| {
        let name = e.file_name().to_string_lossy().to_string();
        let Some(id) = name.strip_suffix(".json").filter(|id| !id.ends_with(".sent") && !id.starts_with('.')) else { return false };
        crate::scheduler::read_json(&e.path())
            .is_some_and(|q| crate::scheduler::work_ahead(&q, &crate::scheduler::sent_of(&qdir, id), now, AHEAD_MS, live.contains(id)))
    });
    (working, ahead)
}

/// A preview shows a canned state for screenshots (OPENADMIRAL_UNDERWAY=docked|safe|warn|standby|blocked).
fn preview_inputs(kind: &str, now: i64) -> (Inputs, Settings) {
    let mut s = Settings { enabled: kind != "docked", backup_ssid: Some("Alex’s iPhone".into()), acknowledged: true, enabled_at: Some(now - 3600_000), ..Default::default() };
    let mut i = Inputs {
        battery: Battery { ac: false, percent: Some(82), charging: false, remaining_min: Some(310) },
        sleep_disabled: kind != "docked",
        helper: Some(if kind == "blocked" { HelperState::Approval } else { HelperState::Ready }),
        net: Net { online: true, via: Some("Wi-Fi".into()), ..Default::default() },
        working: 3,
        ..Default::default()
    };
    match kind {
        "warn" => {
            i.battery.percent = Some(26);
            i.battery.remaining_min = Some(70);
            s.backup_ssid = None;
        }
        "standby" => i.working = 0,
        _ => {}
    }
    (i, s)
}

impl Underway {
    pub fn state(&self) -> Option<State> {
        self.inner.lock().unwrap().state.clone()
    }

    pub fn settings(&self) -> Settings {
        self.inner.lock().unwrap().settings.clone()
    }

    pub fn start(&self, app: AppHandle) {
        if let Some(s) = settings_path(&app).and_then(|p| std::fs::read_to_string(p).ok()).and_then(|t| serde_json::from_str::<Settings>(&t).ok()) {
            self.inner.lock().unwrap().settings = s;
        }
        if !crate::preview() {
            let me = self.clone();
            self.net.start(move || me.settings().backup_ssid);
        }
        let me = self.clone();
        std::thread::spawn(move || loop {
            me.tick(&app);
            std::thread::sleep(EVERY);
        });
    }

    fn read_inputs(&self, now: i64) -> Inputs {
        let (lid_closed, sleep_disabled) = power::root_domain();
        #[cfg(target_os = "macos")]
        let ((thermal, low_power), external_display) = (mac::thermal_and_low_power(), mac::external_display());
        #[cfg(not(target_os = "macos"))]
        let ((thermal, low_power), external_display) = ((0, false), false);
        let (helper, status, helper_error) = helper_state();
        let (working, work_ahead) = work(now);
        let mut inner = self.inner.lock().unwrap();
        if working > 0 || work_ahead {
            inner.last_work = Some(now);
        }
        inner.held = status.as_ref().and_then(|v| v.get("held")).and_then(Value::as_bool).unwrap_or(false);
        // An older helper still running after an update: let launchd start the new one.
        let version = status.as_ref().and_then(|v| v.get("version")).and_then(Value::as_u64);
        if version.is_some_and(|v| v != HELPER_VERSION) && inner.last_restart.is_none_or(|t| t.elapsed() > Duration::from_secs(60)) {
            inner.last_restart = Some(Instant::now());
            let _ = helper_call(json!({ "op": "exit" }));
        }
        Inputs {
            battery: power::battery(),
            lid_closed,
            sleep_disabled,
            external_display,
            thermal,
            low_power,
            helper: Some(helper),
            helper_error,
            net: self.net.get(),
            working,
            work_ahead,
            last_work: inner.last_work,
        }
    }

    fn tick(&self, app: &AppHandle) {
        let now = now_ms();
        if crate::preview() {
            let kind = std::env::var("OPENADMIRAL_UNDERWAY").unwrap_or_else(|_| "docked".into());
            let (i, s) = preview_inputs(&kind, now);
            let (state, _) = evaluate(&i, &s, now);
            self.inner.lock().unwrap().state = Some(state.clone());
            let _ = app.emit("openadmiral://underway", state);
            return;
        }
        let inputs = self.read_inputs(now);
        let settings = self.settings();
        let (state, stop) = evaluate(&inputs, &settings, now);
        if let Some(stop) = stop {
            let mut inner = self.inner.lock().unwrap();
            inner.settings.enabled = false;
            inner.settings.enabled_at = None;
            save(app, &inner.settings);
            drop(inner);
            notify(app, "Underway stopped", &match stop {
                Stop::Battery => format!("Battery below {}%: the Mac sleeps as usual when the lid closes.", settings.battery_floor),
                Stop::TimeLimit => format!("It had been on for {} h. Turn it on again if agents still need the time.", settings.max_hours),
            });
        }
        self.apply(state.hold, settings.battery_floor, state.settings.enabled);
        if settings.auto_resume {
            let sessions = crate::read_dir_json(&crate::admiral_dir().join("sessions"));
            let resumed = self.inner.lock().unwrap().resumer.tick(&sessions, now, inputs.net.online_since);
            for (id, name) in resumed {
                let _ = app.emit("openadmiral://resumed", json!({ "sessionId": id, "name": name }));
            }
        }
        self.inner.lock().unwrap().state = Some(state.clone());
        let _ = app.emit("openadmiral://underway", state);
    }

    /// Holds or releases sleep through the helper, and App Nap with it.
    fn apply(&self, hold: bool, floor: u8, enabled: bool) {
        let held = self.inner.lock().unwrap().held;
        if hold {
            let _ = helper_call(json!({ "op": "hold", "ttl": LEASE_SECS, "batteryFloor": floor }));
        } else if held {
            let _ = helper_call(json!({ "op": "release" }));
        }
        #[cfg(target_os = "macos")]
        {
            let mut inner = self.inner.lock().unwrap();
            if enabled && inner.activity.is_none() {
                inner.activity = Some(mac::begin_activity());
            } else if !enabled {
                if let Some(a) = inner.activity.take() {
                    mac::end_activity(a);
                }
            }
        }
        #[cfg(not(target_os = "macos"))]
        let _ = enabled;
    }

    /// On quit: sleep goes back to normal now rather than when the lease runs out.
    pub fn shutdown(&self) {
        if self.inner.lock().unwrap().held {
            let _ = helper_call(json!({ "op": "release" }));
        }
    }

    fn update(&self, app: &AppHandle, f: impl FnOnce(&mut Settings)) -> Settings {
        let mut inner = self.inner.lock().unwrap();
        let was = inner.settings.enabled;
        f(&mut inner.settings);
        if inner.settings.enabled && !was {
            inner.settings.enabled_at = Some(now_ms());
        } else if !inner.settings.enabled {
            inner.settings.enabled_at = None;
        }
        save(app, &inner.settings);
        inner.settings.clone()
    }
}

fn notify(app: &AppHandle, title: &str, body: &str) {
    use tauri_plugin_notification::NotificationExt;
    let _ = app.notification().builder().title(title).body(body).show();
}

// ---- commands --------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsPatch {
    enabled: Option<bool>,
    only_while_work: Option<bool>,
    battery_floor: Option<u8>,
    max_hours: Option<u32>,
    auto_resume: Option<bool>,
    acknowledged: Option<bool>,
}

fn refresh(app: &AppHandle) -> Option<State> {
    let u = app.state::<Underway>();
    u.tick(app);
    u.state()
}

#[tauri::command]
pub fn underway_state(app: AppHandle) -> Option<State> {
    let u = app.state::<Underway>();
    u.state().or_else(|| refresh(&app))
}

#[tauri::command]
pub fn underway_settings(app: AppHandle, patch: SettingsPatch) -> Option<State> {
    let u = app.state::<Underway>();
    u.update(&app, |s| {
        if let Some(v) = patch.enabled {
            s.enabled = v;
        }
        if let Some(v) = patch.only_while_work {
            s.only_while_work = v;
        }
        if let Some(v) = patch.battery_floor {
            s.battery_floor = v.clamp(5, 80);
        }
        if let Some(v) = patch.max_hours {
            s.max_hours = v.min(72);
        }
        if let Some(v) = patch.auto_resume {
            s.auto_resume = v;
        }
        if let Some(v) = patch.acknowledged {
            s.acknowledged = v;
        }
    });
    refresh(&app)
}

/// install: register the helper (macOS then asks for approval in System Settings,
/// which this opens); uninstall: remove it; settings: open Login Items.
#[tauri::command]
pub fn underway_helper(app: AppHandle, action: String) -> Result<Option<State>, String> {
    if crate::preview() {
        return Ok(refresh(&app));
    }
    #[cfg(target_os = "macos")]
    match action.as_str() {
        "install" => {
            let result = mac::register();
            // Waiting for the person's approval comes back as "Operation not permitted":
            // not a failure, the next step is theirs, in Login Items.
            match mac::service_status() {
                2 => mac::open_login_items(),
                1 => {}
                _ => result?,
            }
        }
        "uninstall" => {
            app.state::<Underway>().shutdown();
            mac::unregister()?;
        }
        "settings" => mac::open_login_items(),
        _ => return Err("unknown action".into()),
    }
    #[cfg(not(target_os = "macos"))]
    let _ = action;
    Ok(refresh(&app))
}

/// The backup network: its name, and its password into the Keychain (None: keep
/// using the one macOS already knows). An empty name removes it.
#[tauri::command]
pub fn underway_backup(app: AppHandle, ssid: String, password: Option<String>) -> Result<Option<State>, String> {
    let u = app.state::<Underway>();
    let ssid = ssid.trim().to_string();
    let old = u.settings().backup_ssid;
    if let Some(old) = old.filter(|o| *o != ssid) {
        let _ = crate::netwatch::save_password(&old, None);
    }
    if !ssid.is_empty() && !crate::preview() {
        crate::netwatch::save_password(&ssid, password.as_deref())?;
    }
    u.update(&app, |s| s.backup_ssid = (!ssid.is_empty()).then_some(ssid));
    Ok(refresh(&app))
}

#[tauri::command]
pub fn underway_join(app: AppHandle) -> Result<Option<State>, String> {
    let u = app.state::<Underway>();
    let ssid = u.settings().backup_ssid.ok_or("No backup network set up")?;
    if !crate::preview() {
        let net = u.net.clone();
        // Joining takes a few seconds; the panel hears about it on the next tick.
        std::thread::spawn(move || {
            let _ = net.join_now(&ssid);
        });
    }
    Ok(u.state())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base() -> (Inputs, Settings) {
        let i = Inputs {
            battery: Battery { ac: false, percent: Some(80), charging: false, remaining_min: Some(300) },
            sleep_disabled: true,
            helper: Some(HelperState::Ready),
            net: Net { online: true, via: Some("Wi-Fi".into()), ..Default::default() },
            working: 2,
            ..Default::default()
        };
        let s = Settings { enabled: true, enabled_at: Some(0), backup_ssid: Some("Phone".into()), ..Default::default() };
        (i, s)
    }

    #[test]
    fn safe_when_everything_is_in_place() {
        let (i, s) = base();
        let (st, stop) = evaluate(&i, &s, 1000);
        assert_eq!(stop, None);
        assert!(st.hold && st.safe);
        assert_eq!((st.mode, st.tone, st.title.as_str()), (Mode::Underway, "ok", "Safe to close the lid"));
        assert_eq!(st.detail, "2 agents working · about 5 h on battery");
    }

    #[test]
    fn off_it_says_the_lid_pauses_agents_unless_clamshell() {
        let (i, mut s) = base();
        s.enabled = false;
        let (st, _) = evaluate(&Inputs { sleep_disabled: false, ..i.clone() }, &s, 1000);
        assert!(!st.hold && !st.safe);
        assert_eq!(st.title, "Closing the lid pauses your agents");
        let clamshell = Inputs { battery: Battery { ac: true, ..Default::default() }, external_display: true, ..i };
        let (st, _) = evaluate(&clamshell, &s, 1000);
        assert!(st.safe && !st.hold);
    }

    #[test]
    fn it_stops_itself_below_the_floor_and_after_the_time_limit() {
        let (mut i, s) = base();
        i.battery.percent = Some(19);
        let (st, stop) = evaluate(&i, &s, 1000);
        assert_eq!(stop, Some(Stop::Battery));
        assert!(!st.hold && !st.settings.enabled);
        // On the charger the floor does not apply.
        i.battery.ac = true;
        assert_eq!(evaluate(&i, &s, 1000).1, None);
        let (i, s) = base();
        assert_eq!(evaluate(&i, &s, 8 * 3600 * 1000).1, Some(Stop::TimeLimit));
        assert_eq!(evaluate(&i, &Settings { max_hours: 0, ..s }, 99 * 3600 * 1000).1, None);
    }

    #[test]
    fn idle_fleet_stands_by_after_lingering() {
        let (mut i, s) = base();
        i.working = 0;
        i.last_work = Some(0);
        assert!(evaluate(&i, &s, LINGER_MS - 1).0.hold);
        let (st, _) = evaluate(&i, &s, LINGER_MS);
        assert!(!st.hold);
        assert_eq!(st.mode, Mode::Standby);
        // Without "only while agents have work" it keeps holding.
        assert!(evaluate(&i, &Settings { only_while_work: false, ..s }, LINGER_MS).0.hold);
    }

    #[test]
    fn heat_or_a_missing_helper_block_it() {
        let (mut i, s) = base();
        i.thermal = 3;
        let (st, _) = evaluate(&i, &s, 1000);
        assert_eq!((st.mode, st.hold, st.safe), (Mode::Blocked, false, false));
        let (mut i, s) = base();
        i.helper = Some(HelperState::Approval);
        let (st, _) = evaluate(&i, &s, 1000);
        assert_eq!(st.mode, Mode::Blocked);
        assert_eq!(st.detail, "Waiting for your approval in System Settings → Login Items");
    }

    #[test]
    fn warnings_turn_it_amber_but_still_safe() {
        let (mut i, mut s) = base();
        s.backup_ssid = None;
        i.battery.percent = Some(25);
        let (st, _) = evaluate(&i, &s, 1000);
        assert!(st.safe);
        assert_eq!(st.tone, "warn");
        // Not yet disabled on the system: not safe yet.
        i.sleep_disabled = false;
        let (st, _) = evaluate(&i, &s, 1000);
        assert!(!st.safe);
        assert_eq!(st.title, "Getting ready…");
    }
}
