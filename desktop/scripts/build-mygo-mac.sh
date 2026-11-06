#!/usr/bin/env bash
#
# Build the mygo desktop shell for macOS: stage the runtime payload into the
# project's resources, build the .app and the .dmg with mygo, check what came out
# (Info.plist, signature, payload inside the bundle, artifact sizes), and verify
# that the agent channel is — or, with --no-agent-channel, is not — in the app.
#
# The build is mygo's release form: -X github.com/egoist/mygo.production=1 is set
# and the app carries the inspector of native UI plus the automation plugin,
# because the agent channel has to drive the app that was installed. mygo keeps
# them only when MYGO_INSPECTOR=1 is exported; that variable is the one build-time
# switch for the inspector (cmd/mygo/build.go:448 keepInspector, :453
# productionTags add -tags mygo_noinspector otherwise), which is why this script
# sets the environment instead of passing a flag. -debug keeps the inspector too,
# but it also drops the production flag, so a release is never built with it.
#
# After 'mygo build' the script restores what mygo leaves out of the bundle's
# resources — every name that starts with a dot (cmd/mygo/resources.go:551),
# one of which the payload needs — then signs the app again with the same
# identity and rebuilds the disk image, because the restore breaks the seal.
# It verifies that the payload is complete in the bundle, that the image
# verifies, and that the app inside it verifies too.
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
#   --no-agent-channel      build the release form without the inspector and the
#                           automation plugin (mygo's mygo_noinspector tag): nothing
#                           listens on MYGO_AUTOMATION and the app says so on stderr.
#                           For a build that must carry no local driver at all.
#   --no-payload            do not stage the payload, build with the one in place as
#                           it stands: no copy is made, so nothing is trimmed here
#                           (stage-mygo-payload.mjs trims what it stages)
#   --keep-all-platforms    stage the payload for every platform, without the
#                           per-platform trim: the .app then carries the native
#                           packages of all four targets, about 820 MB more than
#                           a mac arm64 build ships (scripts/prune-mygo-payload.mjs)
#   --skip-run-check        do not launch the built app to verify the channel; the
#                           binary's own markers are still checked (a machine without
#                           a GUI session cannot answer the channel's requests)
#   -h, --help              this text
#
# Environment:
#   DSH_MYGO_PAYLOAD_SRC  runtime payload to stage: the installed
#                         /Applications/DSH Trading.app/Contents/Resources/runtime when it
#                         exists, else desktop/resources/runtime (the Electron staging)
#   MYGO_BIN              mygo CLI to use; the default builds the module's CLI with Go
#   GO_BIN                go executable (default: go from PATH)
#   NODE_BIN              node that trims the staged payload and restores its dotfiles
#                         (default: node from PATH, then /opt/homebrew/bin/node, then
#                         /usr/local/bin/node)
#   AGENTCTL              agentctl binary for the run check; the default builds
#                         desktop/mygo/cmd/agentctl with Go
#   MYGO_INSPECTOR        forced to 1 (the default, agent channel in) and unset with
#                         --no-agent-channel
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
channel=1
stage=1
keepall=0
runcheck=1

say() { echo "[build-mygo-mac] $*"; }
fail() { echo "build-mygo-mac: $*" >&2; exit 1; }

usage() {
  awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "${BASH_SOURCE[0]}"
}

