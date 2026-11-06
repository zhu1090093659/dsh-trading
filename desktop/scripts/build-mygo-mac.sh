#!/usr/bin/env bash
#
# Build the mygo desktop shell for macOS: stage the runtime payload into the
# project's resources, build the .app and the .dmg with mygo, and check what came
# out (Info.plist, signature, payload inside the bundle, artifact sizes).
#
# Usage: desktop/scripts/build-mygo-mac.sh [options]
#
#   --platform GOOS/GOARCH  target (default darwin/arm64; darwin/universal works)
#   --sign IDENTITY         codesign identity, e.g. "Developer ID Application: Name (TEAM)";
#                           the default is ad-hoc signing, which needs no keychain identity
#   --ad-hoc                ad-hoc signing explicitly (the default)
#   --notarize              submit the .dmg to Apple and staple it; needs --sign with a
#                           Developer ID identity and either APPLE_ID + APPLE_TEAM_ID +
#                           APPLE_APP_SPECIFIC_PASSWORD or APPLE_API_KEY + APPLE_API_KEY_ID
#                           + APPLE_API_ISSUER
#   --release               drop the automation plugin (mygo's mygo_noinspector tag); the
#                           default keeps it, which is what the agent channel drives
#   --no-payload            do not stage the payload, build with the one in place
#   -h, --help              this text
#
# Environment:
#   DSH_MYGO_PAYLOAD_SRC  runtime payload to stage: the installed
#                         /Applications/DSH Trading.app/Contents/Resources/runtime when it
#                         exists, else desktop/resources/runtime (the Electron staging)
#   MYGO_BIN              mygo CLI to use; the default builds the module's CLI with Go
#   GO_BIN                go executable (default: go from PATH)
#   MYGO_INSPECTOR        forced to 1 unless --release
#
# Ad-hoc signing is what a machine without the signing identity in its keychain
# can do: an ssh session's keychain is locked (codesign reports
# errSecInternalComponent), so real signing and notarization are the owner's step
# in a GUI session, with --sign and --notarize as the entry points.

set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
project="$root/desktop/mygo"
payload="$project/resources/runtime"

platform="darwin/arm64"
identity="-"
notarize=0
release=0
stage=1

say() { echo "[build-mygo-mac] $*"; }
fail() { echo "build-mygo-mac: $*" >&2; exit 1; }

usage() {
  sed -n '2,40p' "${BASH_SOURCE[0]}" | sed 's/^#\( \|$\)//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --platform) platform="${2:?--platform needs GOOS/GOARCH}"; shift 2 ;;
    --sign) identity="${2:?--sign needs an identity}"; shift 2 ;;
    --ad-hoc) identity="-"; shift ;;
    --notarize) notarize=1; shift ;;
    --release) release=1; shift ;;
    --no-payload) stage=0; shift ;;
    -h|--help) usage; exit 0 ;;
    *) fail "unknown argument $1" ;;
  esac
done

[ "$(uname -s)" = "Darwin" ] || fail "packaging a macOS app needs macOS (codesign, hdiutil, actool)"
for tool in codesign plutil xcrun hdiutil rsync; do
  command -v "$tool" >/dev/null 2>&1 || fail "$tool is missing"
done
if [ "$notarize" = 1 ] && [ "$identity" = "-" ]; then
  fail "--notarize needs a Developer ID identity: pass --sign \"Developer ID Application: …\""
fi
if [ "$notarize" = 1 ]; then
  if [ -n "${APPLE_API_KEY:-}" ]; then
    : "${APPLE_API_KEY_ID:?--notarize with APPLE_API_KEY needs APPLE_API_KEY_ID and APPLE_API_ISSUER}"
  else
    : "${APPLE_ID:?--notarize needs APPLE_ID + APPLE_TEAM_ID + APPLE_APP_SPECIFIC_PASSWORD, or APPLE_API_KEY + APPLE_API_KEY_ID + APPLE_API_ISSUER}"
  fi
fi

