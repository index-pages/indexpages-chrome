#!/bin/sh
# Build the extension.
#
#   ./package.sh        dist/indexpages-chrome-<version>.zip, for the Chrome Web Store
#   ./package.sh --dev  dist/dev/, an unpacked copy with manifest.dev.json as its
#                       manifest (adds loopback host permissions for a local API)
#
# Only shipped files go in: no store/, tests/, dev manifest, README or scripts.
set -eu

cd "$(dirname "$0")"

FILES="manifest.json background.js popup.html popup.css popup.js options.html options.css options.js ui.css"
DIRS="lib icons"

version=$(sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' manifest.json | head -n 1)
[ -n "$version" ] || { echo "No version in manifest.json" >&2; exit 1; }

stage() {
  dest=$1
  rm -rf "$dest"
  mkdir -p "$dest"
  for f in $FILES; do cp "$f" "$dest/"; done
  for d in $DIRS; do cp -R "$d" "$dest/"; done
  find "$dest" -mindepth 1 \( -name '.*' -o -name '*~' \) -exec rm -rf {} +
}

if [ "${1:-}" = "--dev" ]; then
  stage dist/dev
  cp manifest.dev.json dist/dev/manifest.json
  echo "Unpacked dev build: dist/dev (load it from chrome://extensions)"
  exit 0
fi

command -v zip >/dev/null 2>&1 || { echo "zip is not installed" >&2; exit 1; }

stage dist/.stage
out="dist/indexpages-chrome-$version.zip"
rm -f "$out"
# Fixed timestamps and sorted entries, so the same tree gives the same archive.
find dist/.stage -exec touch -h -d '2000-01-01T00:00:00Z' {} +
(cd dist/.stage && find . -type f | sed 's|^\./||' | LC_ALL=C sort | zip -X -q -@ "../indexpages-chrome-$version.zip")
rm -rf dist/.stage
echo "$out"
unzip -l "$out"
