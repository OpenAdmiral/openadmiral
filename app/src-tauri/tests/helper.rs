//! The privileged helper end to end, unprivileged: a debug build takes its socket,
//! marker and `pmset` from the environment, so this runs it against a fake pmset
//! that records what it was asked and reports a battery level from a file.

use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::time::{Duration, Instant};

struct Helper {
    child: Child,
    dir: PathBuf,
}

impl Drop for Helper {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn start(name: &str) -> Helper {
    let dir = std::env::temp_dir().join(format!("oa-helper-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let pmset = dir.join("pmset");
    std::fs::write(
        &pmset,
        format!(
            "#!/bin/sh\nD='{}'\nif [ \"$1\" = -g ] && [ \"$2\" = batt ]; then cat \"$D/batt\"; exit 0; fi\nif [ \"$1\" = -g ]; then echo \" SleepDisabled\t$(cat \"$D/disabled\" 2>/dev/null || echo 0)\"; exit 0; fi\necho \"$@\" >> \"$D/calls\"\n[ \"$1\" = -a ] && echo \"$3\" > \"$D/disabled\"\nexit 0\n",
            dir.display()
        ),
    )
    .unwrap();
    std::fs::set_permissions(&pmset, std::fs::Permissions::from_mode(0o755)).unwrap();
    battery(&dir, "AC Power", 90);
    let child = Command::new(env!("CARGO_BIN_EXE_openadmiral-helper"))
        .env("OPENADMIRAL_HELPER_SOCKET", dir.join("sock"))
        .env("OPENADMIRAL_HELPER_MARKER", dir.join("marker"))
        .env("OPENADMIRAL_HELPER_PMSET", &pmset)
        .spawn()
        .unwrap();
    let h = Helper { child, dir };
    wait_until(|| h.dir.join("sock").exists());
    h
}

fn battery(dir: &Path, source: &str, pct: u8) {
    let state = if source == "AC Power" { "charging" } else { "discharging" };
    std::fs::write(dir.join("batt"), format!("Now drawing from '{source}'\n -InternalBattery-0 (id=1)\t{pct}%; {state}; 3:00 remaining present: true\n")).unwrap();
}

fn wait_until(f: impl Fn() -> bool) {
    let t = Instant::now();
    while !f() {
        assert!(t.elapsed() < Duration::from_secs(10), "timed out");
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn call(h: &Helper, req: &str) -> serde_json::Value {
    let mut s = UnixStream::connect(h.dir.join("sock")).unwrap();
    writeln!(s, "{req}").unwrap();
    let mut line = String::new();
    BufReader::new(&s).read_line(&mut line).unwrap();
    serde_json::from_str(&line).unwrap()
}

fn calls(h: &Helper) -> String {
    std::fs::read_to_string(h.dir.join("calls")).unwrap_or_default()
}

#[test]
fn hold_and_release_switch_sleep_and_the_marker() {
    let h = start("hold");
    let st = call(&h, r#"{"op":"status"}"#);
    assert_eq!(st["ok"], true);
    assert_eq!(st["held"], false);
    let st = call(&h, r#"{"op":"hold","ttl":60,"batteryFloor":20}"#);
    assert_eq!(st["held"], true);
    assert_eq!(st["sleepDisabled"], true);
    assert!(h.dir.join("marker").exists());
    // A renewal does not touch the system again.
    call(&h, r#"{"op":"hold","ttl":60,"batteryFloor":20}"#);
    assert_eq!(calls(&h), "-a disablesleep 1\n");
    let st = call(&h, r#"{"op":"release"}"#);
    assert_eq!(st["held"], false);
    assert_eq!(calls(&h), "-a disablesleep 1\n-a disablesleep 0\n");
    assert!(!h.dir.join("marker").exists());
    assert_eq!(call(&h, r#"{"op":"nope"}"#)["ok"], false);
}

#[test]
fn quitting_it_puts_sleep_back() {
    let h = start("quit");
    call(&h, r#"{"op":"hold","ttl":1,"batteryFloor":20}"#); // clamped to 15 s
    let st = call(&h, r#"{"op":"status"}"#);
    assert!(st["leaseSeconds"].as_u64().unwrap() >= 10); // each answer reads ioreg, up to a second
    // Waiting the lease out is unit-tested in the helper; here, launchd stopping it.
    unsafe { libc::kill(h.child.id() as i32, libc::SIGTERM) };
    wait_until(|| calls(&h).ends_with("-a disablesleep 0\n"));
}

#[test]
fn below_the_battery_floor_it_lets_go() {
    let h = start("battery");
    battery(&h.dir, "Battery Power", 25);
    // The helper checks the battery right after a hold, then every 30 s.
    call(&h, r#"{"op":"hold","ttl":600,"batteryFloor":30}"#);
    wait_until(|| calls(&h).ends_with("-a disablesleep 0\n"));
    let st = call(&h, r#"{"op":"status"}"#);
    assert_eq!(st["held"], false);
    assert_eq!(st["ended"], "battery");
}

#[test]
fn a_restarted_helper_keeps_sleep_off_for_a_grace_period() {
    let h = start("grace");
    call(&h, r#"{"op":"hold","ttl":600,"batteryFloor":20}"#);
    let st = call(&h, r#"{"op":"exit"}"#);
    assert_eq!(st["held"], true);
    assert!(h.dir.join("marker").exists(), "exit leaves sleep as it is for the next helper");
}
