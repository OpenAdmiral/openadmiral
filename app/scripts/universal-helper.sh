#!/bin/sh
# Tauri runs this between compiling and bundling (build.beforeBundleCommand).
# For --target universal-apple-darwin it merges only the main binary into a
# universal one; Underway's helper (src/bin/openadmiral-helper.rs) needs the
# same, or bundling cannot find it. Any other build: nothing to do.
T=src-tauri/target
for p in release debug; do
  u=$T/universal-apple-darwin/$p
  a=$T/aarch64-apple-darwin/$p/openadmiral-helper
  x=$T/x86_64-apple-darwin/$p/openadmiral-helper
  if [ -d "$u" ] && [ -f "$a" ] && [ -f "$x" ]; then
    lipo -create "$a" "$x" -output "$u/openadmiral-helper" || exit 1
  fi
done