# rebuild_dmg writes dmg again from app, the way mygo build does it (cmd/mygo/dmg.go):
# a writable HFS+ image holding the app, a link to /Applications and the Finder
# layout, converted to ULMO. The Finder layout and the volume icon come from the
# image mygo just built, so the rebuilt image looks like the first one. The app
# must already be signed: the image seals what it holds.
rebuild_dmg() {
  local app="$1" dmg="$2"
  local src="$work/dmg-src" rw="$work/dmg-rw.dmg" mnt="$work/dmg-mnt"
  local volume disk name attached old
  rm -rf "$src" "$mnt" "$rw"
  mkdir -p "$src" "$mnt"
  # The Finder layout (.DS_Store) and the volume icon come from the image mygo
  # just made, so the rebuilt image shows and is named what the first one was.
  attached="$(hdiutil attach -readonly -noverify -noautoopen -nobrowse "$dmg")"
  old="$(printf '%s\n' "$attached" | sed -n 's|^.*[[:space:]]\(/Volumes/.*\)$|\1|p' | tail -1)"
  volume="$(basename "${old:-$(basename "$app" .app)}")"
  for name in .DS_Store .VolumeIcon.icns; do
    if [ -n "$old" ] && [ -f "$old/$name" ]; then cp -p "$old/$name" "$src/$name"; fi
  done
  if [ -n "$old" ]; then hdiutil detach "$old" >/dev/null; fi
  ditto --noclone "$app" "$src/$(basename "$app")"
  ln -s /Applications "$src/Applications"
  hdiutil create -ov -volname "$volume" -srcfolder "$src" -fs HFS+ \
    -fsargs '-c c=64,a=16,e=16' -format UDRW "$rw" >/dev/null
  disk="$(hdiutil attach -readwrite -noverify -noautoopen -nobrowse -mountpoint "$mnt" "$rw" | head -1 | awk '{print $1}')"
  rm -rf "$mnt/.fseventsd" "$mnt/.Trashes"
  hdiutil detach "$disk" >/dev/null
  rm -f "$dmg"
  if diskutil image create from -h >/dev/null 2>&1; then
    diskutil image create from --format ULMO "$rw" "$dmg" >/dev/null
  else
    hdiutil convert "$rw" -format ULMO -ov -o "$dmg" >/dev/null
  fi
  if [ "$identity" != "-" ]; then
    codesign --force --timestamp --sign "$identity" "$dmg"
  fi
  rm -rf "$src" "$mnt" "$rw"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --platform) platform="${2:?--platform needs GOOS/GOARCH}"; shift 2 ;;
    --sign) identity="${2:?--sign needs an identity}"; shift 2 ;;
    --ad-hoc) identity="-"; shift ;;
    --notarize) notarize=1; shift ;;
    --no-agent-channel) channel=0; shift ;;
    --no-payload) stage=0; shift ;;
    --keep-all-platforms) keepall=1; shift ;;
    --skip-run-check) runcheck=0; shift ;;
    -h|--help) usage; exit 0 ;;
    *) fail "unknown argument $1" ;;
  esac
done

[ "$(uname -s)" = "Darwin" ] || fail "packaging a macOS app needs macOS (codesign, hdiutil, actool)"
for tool in codesign plutil xcrun hdiutil rsync strings pgrep; do
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

go="${GO_BIN:-go}"
command -v "$go" >/dev/null 2>&1 || go=""
# mygo build shells out to "go" itself (go list .), so a GO_BIN outside PATH has
# to be put on PATH, not just used for this script's own builds.
if [ -n "$go" ]; then
  PATH="$(cd "$(dirname "$go")" && pwd):$PATH"
  export PATH
fi

# The trim runs on node, which a non-interactive ssh shell does not find on a
# Homebrew Mac: look where a login shell would.
node_bin="${NODE_BIN:-}"
if [ -z "$node_bin" ] && command -v node >/dev/null 2>&1; then node_bin="$(command -v node)"; fi
if [ -z "$node_bin" ]; then
  for candidate in /opt/homebrew/bin/node /usr/local/bin/node; do
    if [ -x "$candidate" ]; then node_bin="$candidate"; break; fi
  done
fi

