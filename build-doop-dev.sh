#!/usr/bin/env bash
set -euo pipefail

root=$(cd -- "$(dirname -- "$0")" && pwd -P)
cd -- "$root"
export PATH="$HOME/.cargo/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
export DOOP_APP_URL=http://127.0.0.1:4437
export DOOP_TEST_LOGIN=${DOOP_TEST_LOGIN:-1}
export CARGO_BUILD_JOBS=${CARGO_BUILD_JOBS:-5}
export CARGO_PROFILE_RELEASE_LTO=${CARGO_PROFILE_RELEASE_LTO:-false}

target=${CARGO_TARGET_DIR:-$root/desktop/src-tauri-chromium/target}
mkdir -p -- "$target"
CARGO_TARGET_DIR=$(cd -- "$target" && pwd -P)
export CARGO_TARGET_DIR

# Tauri lays out the host-architecture CEF framework and its helper apps.
cd -- "$root/desktop"
bun run build:chromium --bundles app --no-sign \
  --config "$root/desktop/src-tauri-chromium/doop-dev.tauri.json" -- --locked

app="$CARGO_TARGET_DIR/release/bundle/macos/Doop Dev.app"
/usr/bin/codesign --force --deep --sign - "$app"
/usr/bin/codesign --force --sign - \
  --entitlements "$root/desktop/src-tauri/Dictation.entitlements" "$app"
/usr/bin/codesign --verify --deep --strict "$app"
printf '%s\n' "$app"
