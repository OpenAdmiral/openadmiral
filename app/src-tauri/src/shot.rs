//! Preview screenshots without Screen Recording permission: with
//! `OPENADMIRAL_SHOT=<file.png>` a preview instance snapshots its own webview after
//! `OPENADMIRAL_SHOT_DELAY` seconds (default 5), writes the PNG and quits.

use std::time::Duration;
use tauri::{AppHandle, Manager};

/// A preview usually opens hidden (behind the app, or on another Space), where
/// WebKit stops animation frames and ResizeObserver after a second: transitions
/// and measured lists freeze half-drawn. Turn its occlusion detection off.
pub fn keep_rendering(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.with_webview(|webview| {
            #[cfg(target_os = "macos")]
            // SAFETY: `inner` is the live WKWebView, on the main thread; the private
            // selector exists since macOS 10.13 and is checked before it is sent.
            unsafe {
                use objc2::runtime::{AnyObject, Sel};
                let view = &*(webview.inner() as *const AnyObject);
                let sel = Sel::register(c"_setWindowOcclusionDetectionEnabled:");
                let responds: bool = objc2::msg_send![view, respondsToSelector: sel];
                if responds {
                    let _: () = objc2::msg_send![view, _setWindowOcclusionDetectionEnabled: false];
                }
            }
        });
    }
}

pub fn schedule(app: AppHandle, path: String) {
    let delay = std::env::var("OPENADMIRAL_SHOT_DELAY").ok().and_then(|s| s.parse().ok()).unwrap_or(5.0);
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs_f64(delay));
        let Some(window) = app.get_webview_window("main") else {
            eprintln!("shot: no main window");
            return app.exit(1);
        };
        let done = app.clone();
        if let Err(e) = window.with_webview(move |webview| snapshot(webview, path, done)) {
            eprintln!("shot: {e}");
            app.exit(1);
        }
    });
}

#[cfg(target_os = "macos")]
fn snapshot(webview: tauri::webview::PlatformWebview, path: String, app: AppHandle) {
    use block2::RcBlock;
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSImage};
    use objc2_foundation::{NSDictionary, NSError};
    use objc2_web_kit::WKWebView;

    let handler = RcBlock::new(move |image: *mut NSImage, _error: *mut NSError| {
        // SAFETY: WebKit hands the snapshot (or null) to the handler on the main thread.
        let png = unsafe { image.as_ref() }
            .and_then(|image| image.TIFFRepresentation())
            .and_then(|tiff| NSBitmapImageRep::imageRepWithData(&tiff))
            .and_then(|rep| unsafe { rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &NSDictionary::new()) });
        let written = png.map(|data| std::fs::write(&path, data.to_vec()));
        match written {
            Some(Ok(())) => app.exit(0),
            Some(Err(e)) => {
                eprintln!("shot: {path}: {e}");
                app.exit(1)
            }
            None => {
                eprintln!("shot: no image");
                app.exit(1)
            }
        }
    });
    // SAFETY: `inner` is the window's live WKWebView; with_webview runs this on the main thread.
    unsafe {
        let view = &*(webview.inner() as *const WKWebView);
        view.takeSnapshotWithConfiguration_completionHandler(None, &handler);
    }
}

#[cfg(not(target_os = "macos"))]
fn snapshot(_webview: tauri::webview::PlatformWebview, _path: String, app: AppHandle) {
    eprintln!("shot: macOS only");
    app.exit(1);
}
