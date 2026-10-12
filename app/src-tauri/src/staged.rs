//! A build staged next to the app (`OpenAdmiral.app.new`, from `scripts/install.sh
//! --when-quit`) goes in when the app quits: on exit the app starts a detached swapper
//! that waits for this process to end, replaces the bundle and reopens it. The app
//! is started by launchd, so the swapper outlives it whatever started the install.
//! install.sh's own watcher (for builds older than this) shares the lock directory,
//! so a staged build is swapped in once.

use std::path::PathBuf;
use std::process::{Command, Stdio};

/// Waits for `$3` (a pid) to exit, then swaps `$2` in for `$1` under a lock and
/// reopens it in a clean environment. Kept in step with install.sh's watcher.
const SWAP: &str = r#"
for i in {1..600}; do kill -0 "$3" 2>/dev/null || break; sleep 0.1; done
mkdir "$2.lock" 2>/dev/null || { echo "$(date "+%F %T") another swapper has it"; exit 0; }
trap 'rmdir "$2.lock" 2>/dev/null' EXIT
[[ -d "$2" ]] || { echo "$(date "+%F %T") nothing staged"; exit 0; }
echo "$(date "+%F %T") swapping in the staged build (app quit)"
rm -rf "$1" && mv "$2" "$1" && env -i HOME="$HOME" USER="$USER" LOGNAME="$LOGNAME" PATH=/usr/bin:/bin:/usr/sbin:/sbin /usr/bin/open "$1"
"#;

/// This app's bundle, and the staged one beside it if there is one.
fn paths() -> Option<(PathBuf, PathBuf)> {
    let exe = std::env::current_exe().ok()?;
    let bundle = exe.parent()?.parent()?.parent()?.to_path_buf();
    if bundle.extension()? != "app" {
        return None;
    }
    let staged = PathBuf::from(format!("{}.new", bundle.display()));
    staged.is_dir().then_some((bundle, staged))
}

/// On quit: hand a staged build to a detached swapper. Nothing staged, nothing done.
pub fn swap_on_exit() {
    if crate::preview() {
        return;
    }
    let Some((bundle, staged)) = paths() else { return };
    let log = dirs::home_dir().map(|h| h.join("Library/Logs/OpenAdmiral/install.log"));
    let out = log
        .and_then(|p| {
            let _ = std::fs::create_dir_all(p.parent()?);
            std::fs::OpenOptions::new().create(true).append(true).open(p).ok()
        })
        .map(Stdio::from)
        .unwrap_or_else(Stdio::null);
    // Its own session (setsid via perl, always on macOS), detached from this process.
    let _ = Command::new("/usr/bin/perl")
        .args(["-MPOSIX", "-e", "POSIX::setsid(); exec @ARGV", "/bin/zsh", "-c", SWAP, "_"])
        .arg(&bundle)
        .arg(&staged)
        .arg(std::process::id().to_string())
        .stdin(Stdio::null())
        .stdout(out)
        .stderr(Stdio::null())
        .spawn();
}
