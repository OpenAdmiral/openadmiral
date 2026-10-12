#!/bin/zsh
# Builds OpenAdmiral and installs it as ~/Applications/OpenAdmiral.app.
#
# Development builds land in src-tauri/target/…/OpenAdmiral.app and are rewritten on
# every build, which makes macOS kill a copy running from there. You run the
# installed copy instead; this script only replaces it while it is not running.
#
#   scripts/install.sh            build (debug bundle) and install
#   scripts/install.sh --no-build install the bundle already built
#   add --when-quit               if OpenAdmiral is running, swap in the new build as
#                                 soon as the user quits it (⌘Q) and reopen it (the app
#                                 does it itself from 0.1.3 on; this watcher covers older
#                                 builds, and a lock keeps it to one swap)
#
# Signing: with a Developer ID in the keychain, name it in OPENADMIRAL_SIGNING_IDENTITY
# or in ~/.config/openadmiral/signing-identity (one line, as `security find-identity`
# prints it). A signed build keeps the permissions macOS granted (Desktop files,
# notifications) from one install to the next, and can install Underway's helper.
# Without one it is ad-hoc signed: every build is a new app to macOS.
set -euo pipefail

BUILD=1 WHEN_QUIT=0
for arg in "$@"; do
  case "$arg" in
    --no-build) BUILD=0 ;;
    --when-quit) WHEN_QUIT=1 ;;
    *) echo "Unknown option: $arg" >&2; exit 1 ;;
  esac
done

APP_DIR=${0:A:h:h}
DEST="$HOME/Applications/OpenAdmiral.app"
STAGE="$HOME/Applications/OpenAdmiral.app.new"
BUNDLE="$APP_DIR/src-tauri/target/debug/bundle/macos/OpenAdmiral.app"

IDENTITY=${OPENADMIRAL_SIGNING_IDENTITY:-}
ID_FILE="$HOME/.config/openadmiral/signing-identity"
[[ -z "$IDENTITY" && -f "$ID_FILE" ]] && IDENTITY=$(<"$ID_FILE")

if (( BUILD )); then
  export PATH="$HOME/.cargo/bin:$PATH"
  if [[ -n "$IDENTITY" ]]; then
    # Sign by the certificate's SHA-1, not its name: a name with accents ("César")
    # reaches codesign garbled when the shell's locale is not UTF-8.
    HASH=$(LC_ALL=en_US.UTF-8 security find-identity -v -p codesigning | LC_ALL=en_US.UTF-8 grep -F "\"$IDENTITY\"" | awk '{print $2}' | head -1)
    export APPLE_SIGNING_IDENTITY="${HASH:-$IDENTITY}"
    echo "Signing with $IDENTITY"
  fi
  # No update packages for a local install: they need the release signing key.
  (cd "$APP_DIR" && pnpm tauri build --debug --config '{"bundle":{"createUpdaterArtifacts":false}}')
fi
[[ -d "$BUNDLE" ]] || { echo "No bundle at $BUNDLE; build first." >&2; exit 1; }

mkdir -p "$HOME/Applications"
rm -rf "$STAGE"
rmdir "$STAGE.lock" 2>/dev/null || true   # a swapper that died mid-way
ditto "$BUNDLE" "$STAGE"
echo "Staged the new build at $STAGE"

# Never kill the running app: ask for it to be quit, then swap.
if pgrep -f "$DEST/Contents/MacOS/" >/dev/null; then
  if (( WHEN_QUIT )); then
    # Detached, so it outlives this shell (and OpenAdmiral's own terminals): wait for
    # the quit, swap, reopen. Gives up after 12 h.
    # It logs to ~/Library/Logs/OpenAdmiral/install.log, so a swap that did not happen says why.
    LOG="$HOME/Library/Logs/OpenAdmiral/install.log"
    mkdir -p "${LOG:h}"
    echo "$(date '+%F %T') waiting for OpenAdmiral to quit (watcher $$)" >>"$LOG"
    # Its own session (setsid via perl, which macOS always has): a watcher started from
    # a tool that kills its whole process group when it finishes must outlive it.
    nohup /usr/bin/perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV' /bin/zsh -c '
      for i in {1..43200}; do pgrep -f "$1/Contents/MacOS/" >/dev/null || break; sleep 1; done
      echo "$(date "+%F %T") quit seen"
      # Builds from 0.1.3 on swap themselves when they quit (src-tauri/src/staged.rs):
      # give that a head start, and take the same lock so it happens once.
      sleep 2
      mkdir "$2.lock" 2>/dev/null || { echo "the app is swapping it in"; exit 0; }
      trap '"'"'rmdir "$2.lock" 2>/dev/null'"'"' EXIT
      [[ -d "$2" ]] || { echo "nothing staged (already swapped in)"; exit 0; }
      pgrep -f "$1/Contents/MacOS/" >/dev/null && { echo "running again before the swap: left staged"; exit 0; }
      set -x
      # A clean environment, as the Finder would give it: this script often runs inside
      # a Claude Code session, whose variables (NO_COLOR, CLAUDE_*) must not reach the app.
      rm -rf "$1" && mv "$2" "$1" && env -i HOME="$HOME" USER="$USER" LOGNAME="$LOGNAME" PATH=/usr/bin:/bin:/usr/sbin:/sbin /usr/bin/open "$1"
    ' _ "$DEST" "$STAGE" >>"$LOG" 2>&1 &!
    echo "OpenAdmiral is running: the new build goes in when you quit it (⌘Q), and OpenAdmiral reopens by itself."
    exit 0
  fi
  echo "OpenAdmiral is running from $DEST."
  echo "Quit it (OpenAdmiral menu → Quit, or the menu-bar icon → Quit OpenAdmiral), then run:"
  echo "  $0 --no-build"
  echo "or run  $0 --no-build --when-quit  now and just quit: it swaps and reopens."
  exit 2
fi

rm -rf "$DEST"
mv "$STAGE" "$DEST"
echo "Installed $DEST. Open it with:  open ~/Applications/OpenAdmiral.app"
