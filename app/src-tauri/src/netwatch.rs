//! Underway's network half: whether the Mac can reach Claude right now, over what
//! (Wi-Fi, a cable, an iPhone's hotspot), and the backup network it joins when the
//! connection is gone for a while. The hotspot password, when one is given, lives
//! in the login Keychain, never in a file.

use crate::power;
use serde::Serialize;
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const API_HOST: &str = "api.anthropic.com";
const EVERY: Duration = Duration::from_secs(5);
/// Offline this long before the backup network is tried, and not more often than…
const JOIN_AFTER: Duration = Duration::from_secs(20);
const JOIN_EVERY: Duration = Duration::from_secs(60);
const KEYCHAIN_SERVICE: &str = "OpenAdmiral backup network";

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Net {
    /// Claude's API answers (a TCP connect to it succeeds).
    pub online: bool,
    /// What carries the default route, as macOS names the port: "Wi-Fi", "iPhone USB"…
    pub via: Option<String>,
    /// The default route goes through an iPhone's Personal Hotspot.
    pub hotspot: bool,
    /// An iPhone is plugged in by cable (it backs Wi-Fi up without anything to set up).
    pub iphone_usb: bool,
    /// Milliseconds since the connection was lost, while offline.
    pub offline_for_ms: Option<u64>,
    /// When it was last back online (epoch ms): auto-resume waits for a stable link.
    pub online_since: Option<i64>,
    /// The last attempt at the backup network: "joining", "joined", or what went wrong.
    pub backup_attempt: Option<String>,
}

#[derive(Default)]
struct Watch {
    net: Net,
    offline_since: Option<Instant>,
    last_join: Option<Instant>,
    addrs: Vec<SocketAddr>,
    resolved_at: Option<Instant>,
    ports: Vec<(String, String)>,
}

#[derive(Clone, Default)]
pub struct NetWatch(Arc<Mutex<Watch>>);

impl NetWatch {
    pub fn get(&self) -> Net {
        self.0.lock().unwrap().net.clone()
    }

    /// Probes every few seconds for the app's life. `backup` says which network to
    /// fall back to (None: no fallback set up).
    pub fn start(&self, backup: impl Fn() -> Option<String> + Send + 'static) {
        let me = self.clone();
        std::thread::spawn(move || loop {
            me.probe(backup());
            std::thread::sleep(EVERY);
        });
    }

    fn probe(&self, backup: Option<String>) {
        let route = power::parse_route(&power::run("/sbin/route", &["-n", "get", "default"]));
        let need_ports = {
            let w = self.0.lock().unwrap();
            w.ports.is_empty() || route.as_ref().is_some_and(|(i, _)| !w.ports.iter().any(|(_, d)| d == i))
        };
        if need_ports {
            let ports = power::parse_hardware_ports(&power::run("/usr/sbin/networksetup", &["-listallhardwareports"]));
            self.0.lock().unwrap().ports = ports;
        }
        let addrs = self.addresses();
        let reachable = route.is_some() && addrs.iter().take(2).any(|a| TcpStream::connect_timeout(a, Duration::from_secs(4)).is_ok());
        let now = Instant::now();
        let wifi_device;
        {
            let mut w = self.0.lock().unwrap();
            let port_of = |dev: &str| w.ports.iter().find(|(_, d)| d == dev).map(|(n, _)| n.clone());
            w.net.via = route.as_ref().map(|(iface, _)| port_of(iface).unwrap_or_else(|| iface.clone()));
            w.net.hotspot = route.as_ref().is_some_and(|(_, gw)| power::is_hotspot_gateway(gw.as_deref()));
            w.net.iphone_usb = w.ports.iter().any(|(n, _)| n.contains("iPhone"));
            wifi_device = w.ports.iter().find(|(n, _)| n == "Wi-Fi").map(|(_, d)| d.clone());
            if reachable {
                if !w.net.online {
                    w.net.online_since = Some(crate::underway::now_ms());
                    if w.net.backup_attempt.as_deref() == Some("joining") {
                        w.net.backup_attempt = Some("joined".into());
                    }
                }
                w.net.online = true;
                w.offline_since = None;
                w.net.offline_for_ms = None;
            } else {
                // A failed lookup or connect: look the address up again next time.
                w.resolved_at = None;
                w.net.online = false;
                w.net.online_since = None;
                let since = *w.offline_since.get_or_insert(now);
                w.net.offline_for_ms = Some(now.duration_since(since).as_millis() as u64);
            }
        }
        let (Some(ssid), Some(device)) = (backup, wifi_device) else { return };
        let due = {
            let w = self.0.lock().unwrap();
            should_join(w.offline_since.map(|s| now.duration_since(s)), w.last_join.map(|t| now.duration_since(t)), w.net.hotspot)
        };
        if due {
            {
                let mut w = self.0.lock().unwrap();
                w.last_join = Some(now);
                w.net.backup_attempt = Some("joining".into());
            }
            let result = join(&device, &ssid);
            let mut w = self.0.lock().unwrap();
            if let Err(e) = result {
                w.net.backup_attempt = Some(e);
            }
        }
    }

