//! OpenAdmiral's privileged helper: the one piece that runs as root, so Underway can
//! keep the Mac awake with the lid closed (`pmset -a disablesleep 1`, which no
//! user-level assertion can do).
//!
//! It is registered by the app with SMAppService (Contents/Library/LaunchDaemons/
//! com.openadmiral.helper.plist) and knows a handful of requests on a Unix socket,
//! one JSON line in, one out. It keeps sleep disabled only under a lease: the app
//! renews it every few seconds, and when the app stops renewing (quit, crash, hang)
//! the helper puts sleep back by itself. It also gives up on its own below the
//! battery floor the app sent, so a Mac in a bag never runs flat.
//!
//!   {"op":"status"}                                  → {"ok":true,"version":1,"held":false,...}
//!   {"op":"hold","ttl":120,"batteryFloor":20}        keep sleep disabled for ttl seconds
//!   {"op":"release"}                                 put sleep back now
//!   {"op":"exit"}                                    quit (launchd starts the new binary after an update)

#[path = "../power.rs"]
#[allow(dead_code)]
mod power;

use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::os::unix::io::AsRawFd;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

/// Bumped whenever the protocol or the rules change: the app restarts an older helper.
const VERSION: u32 = 1;
/// A helper that starts while sleep is still disabled by us (it was restarted, or the
/// Mac rebooted) keeps it that long for the app to claim it, then puts it back.
const GRACE: Duration = Duration::from_secs(120);
const BATTERY_EVERY: Duration = Duration::from_secs(30);

static STOP: AtomicBool = AtomicBool::new(false);

extern "C" fn on_signal(_: libc::c_int) {
    STOP.store(true, Ordering::SeqCst);
}

/// Where things live. Debug builds take overrides so tests run it unprivileged.
struct Paths {
    socket: PathBuf,
    marker: PathBuf,
    pmset: String,
}

impl Paths {
    fn get() -> Paths {
        let over = |k: &str, d: &str| if cfg!(debug_assertions) { std::env::var(k).unwrap_or_else(|_| d.into()) } else { d.into() };
        Paths {
            socket: over("OPENADMIRAL_HELPER_SOCKET", "/var/run/com.openadmiral.helper.sock").into(),
            marker: over("OPENADMIRAL_HELPER_MARKER", "/Library/Application Support/OpenAdmiral/sleep-held").into(),
            pmset: over("OPENADMIRAL_HELPER_PMSET", "/usr/bin/pmset"),
        }
    }
}

/// The lease, apart from the system calls so the rules can be tested.
#[derive(Debug)]
struct Lease {
    held: bool,
    until: Option<Instant>,
    floor: u8,
    /// Why the last hold ended on the helper's side: "expired" or "battery".
    ended: Option<&'static str>,
}

impl Lease {
    fn new(now: Instant, already_held: bool) -> Lease {
        Lease { held: already_held, until: already_held.then(|| now + GRACE), floor: 20, ended: None }
    }

    /// A hold request: Some(true) when sleep has to be disabled now.
    fn hold(&mut self, now: Instant, ttl: u64, floor: u64) -> Option<bool> {
        self.until = Some(now + Duration::from_secs(ttl.clamp(15, 600)));
        self.floor = floor.clamp(5, 90) as u8;
        self.ended = None;
        (!self.held).then_some(true)
    }

    fn release(&mut self, why: Option<&'static str>) -> Option<bool> {
        let was = self.held;
        self.until = None;
        if why.is_some() {
            self.ended = why;
        }
        was.then_some(false)
    }

    /// Some(false) when the lease ran out or the battery fell below the floor.
    fn tick(&mut self, now: Instant, battery: Option<&power::Battery>) -> Option<bool> {
        if !self.held {
            return None;
        }
        if self.until.is_none_or(|u| now >= u) {
            return self.release(Some("expired"));
        }
        if let Some(b) = battery {
            if !b.ac && b.percent.is_some_and(|p| p < self.floor) {
                return self.release(Some("battery"));
            }
        }
        None
    }

