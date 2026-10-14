#!/usr/bin/env bash
set -euo pipefail

appimage="${1:?AppImage path required}"
deb="${2:?deb path required}"
samples="${3:-20}"
chmod +x "$appimage"
APPIMAGE_EXTRACT_AND_RUN=1 node tools/release/installed-smoke.mjs "$appimage" "$samples"
package="$(dpkg-deb -f "$deb" Package)"
binary="$(dpkg-deb -c "$deb" | awk '/\/usr\/bin\// {print $NF}' | head -n 1)"
[[ -n "$package" && -n "$binary" ]] || { echo 'Invalid deb package' >&2; exit 1; }
sudo dpkg -i "$deb"
cleanup() { sudo dpkg -r "$package" >/dev/null || true; }
trap cleanup EXIT
installed="/${binary#./}"
[[ -x "$installed" ]] || { echo 'Debian executable missing' >&2; exit 1; }
node tools/release/installed-smoke.mjs "$installed" "$samples"
sudo dpkg -r "$package"
trap - EXIT
[[ ! -e "$installed" ]] || { echo 'Debian executable remained after uninstall' >&2; exit 1; }
echo 'Linux AppImage and deb install, start, health, first paint and uninstall smoke passed'
