//! Mission Control and App Exposé: while either is open, the Dock puts a window of
//! its own, the size of the screen, at window layer 20 (macOS posts no notice an app
//! can hear; `com.apple.expose.awake` is in the Dock but never reaches apps). A thread
//! looks for that window eight times a second and tells every window when it comes and
//! goes, so each agent view shows its name large exactly while Mission Control is up.

use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

const EVERY: Duration = Duration::from_millis(120);
/// The Dock's own layer for Mission Control's backdrop (the Dock bar itself sits higher).
const MISSION_LAYER: i64 = 20;

/// The Dock's windows on screen: (layer, width, height).
#[cfg(target_os = "macos")]
fn dock_windows() -> Vec<(i64, f64, f64)> {
    use core_foundation::base::{CFType, TCFType};
    use core_foundation::dictionary::{CFDictionary, CFDictionaryRef};
    use core_foundation::number::CFNumber;
    use core_foundation::string::CFString;
    use core_graphics::window::{copy_window_info, kCGNullWindowID, kCGWindowBounds, kCGWindowLayer, kCGWindowListOptionOnScreenOnly, kCGWindowOwnerName};

    let Some(list) = copy_window_info(kCGWindowListOptionOnScreenOnly, kCGNullWindowID) else { return vec![] };
    let (owner_key, layer_key, bounds_key) =
        unsafe { (CFString::wrap_under_get_rule(kCGWindowOwnerName), CFString::wrap_under_get_rule(kCGWindowLayer), CFString::wrap_under_get_rule(kCGWindowBounds)) };
    let mut out = Vec::new();
    for item in list.iter() {
        let dict: CFDictionary<CFString, CFType> = unsafe { CFDictionary::wrap_under_get_rule(*item as CFDictionaryRef) };
        let owner = dict.find(&owner_key).and_then(|v| v.downcast::<CFString>()).map(|s| s.to_string());
        if owner.as_deref() != Some("Dock") {
            continue;
        }
        let layer = dict.find(&layer_key).and_then(|v| v.downcast::<CFNumber>()).and_then(|n| n.to_i64()).unwrap_or(-1);
        let size = dict.find(&bounds_key).and_then(|v| v.downcast::<CFDictionary>()).map(|b| {
            let b: CFDictionary<CFString, CFType> = unsafe { CFDictionary::wrap_under_get_rule(b.as_concrete_TypeRef()) };
            let num = |k: &str| b.find(CFString::new(k)).and_then(|v| v.downcast::<CFNumber>()).and_then(|n| n.to_f64()).unwrap_or(0.0);
            (num("Width"), num("Height"))
        });
        let (w, h) = size.unwrap_or((0.0, 0.0));
        out.push((layer, w, h));
    }
    out
}

/// Mission Control is up: the Dock has a screen-sized window at its backdrop layer.
pub fn is_open(windows: &[(i64, f64, f64)]) -> bool {
    windows.iter().any(|&(layer, w, h)| layer == MISSION_LAYER && w >= 640.0 && h >= 400.0)
}

#[cfg(target_os = "macos")]
pub fn watch(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let mut was = false;
        loop {
            let now = is_open(&dock_windows());
            if now != was {
                was = now;
                // Mission Control counts a window it shows as hidden, and WebKit stops
                // drawing a hidden webview: keep every window drawing while it is up.
                for (_, w) in app.webview_windows() {
                    let _ = w.with_webview(move |webview| occlusion_detection(webview.inner(), !now));
                }
                let _ = app.emit("openadmiral://mission-control", now);
            }
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
    /// `cargo test --lib mission::tests::live -- --ignored --nocapture`: the Dock's windows right now.
    #[test]
    #[ignore]
    #[cfg(target_os = "macos")]
    fn live() {
        let w = super::dock_windows();
        println!("dock windows: {w:?} → open: {}", super::is_open(&w));
    }

    #[test]
    fn only_a_screen_sized_backdrop_counts() {
        assert!(super::is_open(&[(20, 1512.0, 982.0), (25, 1512.0, 70.0)]));
        assert!(!super::is_open(&[(25, 1512.0, 70.0)]));
        assert!(!super::is_open(&[(20, 300.0, 40.0)]));
        assert!(!super::is_open(&[]));
    }
}