    fn seconds_left(&self, now: Instant) -> u64 {
        self.until.map(|u| u.saturating_duration_since(now).as_secs()).unwrap_or(0)
    }
}

fn log(msg: &str) {
    eprintln!("{} openadmiral-helper: {msg}", chrono::Local::now().format("%Y-%m-%d %H:%M:%S"));
}

/// `pmset -a disablesleep 1|0`, with a marker so a restarted helper knows it was us.
fn apply(paths: &Paths, disable: bool) -> bool {
    let ok = std::process::Command::new(&paths.pmset)
        .args(["-a", "disablesleep", if disable { "1" } else { "0" }])
        .status()
        .is_ok_and(|s| s.success());
    if ok {
        if disable {
            if let Some(dir) = paths.marker.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            let _ = std::fs::write(&paths.marker, b"");
        } else {
            let _ = std::fs::remove_file(&paths.marker);
        }
    }
    log(&format!("disablesleep {} → {}", disable as u8, if ok { "ok" } else { "FAILED" }));
    ok
}

fn set(paths: &Paths, lease: &mut Lease, change: Option<bool>) {
    if let Some(disable) = change {
        if apply(paths, disable) {
            lease.held = disable;
        } else if disable {
            lease.until = None;
        }
    }
}

/// Only the person logged in at the screen (or root) may ask.
fn allowed(stream: &UnixStream) -> bool {
    let (mut uid, mut gid) = (u32::MAX, u32::MAX);
    if unsafe { libc::getpeereid(stream.as_raw_fd(), &mut uid, &mut gid) } != 0 {
        return false;
    }
    let console = std::fs::metadata("/dev/console").map(|m| m.uid()).ok();
    uid == 0 || Some(uid) == console || (cfg!(debug_assertions) && uid == unsafe { libc::getuid() })
}

fn status(paths: &Paths, lease: &Lease, now: Instant) -> Value {
    let pmset_g = power::run(&paths.pmset, &["-g"]);
    let disabled = pmset_g.lines().any(|l| l.trim_start().starts_with("SleepDisabled") && l.trim_end().ends_with('1'));
    json!({
        "ok": true,
        "version": VERSION,
        "held": lease.held,
        "sleepDisabled": disabled || power::root_domain().1,
        "leaseSeconds": lease.seconds_left(now),
        "batteryFloor": lease.floor,
        "ended": lease.ended,
    })
}

fn serve(paths: &Paths, lease: &mut Lease, mut stream: UnixStream) -> bool {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
    if !allowed(&stream) {
        let _ = writeln!(stream, "{}", json!({ "ok": false, "error": "not allowed" }));
        return false;
    }
    let mut line = String::new();
    if BufReader::new(&stream).read_line(&mut line).is_err() {
        return false;
    }
    let req: Value = serde_json::from_str(line.trim()).unwrap_or(Value::Null);
    let now = Instant::now();
    let mut exit = false;
    match req.get("op").and_then(Value::as_str) {
        Some("hold") => {
            let ttl = req.get("ttl").and_then(Value::as_u64).unwrap_or(120);
            let floor = req.get("batteryFloor").and_then(Value::as_u64).unwrap_or(20);
            let change = lease.hold(now, ttl, floor);
            set(paths, lease, change);
        }
        Some("release") => {
            let change = lease.release(None);
            set(paths, lease, change);
        }
        Some("exit") => exit = true,
        Some("status") => {}
        _ => {
            let _ = writeln!(stream, "{}", json!({ "ok": false, "error": "unknown op" }));
            return false;
        }
    }
    let _ = writeln!(stream, "{}", status(paths, lease, now));
    exit
}

