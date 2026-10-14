#!/usr/bin/env bash
set -euo pipefail

dmg="${1:?DMG path required}"
samples="${2:-20}"
scratch="$(mktemp -d "${TMPDIR:-/tmp}/state-hub-dmg-smoke.XXXXXX")"
mounted=0
cleanup() {
  if [[ "$mounted" == 1 ]]; then hdiutil detach "$scratch/mount" -quiet || true; fi
  case "$scratch" in "${TMPDIR:-/tmp}"/state-hub-dmg-smoke.*) rm -rf -- "$scratch" ;; *) echo 'Unexpected smoke path' >&2; exit 1 ;; esac
}
trap cleanup EXIT
mkdir "$scratch/mount" "$scratch/install"
hdiutil attach "$dmg" -nobrowse -readonly -mountpoint "$scratch/mount" -quiet
mounted=1
shopt -s nullglob
apps=("$scratch/mount"/*.app)
[[ "${#apps[@]}" == 1 ]] || { echo 'Expected one app in DMG' >&2; exit 1; }
ditto "${apps[0]}" "$scratch/install/State Hub.app"
hdiutil detach "$scratch/mount" -quiet
mounted=0
executable="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$scratch/install/State Hub.app/Contents/Info.plist")"
node tools/release/installed-smoke.mjs "$scratch/install/State Hub.app/Contents/MacOS/$executable" "$samples"
test -d "$scratch/install/State Hub.app"
rm -rf -- "$scratch/install/State Hub.app"
test ! -e "$scratch/install/State Hub.app"
echo 'macOS DMG install, start, health, first paint and uninstall smoke passed'
