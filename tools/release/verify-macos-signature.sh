#!/usr/bin/env bash
set -euo pipefail

app="${1:?signed app required}"
dmg="${2:?notarized DMG required}"
codesign --verify --deep --strict --verbose=2 "$app"
spctl --assess --type execute --verbose "$app"
xcrun stapler validate "$dmg"
identity="$(codesign -dv --verbose=4 "$app" 2>&1 | sed -n 's/^Authority=Developer ID Application: /Developer ID Application: /p' | head -n 1)"
[[ -n "$identity" ]] || { echo 'Developer ID Application signature missing' >&2; exit 1; }
echo 'macOS Developer ID, Gatekeeper assessment, and stapled notarization verified'
