//! Artifacts the agents show the user (`~/.claude/openadmiral/artifacts/<session>/<id>/`,
//! written by the mod's `show` tool), and the in-app browser for claude.ai links.

use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

pub fn root() -> PathBuf {
    crate::admiral_dir().join("artifacts")
}

/// Every manifest, with `dir` added: the folder its version files live in.
pub fn read_all() -> Vec<Value> {
    let mut out = vec![];
    let Ok(sessions) = std::fs::read_dir(root()) else { return out };
    for s in sessions.filter_map(|e| e.ok()) {
        let Ok(items) = std::fs::read_dir(s.path()) else { continue };
        for a in items.filter_map(|e| e.ok()) {
            let manifest = a.path().join("manifest.json");
            if let Some(mut v) = std::fs::read_to_string(&manifest).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()) {
                v["dir"] = Value::from(a.path().to_string_lossy().to_string());
                out.push(v);
            }
        }
    }
    out
}

/// One path segment from the UI: no separators, no `..`.
fn segment(s: &str) -> Result<&str, String> {
    if s.is_empty() || s.contains('/') || s.contains('\\') || s == "." || s == ".." || s.starts_with('.') {
        return Err(format!("bad path segment: {s}"));
    }
    Ok(s)
}

fn artifact_dir(session_id: &str, id: &str) -> Result<PathBuf, String> {
    Ok(root().join(segment(session_id)?).join(segment(id)?))
}

fn version_file(session_id: &str, id: &str, file: &str) -> Result<PathBuf, String> {
    let p = artifact_dir(session_id, id)?.join(segment(file)?);
    if !p.is_file() {
        return Err("That version's file is missing.".into());
    }
    Ok(p)
}

/// A text version (html, markdown, mermaid, diff, text), up to 8 MB.
#[tauri::command]
pub fn artifact_text(session_id: String, id: String, file: String) -> Result<String, String> {
    let p = version_file(&session_id, &id, &file)?;
    if std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0) > 8 * 1024 * 1024 {
        return Err("Too large to show inline; open it in its app.".into());
    }
    std::fs::read_to_string(p).map_err(|e| e.to_string())
}

/// open: the default app · reveal: Finder · copy: the clipboard · delete: the whole artifact.
#[tauri::command]
pub fn artifact_action(session_id: String, id: String, file: Option<String>, action: String) -> Result<(), String> {
    match action.as_str() {
        "delete" => {
            if crate::preview() {
                return Ok(());
            }
            let dir = artifact_dir(&session_id, &id)?;
            std::fs::remove_dir_all(dir).map_err(|e| e.to_string())
        }
        "open" | "reveal" | "copy" => {
            let p = version_file(&session_id, &id, file.as_deref().ok_or("which version?")?)?;
            let status = match action.as_str() {
                "open" => Command::new("open").arg(&p).status(),
                "reveal" => Command::new("open").arg("-R").arg(&p).status(),
                _ => copy(&p),
            };
            status.map_err(|e| e.to_string()).and_then(|s| if s.success() { Ok(()) } else { Err(format!("{action} failed")) })
        }
        _ => Err(format!("unknown action {action}")),
    }
}

/// Images go to the clipboard as pictures, everything else as text.
fn copy(p: &Path) -> std::io::Result<std::process::ExitStatus> {
    let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
    let class = match ext.as_str() {
        "png" => Some("«class PNGf»"),
        "jpg" | "jpeg" => Some("JPEG picture"),
        "gif" => Some("GIF picture"),
        "tif" | "tiff" => Some("TIFF picture"),
        _ => None,
    };
    match class {
        Some(c) => Command::new("osascript")
            .arg("-e")
            .arg(format!("set the clipboard to (read (POSIX file \"{}\") as {c})", p.display().to_string().replace('"', "\\\"")))
            .status(),
        None => {
            let text = std::fs::read(p)?;
            let mut child = Command::new("pbcopy").stdin(std::process::Stdio::piped()).spawn()?;
            std::io::Write::write_all(child.stdin.as_mut().unwrap(), &text)?;
            child.wait()
        }
    }
}

/// claude.ai pages (artifacts, docs) in a window of their own: top-level
/// navigation, the app's persistent web data (one sign-in), and no access to
/// the app — capabilities name only the main window.
#[tauri::command]
pub fn browser_open(app: AppHandle, url: String) -> Result<(), String> {
    let parsed: tauri::Url = url.parse().map_err(|_| "not a URL")?;
    if parsed.scheme() != "https" {
        return Err("only https links".into());
    }
    if let Some(w) = app.get_webview_window("browser") {
        w.navigate(parsed).map_err(|e| e.to_string())?;
        let _ = w.show();
        let _ = w.set_focus();
        return Ok(());
    }
    WebviewWindowBuilder::new(&app, "browser", WebviewUrl::External(parsed))
        .title("OpenAdmiral · claude.ai")
        .inner_size(1180.0, 820.0)
        .min_inner_size(640.0, 480.0)
        .build()
        .map(|_| ())
        .map_err(|e| e.to_string())
}