if [ "$stage" = 1 ]; then
  source="${DSH_MYGO_PAYLOAD_SRC:-}"
  if [ -z "$source" ]; then
    if [ -d "/Applications/DSH Trading.app/Contents/Resources/runtime" ]; then
      source="/Applications/DSH Trading.app/Contents/Resources/runtime"
    else
      source="$root/desktop/resources/runtime"
    fi
  fi
  [ -d "$source" ] || fail "no runtime payload at $source (stage one with desktop/scripts/stage-mygo-payload.mjs)"
  node_source="$source/node"
  if [ ! -x "$node_source/bin/node" ]; then
    node_source="$source/node-${platform//\//-}"
  fi
  [ -x "$node_source/bin/node" ] || fail "no node distribution in $source (looked for node/ and node-${platform//\//-}/)"
  say "staging the payload from $source"
  mkdir -p "$payload"
  rsync -a --delete "$node_source/" "$payload/node/"
  rsync -a --delete "$source/host/" "$payload/host/"
  rsync -a --delete "$source/profile-trading/" "$payload/profile-trading/"
  if [ -f "$source/VERSION.json" ]; then cp "$source/VERSION.json" "$payload/VERSION.json"; fi
fi

for required in \
  "$payload/node/bin/node" \
  "$payload/node/bin/npm" \
  "$payload/host/node_modules/@deepseek-ai/dsh/lib/bin.js" \
  "$payload/profile-trading/package.json" \
  "$payload/profile-trading/cordis.patch.yml"; do
  [ -e "$required" ] || fail "the payload is missing $required (stage it with desktop/scripts/stage-mygo-payload.mjs)"
done
say "payload: $(du -sh "$payload" | cut -f1) under ${payload#$root/}"

mygo="${MYGO_BIN:-}"
if [ -z "$mygo" ] && command -v mygo >/dev/null 2>&1; then mygo="$(command -v mygo)"; fi
if [ -z "$mygo" ]; then
  go="${GO_BIN:-go}"
  command -v "$go" >/dev/null 2>&1 || fail "no mygo CLI on PATH and no go to build one: install Go or set MYGO_BIN"
  work="$(mktemp -d "${TMPDIR:-/tmp}/mygo-cli.XXXXXX")"
  trap 'rm -rf "$work"' EXIT
  mygo="$work/mygo"
  say "building the mygo CLI with $("$go" version | cut -d' ' -f3)"
  ( cd "$project" && "$go" build -o "$mygo" github.com/egoist/mygo/cmd/mygo )
fi

if [ "$release" = 1 ]; then
  unset MYGO_INSPECTOR
  say "building without the automation plugin (--release)"
else
  export MYGO_INSPECTOR=1
  say "keeping the automation plugin (MYGO_INSPECTOR=1; use --release to drop it)"
fi

say "mygo build -platform $platform -sign '$identity'"
( cd "$project" && "$mygo" build -platform "$platform" -sign "$identity" )

app="$(find "$project/build" -maxdepth 3 -type d -name '*.app' -print -quit)"
dmg="$(find "$project/build" -maxdepth 3 -type f -name '*.dmg' -print -quit)"
[ -n "$app" ] || fail "the build produced no .app under $project/build"
[ -n "$dmg" ] || fail "the build produced no .dmg under $project/build"

say "bundle: ${app#$root/}"
say "Info.plist"
plutil -p "$app/Contents/Info.plist"
say "signature"
codesign -dv --verbose=4 "$app" 2>&1 | sed -n '1,24p'
codesign --verify --deep --strict --verbose=2 "$app" 2>&1 | sed 's/^/  /'
say "payload in the bundle"
for part in node host profile-trading; do
  du -sh "$app/Contents/Resources/runtime/$part"
done
ls -l "$app/Contents/Resources/runtime/node/bin/node" \
  "$app/Contents/Resources/runtime/host/node_modules/@deepseek-ai/dsh/lib/bin.js"
say "artifacts"
du -sh "$app"
ls -lh "$dmg"

if [ "$notarize" = 1 ]; then
  say "notarizing ${dmg#$root/}"
  if [ -n "${APPLE_API_KEY:-}" ]; then
    xcrun notarytool submit "$dmg" --key "$APPLE_API_KEY" --key-id "$APPLE_API_KEY_ID" \
      --issuer "$APPLE_API_ISSUER" --wait
  else
    xcrun notarytool submit "$dmg" --apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" \
      --password "$APPLE_APP_SPECIFIC_PASSWORD" --wait
  fi
  xcrun stapler staple "$app"
  xcrun stapler staple "$dmg"
  xcrun stapler validate "$dmg"
  say "notarized and stapled"
fi

say "app $app"
say "dmg $dmg"
