//! One-time move of the data this app kept while it was called Fleet:
//! `~/.claude/fleet` → `~/.claude/openadmiral` and the app data directory
//! `com.applivery.fleet` → `com.openadmiral.desktop`. Runs before anything
//! reads either place; entries already present at the new location win.

use std::path::Path;

const LEGACY_ID: &str = "com.applivery.fleet";
const ID: &str = "com.openadmiral.desktop";

pub fn legacy() {
    merge(&crate::claude_home().join("fleet"), &crate::admiral_dir());
    if let Some(data) = dirs::data_dir() {
        merge(&data.join(LEGACY_ID), &data.join(ID));
    }
}

/// Moves every entry of `from` into `to` that `to` does not have yet, merging
/// directories present on both sides, then drops `from` once it is empty.
fn merge(from: &Path, to: &Path) {
    let Ok(entries) = std::fs::read_dir(from) else { return };
    if std::fs::create_dir_all(to).is_err() {
        return;
    }
    for entry in entries.flatten() {
        let dest = to.join(entry.file_name());
        if !dest.exists() {
            let _ = std::fs::rename(entry.path(), &dest);
        } else if entry.path().is_dir() && dest.is_dir() {
            merge(&entry.path(), &dest);
        }
    }
    let _ = std::fs::remove_dir(from); // only succeeds when nothing was left behind
}

#[cfg(test)]
mod tests {
    use super::merge;

    #[test]
    fn moves_missing_entries_and_keeps_newer_ones() {
        let root = std::env::temp_dir().join(format!("admiral-migrate-{}", std::process::id()));
        let (old, new) = (root.join("fleet"), root.join("openadmiral"));
        std::fs::create_dir_all(old.join("sessions")).unwrap();
        std::fs::create_dir_all(old.join("artifacts/s1")).unwrap();
        std::fs::write(old.join("sessions/a.json"), "old a").unwrap();
        std::fs::write(old.join("sessions/b.json"), "old b").unwrap();
        std::fs::write(old.join("artifacts/s1/manifest.json"), "m").unwrap();
        std::fs::create_dir_all(new.join("sessions")).unwrap();
        std::fs::write(new.join("sessions/a.json"), "new a").unwrap();

        merge(&old, &new);

        assert_eq!(std::fs::read_to_string(new.join("sessions/a.json")).unwrap(), "new a");
        assert_eq!(std::fs::read_to_string(new.join("sessions/b.json")).unwrap(), "old b");
        assert_eq!(std::fs::read_to_string(new.join("artifacts/s1/manifest.json")).unwrap(), "m");
        assert!(old.join("sessions/a.json").exists(), "a conflicting old file stays put");
        assert!(!old.join("artifacts").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn missing_source_is_a_no_op() {
        let root = std::env::temp_dir().join(format!("admiral-migrate-none-{}", std::process::id()));
        merge(&root.join("nothing"), &root.join("dest"));
        assert!(!root.join("dest").exists());
    }
}
