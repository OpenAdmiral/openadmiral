//! Mission Control and App Exposé: while either is open, the Dock puts a window of
//! its own, the size of the screen, at window layer 20 (macOS posts no notice an app
//! can hear; `com.apple.expose.awake` is in the Dock but never reaches apps). A thread
//! looks for that window eight times a second and tells every window when it comes and
//! goes, so each agent view shows its name exactly while Mission Control is up.
//!
//! Picking a window ends Mission Control with an animation the Dock's window outlives:
//! the first window of ours to be focused calls `mission_dismiss`, and every window drops
//! its card at once instead of waiting for the Dock.

use std::io::Write;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

const EVERY: Duration = Duration::from_millis(120);
/// The Dock's own layer for Mission Control's backdrop (the Dock bar itself sits higher).
const MISSION_LAYER: i64 = 20;

/// Up, as the windows were last told.
static SHOWN: AtomicBool = AtomicBool::new(false);

/// One of the Dock's windows on screen.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DockWindow {
    pub layer: i64,
    pub w: f64,
    pub h: f64,
    pub alpha: f64,
}

#[cfg(target_os = "macos")]
fn dock_windows() -> Vec<DockWindow> {
    use core_foundation::base::{CFType, TCFType};
    use core_foundation::dictionary::{CFDictionary, CFDictionaryRef};
    use core_foundation::number::CFNumber;
    use core_foundation::string::CFString;
    use core_graphics::window::{copy_window_info, kCGNullWindowID, kCGWindowAlpha, kCGWindowBounds, kCGWindowLayer, kCGWindowListOptionOnScreenOnly, kCGWindowOwnerName};

    let Some(list) = copy_window_info(kCGWindowListOptionOnScreenOnly, kCGNullWindowID) else { return vec![] };
    let (owner_key, layer_key, bounds_key, alpha_key) = unsafe {
        (
            CFString::wrap_under_get_rule(kCGWindowOwnerName),
            CFString::wrap_under_get_rule(kCGWindowLayer),
            CFString::wrap_under_get_rule(kCGWindowBounds),
            CFString::wrap_under_get_rule(kCGWindowAlpha),
        )
    };
    let num = |d: &CFDictionary<CFString, CFType>, k: &CFString| d.find(k).and_then(|v| v.downcast::<CFNumber>()).and_then(|n| n.to_f64());
    let mut out = Vec::new();
    for item in list.iter() {
        let dict: CFDictionary<CFString, CFType> = unsafe { CFDictionary::wrap_under_get_rule(*item as CFDictionaryRef) };
        let owner = dict.find(&owner_key).and_then(|v| v.downcast::<CFString>()).map(|s| s.to_string());
        if owner.as_deref() != Some("Dock") {
            continue;
        }
        let layer = num(&dict, &layer_key).map(|l| l as i64).unwrap_or(-1);
        let alpha = num(&dict, &alpha_key).unwrap_or(1.0);
        let (w, h) = dict
            .find(&bounds_key)
            .and_then(|v| v.downcast::<CFDictionary>())
            .map(|b| {
                let b: CFDictionary<CFString, CFType> = unsafe { CFDictionary::wrap_under_get_rule(b.as_concrete_TypeRef()) };
                (num(&b, &CFString::new("Width")).unwrap_or(0.0), num(&b, &CFString::new("Height")).unwrap_or(0.0))
            })
            .unwrap_or((0.0, 0.0));
        out.push(DockWindow { layer, w, h, alpha });
    }
    out
}

/// The Dock's Mission Control backdrop, if it is up: screen-sized, at its layer.
pub fn backdrop(windows: &[DockWindow]) -> Option<DockWindow> {
    windows.iter().copied().find(|d| d.layer == MISSION_LAYER && d.w >= 640.0 && d.h >= 400.0)
}

fn tell(app: &AppHandle, on: bool) {
    if SHOWN.swap(on, Ordering::SeqCst) == on {
        return;
    }
    // Mission Control counts a window it shows as hidden, and WebKit stops drawing a
    // hidden webview: keep every window drawing while it is up.
    for (_, w) in app.webview_windows() {
        let _ = w.with_webview(move |webview| occlusion_detection(webview.inner(), !on));
    }
    let _ = app.emit("openadmiral://mission-control", on);
}

/// A window of ours came forward while Mission Control showed: every window drops its card now.
#[tauri::command]
pub fn mission_dismiss(app: AppHandle) {
    if SHOWN.load(Ordering::SeqCst) {
        log("dismissed: a window of ours was picked");
        tell(&app, false);
    }
}

/// What each window saw, to check it against a real Mission Control (~/Library/Logs/OpenAdmiral/mission.log).
#[tauri::command]
pub fn mission_log(message: String) {
    log(&message);
}

fn log(message: &str) {
    let Some(home) = std::env::var_os("HOME") else { return };
    let dir = std::path::Path::new(&home).join("Library/Logs/OpenAdmiral");
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join("mission.log");
    // Kept small: a fresh file past 200 KB.
    if std::fs::metadata(&path).map(|m| m.len() > 200_000).unwrap_or(false) {
        let _ = std::fs::remove_file(&path);
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let t = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
        let _ = writeln!(f, "{t} {message}");
    }
}

#[cfg(target_os = "macos")]
pub fn watch(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let mut last: Option<DockWindow> = None;
        loop {
            let now = backdrop(&dock_windows());
            if now != last {
                log(&format!("dock backdrop {now:?}"));
                // Up when it appears (not again after a pick dismissed it), down when it goes.
                if now.is_some() != last.is_some() {
                    tell(&app, now.is_some());
                }
            }
            last = now;
            std::thread::sleep(EVERY);
        }
    });
}

/// WebKit's own switch (as for screenshots, shot.rs): off, the webview draws even when
/// macOS says its window is covered.
#[cfg(target_os = "macos")]
fn occlusion_detection(view: *mut std::ffi::c_void, enabled: bool) {
    // SAFETY: `view` is the live WKWebView, on the main thread; the private selector
    // exists since macOS 10.13 and is checked before it is sent.
    unsafe {
        use objc2::runtime::{AnyObject, Bool, Sel};
        let view = &*(view as *const AnyObject);
        let sel = Sel::register(c"_setWindowOcclusionDetectionEnabled:");
        let responds: bool = objc2::msg_send![view, respondsToSelector: sel];
        if responds {
            let _: () = objc2::msg_send![view, _setWindowOcclusionDetectionEnabled: Bool::new(enabled)];
        }
    }
}

#[cfg(not(target_os = "macos"))]
pub fn watch(_: &AppHandle) {}

#[cfg(test)]
mod tests {
    use super::DockWindow;

    /// `cargo test --lib mission::tests::live -- --ignored --nocapture`: the Dock's windows right now.
    #[test]
    #[ignore]
    #[cfg(target_os = "macos")]
    fn live() {
        let w = super::dock_windows();
        println!("dock windows: {w:?} → backdrop: {:?}", super::backdrop(&w));
    }

    #[test]
    fn only_a_screen_sized_backdrop_counts() {
        let d = |layer, w, h| DockWindow { layer, w, h, alpha: 1.0 };
        assert!(super::backdrop(&[d(20, 1512.0, 982.0), d(25, 1512.0, 70.0)]).is_some());
        assert!(super::backdrop(&[d(25, 1512.0, 70.0)]).is_none());
        assert!(super::backdrop(&[d(20, 300.0, 40.0)]).is_none());
        assert!(super::backdrop(&[]).is_none());
    }
}