work="$(mktemp -d "${TMPDIR:-/tmp}/mygo-build.XXXXXX")"
# The trap detaches a disk image the verification left mounted before it removes
# the work directory; the detach of a good run is its own step below, and a
# failure there fails the build.
trap 'hdiutil detach "$work/dmg-check" >/dev/null 2>&1 || true; rm -rf "$work"' EXIT

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
  say "staged payload: $(du -sh "$payload" | cut -f1) (all platforms)"
  if [ "$keepall" = 1 ]; then
    say "payload kept complete: --keep-all-platforms stages every platform"
  else
    [ -n "$node_bin" ] || fail "trimming the staged payload needs node (set NODE_BIN, or pass --keep-all-platforms)"
    "$node_bin" "$root/desktop/scripts/prune-mygo-payload.mjs" --platform "$platform" --root "$payload"
  fi
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
  [ -n "$go" ] || fail "no mygo CLI on PATH and no go to build one: install Go or set MYGO_BIN"
  mygo="$work/mygo"
  say "building the mygo CLI with $("$go" version | cut -d' ' -f3)"
  ( cd "$project" && "$go" build -o "$mygo" github.com/egoist/mygo/cmd/mygo )
fi

if [ "$channel" = 1 ]; then
  export MYGO_INSPECTOR=1
  say "release form: MYGO_INSPECTOR=1 keeps the inspector and the automation plugin"
else
  unset MYGO_INSPECTOR
  say "release form without the agent channel: MYGO_INSPECTOR unset adds -tags mygo_noinspector"
fi

say "mygo build -platform $platform -sign '$identity'"
( cd "$project" && "$mygo" build -platform "$platform" -sign "$identity" )

app="$(find "$project/build" -maxdepth 3 -type d -name '*.app' -print -quit)"
dmg="$(find "$project/build" -maxdepth 3 -type f -name '*.dmg' -print -quit)"
[ -n "$app" ] || fail "the build produced no .app under $project/build"
[ -n "$dmg" ] || fail "the build produced no .dmg under $project/build"

# mygo build leaves every name that starts with a dot out of Contents/Resources
# (cmd/mygo/resources.go:551 hiddenName, used at :380 while collecting and :643
# while copying), and the payload needs one of them:
# @earendil-works/pi-ai/dist/providers/data/.manifest.json is imported by
# @deepseek-ai/dsh-llm-pi-ai, and without it the host logs "1 entry did not
# activate". The staged tree is restored into the bundle here, then the app is
# signed again and the disk image rebuilt: a file landing in the bundle breaks
# the seal, so nothing may run between the restore and codesign.
say "restoring the dotfiles mygo build leaves out"
[ -n "$node_bin" ] || fail "restoring the payload's dotfiles needs node (set NODE_BIN)"
"$node_bin" "$root/desktop/scripts/restore-mygo-dotfiles.mjs" \
  --source "$payload" --bundle "$app/Contents/Resources/runtime" --report "$work/dotfiles.json"
restored="$(plutil -extract copied raw -o - "$work/dotfiles.json")"
if [ "$restored" != 0 ]; then
  # codesignArgs of mygo build (cmd/mygo/bundle.go:371): --force --deep, and the
  # hardened runtime plus a secure timestamp for a real identity in production,
  # which this is. mygo.json configures no entitlements, so none are passed.
  say "re-signing the app after the restore (identity $identity)"
  if [ "$identity" = "-" ]; then
    codesign --force --deep --sign - "$app"
  else
    codesign --force --deep --options runtime --timestamp --sign "$identity" "$app"
  fi
  say "rebuilding the disk image from the re-signed app"
  rebuild_dmg "$app" "$dmg"
fi
say "the bundle holds every entry of the staged payload"
"$node_bin" "$root/desktop/scripts/restore-mygo-dotfiles.mjs" \
  --source "$payload" --bundle "$app/Contents/Resources/runtime" --check

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

say "the disk image verifies, mounts, and its app verifies"
hdiutil verify "$dmg" 2>&1 | sed 's/^/  /'
check="$work/dmg-check"
mkdir -p "$check"
hdiutil attach -readonly -noverify -noautoopen -nobrowse -mountpoint "$check" "$dmg" >/dev/null
codesign --verify --deep --strict --verbose=2 "$check/$(basename "$app")" 2>&1 | sed 's/^/  /'
[ -f "$check/$(basename "$app")/Contents/Resources/runtime/host/node_modules/@earendil-works/pi-ai/dist/providers/data/.manifest.json" ] \
  || fail "the image's app does not carry the payload's dotfiles"
