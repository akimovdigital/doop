#!/usr/bin/env bash
set -euo pipefail

root=$(cd -- "$(dirname -- "$0")" && pwd -P)
cd -- "$root"
app_name='Doop Dev.app'
app_id=digital.akimov.doop-test
target=${CARGO_TARGET_DIR:-$root/desktop/src-tauri-chromium/target}
source_bundle=${1:-$target/release/bundle/macos/$app_name}
applications=${DOOP_DEV_APPLICATIONS_DIR:-$HOME/Applications}
backup_dir=${DOOP_DEV_BACKUP_DIR:-$HOME/Library/Application Support/Doop Test/app-backups}
installed="$applications/$app_name"
backup="$backup_dir/Doop Dev-webkit-7da70f80.app"
framework='Contents/Frameworks/Chromium Embedded Framework.framework/Chromium Embedded Framework'

bundle_id() {
  /usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$1/Contents/Info.plist"
}

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

[[ $(bundle_id "$source_bundle") == "$app_id" && -f "$source_bundle/$framework" ]] ||
  fail "Expected a Doop Dev CEF bundle at $source_bundle"
[[ $(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$source_bundle/Contents/Info.plist") == doop-desktop &&
   -x "$source_bundle/Contents/MacOS/doop-desktop" ]] ||
  fail "The CEF bundle is missing its doop-desktop executable."
if /usr/libexec/PlistBuddy -c 'Print :CFBundleURLTypes' "$source_bundle/Contents/Info.plist" 2>/dev/null |
    /usr/bin/grep -Eq '^[[:space:]]+doop[[:space:]]*$'; then
  fail 'The Dev bundle registers the production doop:// scheme.'
fi

mkdir -p -- "$applications"
staging=$(mktemp -d "$applications/.doop-install.XXXXXX")
backup_staging=
cleanup() {
  if [[ -d "$staging/previous.app" && ! -e "$installed" ]]; then
    if ! mv -- "$staging/previous.app" "$installed"; then
      printf 'Restore the previous app from %s/previous.app\n' "$staging" >&2
      return
    fi
  fi
  rm -rf -- "$staging"
  if [[ -n "$backup_staging" ]]; then
    rm -rf -- "$backup_staging"
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
/usr/bin/ditto "$source_bundle" "$staging/$app_name"
/usr/bin/codesign --verify --deep --strict "$staging/$app_name"

if [[ -e "$installed" || -L "$installed" ]]; then
  [[ ! -L "$installed" && $(bundle_id "$installed") == "$app_id" ]] ||
    fail "Unexpected existing app at $installed"
  if /usr/sbin/lsof +D "$installed/Contents/MacOS" >/dev/null 2>&1; then
    fail 'Quit Doop Dev before replacing its bundle.'
  fi
  if [[ ! -f "$installed/$framework" ]]; then
    mkdir -p -- "$backup_dir"
    if [[ -e "$backup" || -L "$backup" ]]; then
      [[ ! -L "$backup" ]] && /usr/bin/diff -qr "$installed" "$backup" >/dev/null ||
        fail "The existing WebKit backup differs from $installed"
    else
      backup_staging=$(mktemp -d "$backup_dir/.doop-backup.XXXXXX")
      /usr/bin/ditto "$installed" "$backup_staging/$app_name"
      /usr/bin/diff -qr "$installed" "$backup_staging/$app_name" >/dev/null
      /bin/mv -n -- "$backup_staging/$app_name" "$backup"
      [[ ! -e "$backup_staging/$app_name" ]] || fail "Backup already exists at $backup"
    fi
  fi

  mv -- "$installed" "$staging/previous.app"
fi
mv -- "$staging/$app_name" "$installed"
printf '%s\n' "$installed"
