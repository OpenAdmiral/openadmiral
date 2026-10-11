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
#                                 soon as the user quits it (⌘Q) and reopen it
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

if (( BUILD )); then
  export PATH="$HOME/.cargo/bin:$PATH"
  # No update packages for a local install: they need the release signing key.
  (cd "$APP_DIR" && pnpm tauri build --debug --config '{"bundle":{"createUpdaterArtifacts":false}}')
fi
[[ -d "$BUNDLE" ]] || { echo "No bundle at $BUNDLE; build first." >&2; exit 1; }

mkdir -p "$HOME/Applications"
rm -rf "$STAGE"
ditto "$BUNDLE" "$STAGE"
echo "Staged the new build at $STAGE"

# Never kill the running app: ask for it to be quit, then swap.
if pgrep -f "$DEST/Contents/MacOS/" >/dev/null; then
  if (( WHEN_QUIT )); then
    # Detached, so it outlives this shell (and OpenAdmiral's own terminals): wait for
    # the quit, swap, reopen. Gives up after 12 h.
    nohup /bin/zsh -c '
      for i in {1..43200}; do pgrep -f "$1/Contents/MacOS/" >/dev/null || break; sleep 1; done
      pgrep -f "$1/Contents/MacOS/" >/dev/null && exit 0
      [[ -d "$2" ]] || exit 0
      rm -rf "$1" && mv "$2" "$1" && open "$1"
    ' _ "$DEST" "$STAGE" >/dev/null 2>&1 &!
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
