//! Anonymous usage ping, so the project knows how many installs exist and how many
//! were used in the last 30 days. At launch and every 24 h it POSTs
//! `{ id, version, os, osVersion, arch }` to openadmiral.com/api/ping, where `id` is a
//! random UUID made on first launch. Nothing else: no names, paths, sessions or
//! prompts. Off with Help → Share Anonymous Usage Stats, OPENADMIRAL_TELEMETRY=0 or
//! DO_NOT_TRACK; never from a preview instance.

use std::path::PathBuf;
use std::process::Command;
use std::time::Duration;
use tauri::AppHandle;

const URL: &str = "https://openadmiral.com/api/ping";
const EVERY: Duration = Duration::from_secs(24 * 3600);

fn file(app: &AppHandle, name: &str) -> Option<PathBuf> {
    crate::app_data_dir(app).map(|d| d.join(name))
}

/// The person's choice from the Help menu (on unless switched off).
pub fn enabled(app: &AppHandle) -> bool {
    file(app, "telemetry-off").is_some_and(|p| !p.exists())
}

pub fn set_enabled(app: &AppHandle, on: bool) {
    let Some(path) = file(app, "telemetry-off") else { return };
    if on {
        let _ = std::fs::remove_file(path);
    } else {
        let _ = std::fs::create_dir_all(path.parent().unwrap());
        let _ = std::fs::write(path, "");
    }
}

fn allowed_by_env() -> bool {
    let off = |k: &str| std::env::var(k).is_ok_and(|v| !v.is_empty() && v != "0" && v != "false");
    !crate::preview() && !off("DO_NOT_TRACK") && std::env::var("OPENADMIRAL_TELEMETRY").map_or(true, |v| v != "0" && v != "false")
}

/// A random version-4 UUID, from the system's random source.
fn new_id() -> Option<String> {
    let mut b = [0u8; 16];
    use std::io::Read;
    std::fs::File::open("/dev/urandom").ok()?.read_exact(&mut b).ok()?;
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h: String = b.iter().map(|x| format!("{x:02x}")).collect();
    Some(format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32]))
}

fn install_id(app: &AppHandle) -> Option<String> {
    let path = file(app, "install-id")?;
    if let Ok(id) = std::fs::read_to_string(&path) {
        let id = id.trim().to_string();
        if id.len() == 36 {
            return Some(id);
        }
    }
    let id = new_id()?;
    std::fs::create_dir_all(path.parent()?).ok()?;
    std::fs::write(&path, &id).ok()?;
    Some(id)
}

fn os_version() -> String {
    Command::new("sw_vers")
        .arg("-productVersion")
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default()
}

fn ping(app: &AppHandle) {
    if !allowed_by_env() || !enabled(app) {
        return;
    }
    let Some(id) = install_id(app) else { return };
    let body = serde_json::json!({
        "id": id,
        "version": app.package_info().version.to_string(),
        "os": "macos",
        "osVersion": os_version(),
        "arch": std::env::consts::ARCH,
    })
    .to_string();
    // curl ships with macOS: no HTTP client in the app for one small POST.
    let _ = Command::new("curl")
        .args(["-s", "-o", "/dev/null", "-m", "10", "-X", "POST", "-H", "content-type: application/json", "--data", &body, URL])
        .status();
}

pub fn start(app: AppHandle) {
    if !allowed_by_env() {
        return;
    }
    std::thread::spawn(move || loop {
        ping(&app);
        std::thread::sleep(EVERY);
    });
}

#[cfg(test)]
mod tests {
    #[test]
    fn ids_are_uuid_v4() {
        let id = super::new_id().unwrap();
        assert_eq!(id.len(), 36);
        assert_eq!(&id[14..15], "4");
        assert!(matches!(&id[19..20], "8" | "9" | "a" | "b"));
    }
}
