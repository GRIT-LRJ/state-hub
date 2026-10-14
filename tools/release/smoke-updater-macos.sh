#!/usr/bin/env bash
set -euo pipefail

dmg="${1:?baseline DMG required}"
candidate="${2:?candidate archive required}"
invalid="${3:?invalid signed archive required}"
scratch="$(mktemp -d "${TMPDIR:-/tmp}/state-hub-updater-install.XXXXXX")"
mounted=0
cleanup() {
  if [[ "$mounted" == 1 ]]; then hdiutil detach "$scratch/mount" -quiet || true; fi
  case "$scratch" in "${TMPDIR:-/tmp}"/state-hub-updater-install.*) rm -rf -- "$scratch" ;; *) echo 'Unexpected updater path' >&2; exit 1 ;; esac
}
trap cleanup EXIT
mkdir "$scratch/mount" "$scratch/install"
hdiutil attach "$dmg" -nobrowse -readonly -mountpoint "$scratch/mount" -quiet
mounted=1
shopt -s nullglob
apps=("$scratch/mount"/*.app)
[[ "${#apps[@]}" == 1 ]] || { echo 'Expected one baseline app' >&2; exit 1; }
ditto "${apps[0]}" "$scratch/install/State Hub.app"
hdiutil detach "$scratch/mount" -quiet
mounted=0
executable="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$scratch/install/State Hub.app/Contents/Info.plist")"
node tools/release/updater-smoke.mjs "$scratch/install/State Hub.app/Contents/MacOS/$executable" "$candidate" "$candidate.sig" "$invalid" "$invalid.sig" "$STATE_HUB_SMOKE_BASE_VERSION" "$STATE_HUB_SMOKE_CANDIDATE_VERSION"