    /// The API's addresses, looked up again every 10 minutes or after a failure.
    /// The lookup runs on its own thread: a resolver with no network can hang for long.
    fn addresses(&self) -> Vec<SocketAddr> {
        {
            let w = self.0.lock().unwrap();
            if w.resolved_at.is_some_and(|t| t.elapsed() < Duration::from_secs(600)) && !w.addrs.is_empty() {
                return w.addrs.clone();
            }
        }
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let _ = tx.send((API_HOST, 443).to_socket_addrs().map(|a| a.collect::<Vec<_>>()).unwrap_or_default());
        });
        let found = rx.recv_timeout(Duration::from_secs(4)).unwrap_or_default();
        let mut w = self.0.lock().unwrap();
        if !found.is_empty() {
            w.addrs = found.clone();
            w.resolved_at = Some(Instant::now());
        }
        found
    }

    /// "Join now" from the panel: try the backup network at once.
    pub fn join_now(&self, ssid: &str) -> Result<(), String> {
        let device = self.0.lock().unwrap().ports.iter().find(|(n, _)| n == "Wi-Fi").map(|(_, d)| d.clone()).ok_or("This Mac has no Wi-Fi")?;
        {
            let mut w = self.0.lock().unwrap();
            w.last_join = Some(Instant::now());
            w.net.backup_attempt = Some("joining".into());
        }
        let result = join(&device, ssid);
        let mut w = self.0.lock().unwrap();
        w.net.backup_attempt = Some(match &result {
            Ok(()) => "joined".into(),
            Err(e) => e.clone(),
        });
        result
    }
}

/// Wi-Fi networks this Mac has joined before, as macOS spells them.
pub fn known_networks() -> Vec<String> {
    let ports = power::parse_hardware_ports(&power::run("/usr/sbin/networksetup", &["-listallhardwareports"]));
    let Some((_, device)) = ports.iter().find(|(n, _)| n == "Wi-Fi") else { return vec![] };
    power::run("/usr/sbin/networksetup", &["-listpreferredwirelessnetworks", device])
        .lines()
        .skip(1)
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect()
}

/// The name as macOS knows it when the typed one differs only in its apostrophe:
/// an iPhone calls its hotspot "César’s iPhone" (’), a keyboard types ' or ´.
pub fn resolve_name(typed: &str, known: &[String]) -> String {
    let fold = |s: &str| s.chars().map(|c| if matches!(c, '\'' | '’' | '‘' | '´' | '`' | 'ʼ') { '\'' } else { c }).collect::<String>().to_lowercase();
    let t = fold(typed.trim());
    known.iter().find(|k| fold(k) == t).cloned().unwrap_or_else(|| typed.trim().to_string())
}

/// Offline long enough, not tried too recently, and not on the hotspot already.
fn should_join(offline_for: Option<Duration>, since_last: Option<Duration>, on_hotspot: bool) -> bool {
    !on_hotspot && offline_for.is_some_and(|d| d >= JOIN_AFTER) && since_last.is_none_or(|d| d >= JOIN_EVERY)
}

/// Joins a Wi-Fi network. Without a saved password macOS uses the one it already
/// knows (a network this Mac has joined before).
fn join(device: &str, ssid: &str) -> Result<(), String> {
    let password = password(ssid);
    // The password goes on networksetup's command line (the only way it takes one):
    // visible to this user's own `ps` for the second it runs.
    let mut args = vec!["-setairportnetwork", device, ssid];
    if let Some(p) = password.as_deref() {
        args.push(p);
    }
    let out = std::process::Command::new("/usr/sbin/networksetup").args(&args).output().map_err(|e| e.to_string())?;
    // networksetup exits 0 even when it fails; it only says so.
    let text = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr)).trim().to_string();
    if out.status.success() && text.is_empty() {
        Ok(())
    } else if text.contains("Could not find network") || text.contains("-3900") {
        // -3900: macOS did not see the network when it tried (an iPhone only shows its
        // hotspot to other devices with Allow Others to Join on).
        Err(format!("{ssid} is not in range. On the iPhone, open Personal Hotspot and turn on Allow Others to Join."))
    } else {
        Err(if text.is_empty() { "Could not join".into() } else { text })
    }
}

#[cfg(target_os = "macos")]
pub fn password(ssid: &str) -> Option<String> {
    security_framework::passwords::get_generic_password(KEYCHAIN_SERVICE, ssid).ok().and_then(|b| String::from_utf8(b).ok())
}

#[cfg(target_os = "macos")]
pub fn save_password(ssid: &str, password: Option<&str>) -> Result<(), String> {
    let _ = security_framework::passwords::delete_generic_password(KEYCHAIN_SERVICE, ssid);
    match password.filter(|p| !p.is_empty()) {
        Some(p) => security_framework::passwords::set_generic_password(KEYCHAIN_SERVICE, ssid, p.as_bytes()).map_err(|e| e.to_string()),
        None => Ok(()),
    }
}

#[cfg(not(target_os = "macos"))]
pub fn password(_: &str) -> Option<String> {
    None
}

#[cfg(not(target_os = "macos"))]
pub fn save_password(_: &str, _: Option<&str>) -> Result<(), String> {
    Err("macOS only".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_typed_apostrophe_finds_the_iphone_name() {
        let known = vec!["César’s iPhone".to_string(), "Home".to_string()];
        assert_eq!(resolve_name("César´s iPhone", &known), "César’s iPhone");
        assert_eq!(resolve_name("césar's iphone ", &known), "César’s iPhone");
        assert_eq!(resolve_name("Office", &known), "Office");
    }

    #[test]
    fn the_backup_is_tried_after_a_while_offline_and_not_in_a_loop() {
        let s = Duration::from_secs;
        assert!(!should_join(None, None, false)); // online
        assert!(!should_join(Some(s(10)), None, false)); // a blip
        assert!(should_join(Some(s(20)), None, false));
        assert!(!should_join(Some(s(90)), Some(s(30)), false)); // tried 30 s ago
        assert!(should_join(Some(s(90)), Some(s(60)), false));
        assert!(!should_join(Some(s(90)), None, true)); // already on the hotspot: it is the hotspot that is down
    }
}