hdiutil detach "$check" >/dev/null

# The automation plugin's protocol code carries the sentence a page window answers
# a tree request with; the stand-in off.go build does not, and only that build
# carries the sentence saying the channel is out. Both are compiled-in strings, so
# they say what the binary was built with.
binary_verdict() {
  local binary="$1" plugin stand_in
  plugin="$(strings "$binary" | grep -c 'shows a web page: use eval' || true)"
  stand_in="$(strings "$binary" | grep -c 'this build leaves automation out' || true)"
  if [ "$plugin" -gt 0 ] && [ "$stand_in" -eq 0 ]; then
    echo present
  elif [ "$plugin" -eq 0 ] && [ "$stand_in" -gt 0 ]; then
    echo absent
  else
    echo "unclear (plugin markers $plugin, stand-in markers $stand_in)"
  fi
}

# stop_app ends the app the run check started: through the channel when it answers
# (the shell's quit sequence stops its host), else with signals, and the host the
# shell spawned is waited for rather than left behind.
stop_app() {
  local app="$1" pid="$2" socket="$3" i
  if [ -n "$socket" ] && [ -S "$socket" ] && [ -n "$agentctl" ]; then
    "$agentctl" -socket "$socket" eval 'setTimeout(function () { window.desktop.quit(); }, 0); "quit scheduled"' >/dev/null 2>&1 || true
  fi
  for i in $(seq 1 20); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.5
  done
  if kill -0 "$pid" 2>/dev/null; then
    kill -TERM "$pid" 2>/dev/null || true
    sleep 1
    kill -0 "$pid" 2>/dev/null && kill -KILL "$pid" 2>/dev/null || true
  fi
  for i in $(seq 1 20); do
    pgrep -f "$app/Contents/Resources/runtime" >/dev/null 2>&1 || return 0
    sleep 0.5
  done
  pkill -f "$app/Contents/Resources/runtime" 2>/dev/null || true
}

# ask_windows asks the channel for the app's windows once, bounded: it writes the
# answer to $windows and succeeds when the app answered with a JSON array.
ask_windows() {
  local socket="$1" bound="$2" i asking
  "$agentctl" -socket "$socket" windows >"$windows" 2>"$errout" &
  asking=$!
  for i in $(seq 1 $((bound * 2))); do
    kill -0 "$asking" 2>/dev/null || break
    sleep 0.5
  done
  if kill -0 "$asking" 2>/dev/null; then
    kill -KILL "$asking" 2>/dev/null || true
    wait "$asking" 2>/dev/null || true
    return 1
  fi
  wait "$asking" 2>/dev/null || return 1
  grep -q '^\[' "$windows"
}

