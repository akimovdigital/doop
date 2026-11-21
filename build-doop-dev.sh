#!/bin/zsh
set -eu

root="$(cd -- "$(dirname -- "$0")" && pwd)"
cd "$root/desktop"

export PATH="$HOME/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
export DOOP_APP_URL=http://127.0.0.1:4437
unset DOOP_TEST_LOGIN
export CARGO_BUILD_JOBS=5
export CARGO_PROFILE_RELEASE_LTO=false

bun run build --bundles app --config ../doop-dev.tauri.json
