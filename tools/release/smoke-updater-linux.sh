#!/usr/bin/env bash
set -euo pipefail

baseline="${1:?baseline AppImage required}"
candidate="${2:?candidate AppImage required}"
invalid="${3:?invalid signed AppImage required}"
scratch="$(mktemp -d "${TMPDIR:-/tmp}/state-hub-updater-install.XXXXXX")"
cleanup() {
  case "$scratch" in "${TMPDIR:-/tmp}"/state-hub-updater-install.*) rm -rf -- "$scratch" ;; *) echo 'Unexpected updater path' >&2; exit 1 ;; esac
}
trap cleanup EXIT
cp "$baseline" "$scratch/State-Hub.AppImage"
chmod +x "$scratch/State-Hub.AppImage"
APPIMAGE_EXTRACT_AND_RUN=1 node tools/release/updater-smoke.mjs "$scratch/State-Hub.AppImage" "$candidate" "$candidate.sig" "$invalid" "$invalid.sig" "$STATE_HUB_SMOKE_BASE_VERSION" "$STATE_HUB_SMOKE_CANDIDATE_VERSION"