# run_verdict launches the built app with MYGO_AUTOMATION set, against a throwaway
# DSH home under the work directory, and asks the channel for the app's windows.
# "present" means windows answered, "absent" means the app itself said the channel
# is not in this build, and "unavailable: …" means the app could not run here (no
# GUI session), in which case the binary verdict stands.
#
# The app is opened once, so a window shows for a few seconds, and it keeps the
# Library state every launch keeps (its user data and dsh-host.log); only DSH_HOME
# is redirected, and the throwaway home goes with the work directory.
run_verdict() {
  local app="$1" socket="$work/agent.sock" home="$work/home-trading"
  local out="$work/agent.stdout" err="$work/agent.stderr" windows="$work/windows.json"
  local errout="$work/windows.err" executable pid i real
  executable="$(plutil -extract CFBundleExecutable raw "$app/Contents/Info.plist")"
  # The launched process reports the path the kernel resolved, so /tmp reads as
  # /private/tmp there: match what it reports, not the logical path.
  real="$(cd "$(dirname "$app")" && pwd -P)/$(basename "$app")"
  rm -rf "$home" "$socket" "$out" "$err" "$windows" "$errout"
  mkdir -p "$home"
  if ! open -n --env "DSH_HOME=$home" --env DSH_DESKTOP_NO_ATTACH=1 \
    --env "MYGO_AUTOMATION=$socket" --stdout "$out" --stderr "$err" "$app" 2>"$work/open.err"; then
    echo "unavailable: open failed ($(head -1 "$work/open.err"))"
    return
  fi
  pid=""
  for i in $(seq 1 20); do
    pid="$(pgrep -f "$real/Contents/MacOS/$executable" | tail -1)"
    [ -n "$pid" ] && break
    sleep 0.5
  done
  if [ -z "$pid" ]; then
    echo "unavailable: the app did not launch"
    return
  fi
  # A build without the plugin answers nothing on the socket and says why on
  # stderr; a build with it creates the socket as the process starts.
  for i in $(seq 1 30); do
    if grep -q 'leaves automation out' "$err" 2>/dev/null; then
      # The app's own words belong in the build log: that line is the proof a
      # build without the plugin could not be mistaken for one whose channel is
      # merely idle.
      echo "[build-mygo-mac] the app said: $(grep -m1 'leaves automation out' "$err")" >&2
      stop_app "$real" "$pid" ""
      echo absent
      return
    fi
    [ -S "$socket" ] && break
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.5
  done
  if [ ! -S "$socket" ] || [ -z "$agentctl" ]; then
    stop_app "$real" "$pid" ""
    if [ -S "$socket" ]; then
      echo "unavailable: no agentctl to ask (set AGENTCTL or install Go)"
    else
      echo "unavailable: no automation socket appeared"
    fi
    return
  fi
  # The channel answers with the window list, a JSON array, once the app is ready;
  # keep asking until it lists a window, because the window opens a moment after
  # readiness and a socket that is listening but not accepting yet fails a connect.
  local deadline=$((SECONDS + 45))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if ask_windows "$socket" 10; then
      if grep -q '"id"' "$windows"; then
        echo "[build-mygo-mac] windows answered: $(tr -d '\n' <"$windows" | cut -c1-400)" >&2
        stop_app "$real" "$pid" "$socket"
        echo present
        return
      fi
    else
      echo "[build-mygo-mac] windows ask failed: $(head -1 "$errout" 2>/dev/null)" >&2
    fi
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.5
  done
  if kill -0 "$pid" 2>/dev/null; then
    stop_app "$real" "$pid" "$socket"
    echo "unavailable: no window was listed within 45s ($(head -1 "$errout" 2>/dev/null))"
  else
    stop_app "$real" "$pid" "$socket"
    echo "unavailable: the app exited before it answered"
  fi
}

agentctl="${AGENTCTL:-}"
if [ "$runcheck" = 1 ] && [ -z "$agentctl" ] && [ -n "$go" ]; then
  agentctl="$work/agentctl"
  say "building agentctl with $("$go" version | cut -d' ' -f3)"
  ( cd "$project" && "$go" build -o "$agentctl" ./cmd/agentctl ) || agentctl=""
fi

executable="$(plutil -extract CFBundleExecutable raw "$app/Contents/Info.plist")"
binary="$app/Contents/MacOS/$executable"
verdict="$(binary_verdict "$binary")"
say "agent channel in the binary: $verdict"
if [ "$channel" = 1 ]; then expected=present; else expected=absent; fi
[ "$verdict" = "$expected" ] || fail "the binary says '$verdict' but this build asked for '$expected'"

if [ "$runcheck" = 1 ]; then
  say "agent channel by running the app (MYGO_AUTOMATION=$work/agent.sock, DSH_HOME=$work/home-trading)"
  ran="$(run_verdict "$app")"
  say "agent channel by running the app: $ran"
  case "$ran" in
    "$expected") say "verified by a real run: the built app answers as '$expected'" ;;
    unavailable:*)
      say "the run check could not decide here (${ran#unavailable: }); the binary verdict stands"
      say "note: strings prove what was compiled in, not that the channel answers in this process"
      ;;
    *) fail "the run check says '$ran' but this build asked for '$expected'" ;;
  esac
else
  say "run check skipped (--skip-run-check): the binary verdict stands, which proves what was compiled in, not that the app answers"
fi

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