fn main() {
    let paths = Paths::get();
    unsafe {
        libc::signal(libc::SIGTERM, on_signal as *const () as libc::sighandler_t);
        libc::signal(libc::SIGINT, on_signal as *const () as libc::sighandler_t);
    }
    let _ = std::fs::remove_file(&paths.socket);
    let listener = match UnixListener::bind(&paths.socket) {
        Ok(l) => l,
        Err(e) => {
            log(&format!("cannot listen on {}: {e}", paths.socket.display()));
            std::process::exit(1);
        }
    };
    // Anyone may connect; `allowed` decides who is answered.
    let _ = std::fs::set_permissions(&paths.socket, std::fs::Permissions::from_mode(0o666));
    let _ = listener.set_nonblocking(true);
    let mut lease = Lease::new(Instant::now(), paths.marker.exists());
    log(&format!("v{VERSION} up{}", if lease.held { ", sleep still disabled from before: grace period" } else { "" }));
    let mut last_battery = Instant::now() - BATTERY_EVERY;
    loop {
        if STOP.load(Ordering::SeqCst) {
            let change = lease.release(None);
            set(&paths, &mut lease, change);
            let _ = std::fs::remove_file(&paths.socket);
            log("stopped");
            return;
        }
        match listener.accept() {
            Ok((stream, _)) => {
                let _ = stream.set_nonblocking(false);
                if serve(&paths, &mut lease, stream) {
                    // Sleep stays as it is: the next helper finds the marker and takes over.
                    let _ = std::fs::remove_file(&paths.socket);
                    log("exit requested");
                    return;
                }
            }
            Err(_) => std::thread::sleep(Duration::from_millis(250)),
        }
        let now = Instant::now();
        let battery = (lease.held && last_battery.elapsed() >= BATTERY_EVERY).then(|| {
            last_battery = now;
            power::parse_batt(&power::run(&paths.pmset, &["-g", "batt"]))
        });
        let change = lease.tick(now, battery.as_ref());
        if let Some(why) = change.and(lease.ended) {
            log(&format!("lease ended: {why}"));
        }
        set(&paths, &mut lease, change);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn batt(ac: bool, pct: u8) -> power::Battery {
        power::Battery { ac, percent: Some(pct), ..Default::default() }
    }

    #[test]
    fn a_lease_holds_until_it_runs_out() {
        let t0 = Instant::now();
        let mut l = Lease::new(t0, false);
        assert_eq!(l.hold(t0, 60, 20), Some(true));
        l.held = true;
        assert_eq!(l.hold(t0, 60, 20), None); // a renewal changes nothing on the system
        assert_eq!(l.tick(t0 + Duration::from_secs(59), None), None);
        assert_eq!(l.tick(t0 + Duration::from_secs(60), None), Some(false));
        assert_eq!(l.ended, Some("expired"));
    }

    #[test]
    fn the_battery_floor_ends_it_but_the_charger_does_not() {
        let t0 = Instant::now();
        let mut l = Lease::new(t0, false);
        l.hold(t0, 600, 20);
        l.held = true;
        assert_eq!(l.tick(t0, Some(&batt(true, 5))), None);
        assert_eq!(l.tick(t0, Some(&batt(false, 20))), None);
        assert_eq!(l.tick(t0, Some(&batt(false, 19))), Some(false));
        assert_eq!(l.ended, Some("battery"));
    }

    #[test]
    fn a_restarted_helper_gives_the_app_a_grace_period() {
        let t0 = Instant::now();
        let mut l = Lease::new(t0, true);
        assert!(l.held);
        assert_eq!(l.tick(t0 + GRACE - Duration::from_secs(1), None), None);
        assert_eq!(l.tick(t0 + GRACE, None), Some(false));
    }

    #[test]
    fn requests_are_clamped() {
        let t0 = Instant::now();
        let mut l = Lease::new(t0, false);
        l.hold(t0, 999_999, 1);
        assert_eq!(l.seconds_left(t0), 600);
        assert_eq!(l.floor, 5);
    }
}
