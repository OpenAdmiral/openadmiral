//! Mission Control and App Exposé: the Dock posts `com.apple.expose.awake` (and
//! `com.apple.expose.front.awake`) as they open. Every window then shows its agent's
//! name large, so the thumbnails say who is who; the UI hides it again on the next
//! pointer move, key or focus change (there is no notice when Mission Control closes).

use tauri::{AppHandle, Emitter};

#[cfg(target_os = "macos")]
pub fn watch(app: &AppHandle) {
    use block2::RcBlock;
    use objc2_foundation::{NSDistributedNotificationCenter, NSNotification, NSOperationQueue, NSString};
    use std::ptr::NonNull;

    let center = NSDistributedNotificationCenter::defaultCenter();
    for name in ["com.apple.expose.awake", "com.apple.expose.front.awake"] {
        let app = app.clone();
        let block = RcBlock::new(move |_: NonNull<NSNotification>| {
            let _ = app.emit("openadmiral://mission-control", ());
        });
        let observer = unsafe { center.addObserverForName_object_queue_usingBlock(Some(&NSString::from_str(name)), None, Some(&NSOperationQueue::mainQueue()), &block) };
        // Observes for the app's whole life.
        std::mem::forget(observer);
    }
}

#[cfg(not(target_os = "macos"))]
pub fn watch(_: &AppHandle) {}
