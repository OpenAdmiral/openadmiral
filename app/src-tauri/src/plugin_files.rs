//! Which OpenAdmiral plugin code is current. A Claude Code session keeps the plugin
//! it loaded until `/reload-plugins`, so after an update (or an edit, in development)
//! older sessions run old code. Each session says when it loaded its plugin
//! (`plugin.loadedAt`, docs/CONTRACT.md); the app compares that with when the
//! plugin's files last changed and offers to reload the ones behind.

use serde_json::Value;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

fn read(path: &Path) -> Option<Value> {
    std::fs::read_to_string(path).ok().and_then(|s| serde_json::from_str(&s).ok())
}

/// The plugin's folder: the `./plugin` of a directory marketplace (this repo, in
/// development), else the copy Claude Code installed from the marketplace.
fn plugin_dir() -> Option<PathBuf> {
    let plugins = crate::claude_home().join("plugins");
    let source = read(&plugins.join("known_marketplaces.json")).and_then(|m| m.get("openadmiral")?.get("source").cloned());
    if source.as_ref().and_then(|s| s.get("source")).and_then(Value::as_str) == Some("directory") {
        let root = PathBuf::from(source?.get("path")?.as_str()?);
        let manifest = read(&root.join(".claude-plugin/marketplace.json"))?;
        let rel = manifest.get("plugins")?.as_array()?.iter().find(|p| p.get("name").and_then(Value::as_str) == Some("openadmiral"))?.get("source")?.as_str()?.to_string();
        return Some(root.join(rel));
    }
    let installed = read(&plugins.join("installed_plugins.json"))?;
    let entry = installed.get("plugins").unwrap_or(&installed).get("openadmiral@openadmiral")?;
    let first = entry.as_array().and_then(|a| a.first()).unwrap_or(entry);
    Some(PathBuf::from(first.get("installPath")?.as_str()?))
}

/// Newest modification time (epoch ms) of the files a session loads: hooks/ and the manifest.
fn newest(dir: &Path) -> Option<i64> {
    let mut best: Option<i64> = None;
    let mut stack = vec![dir.join("hooks"), dir.join(".claude-plugin")];
    while let Some(d) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&d) else { continue };
        for e in entries.filter_map(|e| e.ok()) {
            let Ok(meta) = e.metadata() else { continue };
            if meta.is_dir() {
                stack.push(e.path());
            } else if let Some(ms) = meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as i64) {
                best = Some(best.map_or(ms, |b| b.max(ms)));
            }
        }
    }
    best
}

/// Installed from GitHub (not this repo's folder, which loads in place): Claude Code
/// only updates it on request, as auto-update is off for marketplaces other than its own.
fn from_github() -> bool {
    let known = read(&crate::claude_home().join("plugins").join("known_marketplaces.json"));
    known
        .as_ref()
        .and_then(|m| m.get("openadmiral")?.pointer("/source/source")?.as_str().map(String::from))
        .is_some_and(|s| s != "directory")
}

/// Keeps the installed plugin current: at launch and every six hours, refreshes the
/// marketplace and updates the plugin (its version is the commit, so every release is
/// an update). Sessions then show as running an older plugin and offer Reload.
pub fn keep_updated() {
    if crate::preview() {
        return;
    }
    std::thread::spawn(|| loop {
        std::thread::sleep(std::time::Duration::from_secs(60));
        if from_github() && crate::claude_bin().is_some() {
            let _ = crate::claude_cmd().args(["plugin", "marketplace", "update", "openadmiral"]).output();
            let _ = crate::claude_cmd().args(["plugin", "update", "openadmiral@openadmiral"]).output();
        }
        std::thread::sleep(std::time::Duration::from_secs(6 * 3600));
    });
}

/// When the plugin's code last changed (epoch ms), if it can be found.
#[tauri::command]
pub fn plugin_changed_at() -> Option<i64> {
    newest(&plugin_dir()?)
}

/// Reloads the plugin in these sessions: `/reload-plugins` as a Run now item in
/// each one's Up next (a plugin old enough to need it still serves its queue).
/// Returns how many were queued.
#[tauri::command]
pub fn plugin_reload(session_ids: Vec<String>) -> Result<usize, String> {
    if crate::preview() {
        return Ok(0);
    }
    let now = crate::underway::now_ms();
    let mut queued = 0;
    let mut last_err = None;
    for id in &session_ids {
        match crate::resume::enqueue(id, "/reload-plugins", now) {
            Ok(()) => queued += 1,
            Err(e) => last_err = Some(e),
        }
    }
    match (queued, last_err) {
        (0, Some(e)) => Err(e),
        _ => Ok(queued),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn newest_looks_at_hooks_and_the_manifest_only() {
        let dir = std::env::temp_dir().join(format!("oa-plugin-files-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("hooks")).unwrap();
        std::fs::create_dir_all(dir.join("tests")).unwrap();
        assert_eq!(newest(&dir), None);
        std::fs::write(dir.join("hooks/register.tsx"), "x").unwrap();
        let hooks = newest(&dir).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        std::fs::write(dir.join("tests/delegate.test.ts"), "y").unwrap();
        assert_eq!(newest(&dir), Some(hooks), "tests do not count: sessions never load them");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
