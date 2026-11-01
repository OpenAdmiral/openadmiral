//! The windows as they were: where the main one sat and which floating windows were open and
//! where, for the next start. Saved shortly after each change, not on quitting: the windows
//! going away while the app quits must not count as the person closing them.
//!
//! macOS gives no public way to put a window on a given desktop, so a window returns to its
//! place on its screen but on the current desktop.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, WebviewWindow};

/// In points, as macOS places windows; the same on screens of different density.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
pub struct Frame {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    #[serde(default)]
    pub zoomed: bool,
    #[serde(default)]
    pub full: bool,
}

#[derive(Serialize, Deserialize)]
struct Floating {
    id: String,
    title: String,
    frame: Frame,
}

#[derive(Serialize, Deserialize, Default)]
struct Saved {
    main: Option<Frame>,
    #[serde(default)]
    floats: Vec<Floating>,
}

static QUITTING: AtomicBool = AtomicBool::new(false);
static PENDING: AtomicBool = AtomicBool::new(false);

fn path(app: &AppHandle) -> Option<PathBuf> {
    if crate::preview() {
        return std::env::var_os("OPENADMIRAL_WINDOWS").map(PathBuf::from);
    }
    crate::app_data_dir(app).map(|d| d.join("windows.json"))
}

fn frame_of(w: &WebviewWindow) -> Option<Frame> {
    let scale = w.scale_factor().ok()?;
    let at = w.outer_position().ok()?.to_logical::<f64>(scale);
    let size = w.inner_size().ok()?.to_logical::<f64>(scale);
    Some(Frame { x: at.x, y: at.y, w: size.width, h: size.height, zoomed: w.is_maximized().unwrap_or(false), full: w.is_fullscreen().unwrap_or(false) })
}

fn save(app: &AppHandle) {
    let Some(path) = path(app) else { return };
    let saved = Saved {
        main: app.get_webview_window("main").as_ref().and_then(frame_of),
        floats: crate::float::open_windows()
            .into_iter()
            .filter_map(|(label, id)| {
                let w = app.get_webview_window(&label)?;
                Some(Floating { id, title: w.title().unwrap_or_default(), frame: frame_of(&w)? })
            })
            .collect(),
    };
    let Ok(body) = serde_json::to_string_pretty(&saved) else { return };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let tmp = path.with_extension("json.tmp");
    if std::fs::write(&tmp, body).is_ok() {
        let _ = std::fs::rename(tmp, path);
    }
}

/// A window opened, closed, moved or changed size: saved in a moment.
pub fn changed(app: &AppHandle) {
    if QUITTING.load(Ordering::Relaxed) || PENDING.swap(true, Ordering::Relaxed) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(500));
        PENDING.store(false, Ordering::Relaxed);
        if !QUITTING.load(Ordering::Relaxed) {
            save(&app);
        }
    });
}

/// From here on windows go away because the app does.
pub fn quitting() {
    QUITTING.store(true, Ordering::Relaxed);
}

/// A screen, in points.
#[derive(Clone, Copy)]
struct Screen {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

/// Enough of the title bar on a screen to grab it; a screen since unplugged does not count.
fn reachable(f: &Frame, screens: &[Screen]) -> bool {
    let (x, y) = (f.x + f.w / 2.0, f.y + 10.0);
    screens.iter().any(|s| x >= s.x && x < s.x + s.w && y >= s.y && y < s.y + s.h)
}

fn screens(app: &AppHandle) -> Vec<Screen> {
    app.available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|m| {
            let (scale, at, size) = (m.scale_factor(), m.position(), m.size());
            Screen { x: at.x as f64 / scale, y: at.y as f64 / scale, w: size.width as f64 / scale, h: size.height as f64 / scale }
        })
        .collect()
}

pub fn apply(w: &WebviewWindow, f: &Frame) {
    if !f.zoomed && !f.full {
        let _ = w.unmaximize();
    }
    let _ = w.set_size(LogicalSize::new(f.w, f.h));
    let _ = w.set_position(LogicalPosition::new(f.x, f.y));
    if f.zoomed {
        let _ = w.maximize();
    }
    if f.full {
        let _ = w.set_fullscreen(true);
    }
}

/// At start, with the main window built: everything back where it was.
pub fn restore(app: &AppHandle) {
    let Some(saved) = path(app).and_then(|p| std::fs::read_to_string(p).ok()).and_then(|s| serde_json::from_str::<Saved>(&s).ok()) else { return };
    let screens = screens(app);
    if let (Some(f), Some(w)) = (saved.main.filter(|f| reachable(f, &screens)), app.get_webview_window("main")) {
        apply(&w, &f);
    }
    for float in saved.floats {
        let frame = Some(float.frame).filter(|f| reachable(f, &screens));
        if let Err(e) = crate::float::open(app, &float.id, &float.title, frame.as_ref()) {
            eprintln!("floating window {} did not come back: {e}", float.id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FRAME: Frame = Frame { x: 100.0, y: 50.0, w: 900.0, h: 680.0, zoomed: false, full: false };

    #[test]
    fn a_window_on_a_screen_stays_there() {
        let laptop = Screen { x: 0.0, y: 0.0, w: 1512.0, h: 982.0 };
        let right = Screen { x: 1512.0, y: 0.0, w: 2560.0, h: 1440.0 };
        assert!(reachable(&FRAME, &[laptop]));
        assert!(reachable(&Frame { x: 2000.0, ..FRAME }, &[laptop, right]));
    }

    #[test]
    fn a_screen_unplugged_does_not_keep_it() {
        let laptop = Screen { x: 0.0, y: 0.0, w: 1512.0, h: 982.0 };
        assert!(!reachable(&Frame { x: 2000.0, ..FRAME }, &[laptop]));
        assert!(!reachable(&Frame { y: -500.0, ..FRAME }, &[laptop]));
    }

    #[test]
    fn reads_a_file_without_the_optional_fields() {
        let s: Saved = serde_json::from_str(r#"{"main":{"x":1,"y":2,"w":3,"h":4}}"#).unwrap();
        assert_eq!(s.main.unwrap().zoomed, false);
        assert!(s.floats.is_empty());
    }
}
