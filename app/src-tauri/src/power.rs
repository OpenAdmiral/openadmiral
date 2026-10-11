//! Readers for what macOS prints about power, the lid and the network. Std only:
//! shared by the app (`underway.rs`) and the privileged helper
//! (`bin/openadmiral-helper.rs`, which includes this file by path).

use std::process::Command;

/// `pmset -g batt`: where power comes from and how much battery is left.
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Battery {
    /// On the charger ("AC Power").
    pub ac: bool,
    /// None on a Mac without a battery.
    pub percent: Option<u8>,
    pub charging: bool,
    /// macOS's own estimate while discharging.
    pub remaining_min: Option<u32>,
}

pub fn parse_batt(out: &str) -> Battery {
    let mut b = Battery { ac: out.contains("'AC Power'"), ..Default::default() };
    for line in out.lines().filter(|l| l.contains("InternalBattery")) {
        let Some(rest) = line.split('\t').nth(1) else { continue };
        let mut parts = rest.split(';').map(str::trim);
        b.percent = parts.next().and_then(|p| p.strip_suffix('%')).and_then(|p| p.parse().ok());
        let state = parts.next().unwrap_or("");
        b.charging = state == "charging";
        b.remaining_min = parts.next().and_then(|r| r.split_whitespace().next()).and_then(|hm| {
            let (h, m) = hm.split_once(':')?;
            Some(h.parse::<u32>().ok()? * 60 + m.parse::<u32>().ok()?)
        });
    }
    b
}

/// `ioreg -r -c IOPMrootDomain -d 1`: (lid closed, sleep disabled system-wide).
pub fn parse_root_domain(out: &str) -> (bool, bool) {
    let flag = |key: &str| {
        out.lines()
            .find(|l| l.trim_start().starts_with(&format!("\"{key}\"")))
            .is_some_and(|l| l.trim_end().ends_with("Yes"))
    };
    (flag("AppleClamshellState"), flag("SleepDisabled"))
}

/// `route -n get default`: (interface, gateway) of the default route, if there is one.
pub fn parse_route(out: &str) -> Option<(String, Option<String>)> {
    let field = |k: &str| out.lines().find_map(|l| l.trim().strip_prefix(k).map(|v| v.trim().to_string()));
    Some((field("interface:")?, field("gateway:")))
}

/// `networksetup -listallhardwareports`: (port name, device) pairs, e.g. ("Wi-Fi", "en0").
pub fn parse_hardware_ports(out: &str) -> Vec<(String, String)> {
    let mut ports = vec![];
    let mut name: Option<String> = None;
    for line in out.lines() {
        if let Some(n) = line.strip_prefix("Hardware Port: ") {
            name = Some(n.trim().to_string());
        } else if let (Some(d), Some(n)) = (line.strip_prefix("Device: "), name.take()) {
            ports.push((n, d.trim().to_string()));
        }
    }
    ports
}

/// An iPhone's Personal Hotspot always hands out 172.20.10.0/28 with itself at .1,
/// over Wi-Fi, USB or Bluetooth alike.
pub fn is_hotspot_gateway(gateway: Option<&str>) -> bool {
    gateway == Some("172.20.10.1")
}

/// Runs a system tool and returns its stdout (empty when it fails).
pub fn run(program: &str, args: &[&str]) -> String {
    Command::new(program)
        .args(args)
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
        .unwrap_or_default()
}

pub fn battery() -> Battery {
    parse_batt(&run("/usr/bin/pmset", &["-g", "batt"]))
}

pub fn root_domain() -> (bool, bool) {
    parse_root_domain(&run("/usr/sbin/ioreg", &["-r", "-c", "IOPMrootDomain", "-d", "1"]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn battery_on_battery_and_on_the_charger() {
        let out = "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=22806627)\t90%; discharging; 11:52 remaining present: true\n";
        assert_eq!(parse_batt(out), Battery { ac: false, percent: Some(90), charging: false, remaining_min: Some(712) });
        let ac = "Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t64%; charging; 1:05 remaining present: true\n";
        let b = parse_batt(ac);
        assert!(b.ac && b.charging);
        assert_eq!(b.percent, Some(64));
        let estimating = "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t50%; discharging; (no estimate) present: true\n";
        assert_eq!(parse_batt(estimating).remaining_min, None);
        let desktop = "Now drawing from 'AC Power'\n";
        assert_eq!(parse_batt(desktop), Battery { ac: true, ..Default::default() });
    }

    #[test]
    fn root_domain_flags() {
        let out = "+-o IOPMrootDomain\n    {\n      \"AppleClamshellCausesSleep\" = No\n      \"AppleClamshellState\" = Yes\n      \"SleepDisabled\" = No\n    }\n";
        assert_eq!(parse_root_domain(out), (true, false));
        assert_eq!(parse_root_domain(&out.replace("\"SleepDisabled\" = No", "\"SleepDisabled\" = Yes")), (true, true));
    }

    #[test]
    fn default_route_and_ports() {
        let route = "   route to: default\ndestination: default\n       mask: default\n    gateway: 172.20.10.1\n  interface: en0\n";
        let (iface, gw) = parse_route(route).unwrap();
        assert_eq!(iface, "en0");
        assert!(is_hotspot_gateway(gw.as_deref()));
        assert_eq!(parse_route("route: writing to routing socket: not in table\n"), None);
        let ports = "\nHardware Port: Wi-Fi\nDevice: en0\nEthernet Address: a\n\nHardware Port: iPhone USB\nDevice: en7\nEthernet Address: b\n";
        assert_eq!(parse_hardware_ports(ports), vec![("Wi-Fi".into(), "en0".into()), ("iPhone USB".into(), "en7".into())]);
    }
}
