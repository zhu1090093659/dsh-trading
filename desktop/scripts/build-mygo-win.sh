#!/usr/bin/env bash
#
# Build the mygo desktop shell for Windows and check the installer it makes.
#
# The steps are the release ones: stage the runtime payload into the project's
# resources, generate the macro that puts back the files mygo leaves out, pin the
# WebView2 bootstrapper and the Visual C++ runtime the installer embeds, build the
# .exe and its NSIS installer with mygo, then read the result back - the app's
# payload next to the executable, the files inside the installer, the bootstrapper
# and the uninstaller - and print where everything is.
#
# The build host does not have to be Windows: go compiles GOOS=windows, and
# makensis makes the installer here (cmd/mygo/nsis.go:makensis uses the NSIS of
# the system, and downloads its own on Windows alone). Two things this script
# therefore does not do: it does not run the built app, and it does not run the
# installer - a Windows binary cannot run on a POSIX host. What the installer does
# on Windows (the WebView2 check, the Visual C++ step, the uninstall question) is
# verified by what is inside it, not by a run.
#
# What guards the Windows-only parts is desktop/scripts/verify-windows-payload.mjs,
# run first: the target mapping (node-win32-x64 to runtime/node/node.exe, with its
# .cmd wrappers), the trim of the platform packages, and the dotfile macro below.
# A mistake in any of them shows only as an installed app that cannot start, which
# no run on the build host would catch.
#
# Signing is mygo's: windows.certificate in mygo.json signs the executable, the
# installer and its uninstaller with signtool on Windows and osslsigncode
# elsewhere. This script passes nothing, so what it builds is unsigned until that
# is configured.
#
# Usage: desktop/scripts/build-mygo-win.sh [options]
#
#   --platform GOOS/GOARCH  target (default windows/amd64; fetch-node.mjs stages
#                           the windows x64 payload only)
#   --no-payload            do not stage the payload: build with the one in place
#                           as it stands (the dotfile macro is still regenerated)
#   --keep-all-platforms    stage the payload for every platform, without the
#                           per-platform trim
#   --no-agent-channel      build without the inspector and the automation plugin
#                           (mygo's mygo_noinspector tag)
#   --skip-installer-check  do not read the installer's own file list (the check
#                           needs 7z); the artifacts are still checked and sized
#   -h, --help              this text
#
# Environment:
#   MYGO_BIN              mygo CLI to use; the default builds the module's CLI with Go
#   GO_BIN                go executable (default: go from PATH)
#   GOTOOLCHAIN           selection for every go command, default auto: go.mod
#                         requires go 1.27.3, and a machine whose go is older then
#                         builds with that toolchain instead of stopping at
#                         "go.mod requires go >= 1.27.3"
#   NODE_BIN              node that stages the payload, writes the dotfile macro and
#                         fetches the bootstrapper (default: node from PATH)
#   DSH_MYGO_PAYLOAD_SRC  runtime payload to stage, default the checkout's
#                         desktop/resources/runtime. That is the directory that
#                         carries every target, because fetch-node.mjs downloads the
#                         macOS and the Windows node side by side; an installed
#                         Electron app carries only the node of the machine it runs
#                         on (/Applications/DSH Trading.app/Contents/Resources/runtime
#                         holds a macOS node), so it is used only when it also holds
#                         node-win32-x64 - pass it explicitly when it does. Fill the
#                         default with desktop/scripts/fetch-node.mjs and
#                         build-runtime.mjs (the desktop package's prepare-runtime)
#                         once per machine.
#   SEVENZIP              7z that reads and unpacks the installer (default: 7z, 7za
#                         or 7zz from PATH; apt install p7zip-full)
#   MYGO_INSPECTOR        forced to 1 (the agent channel is in) and unset with
#                         --no-agent-channel

set -euo pipefail

root=$(cd "$(dirname "$0")/../.." && pwd)
project="$root/desktop/mygo"
payload="$project/resources/runtime"
dotfiles_macro="$project/build/installer-dotfiles.nsh"

platform="windows/amd64"
stage=1
keepall=0
channel=1
installercheck=1

say() { echo "[build-mygo-win] $*"; }
fail() { echo "build-mygo-win: $*" >&2; exit 1; }

usage() {
  awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"
}

# byte_size prints the size of a file in bytes, the way wc does, on GNU and BSD.
byte_size() { wc -c < "$1" | tr -d ' '; }

# digest prints the SHA-256 of a file, in lower case hex, on GNU and BSD.
digest() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

# human renders a byte count the way du -sh does.
human() {
  if [ "$1" -ge 1048576 ]; then echo "$(( $1 / 1048576 ))M"
  elif [ "$1" -ge 1024 ]; then echo "$(( $1 / 1024 ))K"
  else echo "${1}B"; fi
}

# file_commands counts the File commands of the dotfile macro, which are the files
# it copies into an installed app.
file_commands() { grep -c '^  File ' "$1" 2>/dev/null || true; }

while [ $# -gt 0 ]; do
  case "$1" in
    --platform)
      [ $# -ge 2 ] || fail "--platform needs GOOS/GOARCH"
      platform="$2"; shift 2 ;;
    --no-payload) stage=0; shift ;;
    --keep-all-platforms) keepall=1; shift ;;
    --no-agent-channel) channel=0; shift ;;
    --skip-installer-check) installercheck=0; shift ;;
    -h|--help) usage; exit 0 ;;
    *) fail "unknown argument $1" ;;
  esac
done

case "$platform" in
  windows/amd64|windows-amd64) platform="windows/amd64" ;;
  *) fail "only windows/amd64: desktop/scripts/fetch-node.mjs stages no other Windows payload (add the target there first), not $platform" ;;
esac
# The payload names the target the way Electron does, windows-amd64 (fetch-node
# writes node-win32-x64, and prune tags it win32-x64); stage-mygo-payload.mjs maps
# the two, so the staging call takes the payload's own spelling.
stage_platform=$(echo "$platform" | tr '/' '-')

command -v makensis >/dev/null 2>&1 || fail "makensis is missing: install NSIS (apt install nsis, brew install makensis), which mygo uses to make the Windows installer"

go="${GO_BIN:-go}"
command -v "$go" >/dev/null 2>&1 || go=""
# mygo build shells out to "go" itself (go list .), so a GO_BIN outside PATH has
# to be put on PATH, not just used for this script's own builds.
if [ -n "$go" ]; then
  PATH=$(cd "$(dirname "$go")" && pwd):$PATH
  export PATH
fi
# go.mod requires 1.27.3, and a machine may hold an older go: GOTOOLCHAIN=auto
# takes the required toolchain from the cache instead of stopping at the
# requirement. The mac script needs no such default: it runs where the go in PATH
# already satisfies go.mod.
export GOTOOLCHAIN="${GOTOOLCHAIN:-auto}"

node_bin="${NODE_BIN:-}"
if [ -z "$node_bin" ] && command -v node >/dev/null 2>&1; then node_bin=$(command -v node); fi
[ -n "$node_bin" ] || fail "node is missing: staging the payload, the dotfile macro and the bootstrapper need it (set NODE_BIN)"

sevenzip="${SEVENZIP:-}"
if [ -z "$sevenzip" ]; then
  for candidate in 7z 7zz 7za; do
    if command -v "$candidate" >/dev/null 2>&1; then sevenzip=$(command -v "$candidate"); break; fi
  done
fi
if [ "$installercheck" = 1 ] && [ -z "$sevenzip" ]; then
  fail "reading the installer's file list needs 7z (apt install p7zip-full, brew install p7zip), or --skip-installer-check"
fi

work=$(mktemp -d "${TMPDIR:-/tmp}/mygo-win.XXXXXX")
trap 'rm -rf "$work"' EXIT

say "makensis $(makensis -VERSION 2>/dev/null | head -1), go $( [ -n "$go" ] && "$go" version | cut -d' ' -f3 || echo 'none on PATH')"

# What this build is about to do to a Windows app, on fixtures: the target mapping,
# the trim and the dotfile macro, each of which fails only as an app that cannot
# start. A red run here stops the build before it produces an artifact.
say "the Windows staging itself (desktop/scripts/verify-windows-payload.mjs)"
"$node_bin" "$root/desktop/scripts/verify-windows-payload.mjs" | sed 's/^/  /'

# The bootstrapper is not a build output: fetch-webview2.mjs pins it by SHA-256
# and leaves the file alone when it already matches, so this is a check on a
# machine that has built before. The installer includes it, and makensis stops
# with the script's own message when it is missing.
if [ "$stage" = 1 ]; then
  say "the WebView2 bootstrapper (desktop/scripts/fetch-webview2.mjs)"
  "$node_bin" "$root/desktop/scripts/fetch-webview2.mjs"
else
  say "the WebView2 bootstrapper (verified only: --no-payload)"
  "$node_bin" "$root/desktop/scripts/fetch-webview2.mjs" --verify-only
fi
bootstrapper="$project/resources/windows-amd64/MicrosoftEdgeWebview2Setup.exe"
bootstrapper_bytes=$(byte_size "$bootstrapper")

# Kept from the Electron installer: the Visual C++ runtime the payload's MSVC-built
# native addons need, while node.exe itself imports only system DLLs (the reasoning
# and the evidence are at the top of installer/windows.nsh). The file lives in
# desktop/resources/redist/, which desktop/.gitignore keeps out of the repository and
# desktop/scripts/fetch-redist.mjs downloads. A build without it still makes an
# installer, whose install step then says the runtime was not bundled, so this
# reports rather than fetches.
redist="$root/desktop/resources/redist/vc_redist.x64.exe"
if [ -e "$redist" ]; then
  redist_present=1
  say "the VC++ redistributable the installer can carry: $redist ($(byte_size "$redist") bytes)"
else
  redist_present=0
  say "no $redist: the installer carries none, and its install step says so (desktop/scripts/fetch-redist.mjs downloads it)"
fi

if [ "$stage" = 1 ]; then
  source="${DSH_MYGO_PAYLOAD_SRC:-}"
  if [ -z "$source" ]; then
    # An installed app carries the node of the machine it runs on, so it can only
    # serve this build when someone fetched the Windows node into it; the checkout's
    # staging directory is the one that always has every target.
    installed="/Applications/DSH Trading.app/Contents/Resources/runtime"
    if [ -d "$installed/node-win32-x64" ]; then source="$installed"; else source="$root/desktop/resources/runtime"; fi
  fi
  [ -d "$source" ] || fail "no runtime payload at $source (stage one with desktop/scripts/fetch-node.mjs and build-runtime.mjs)"
  say "staging the payload from $source for $stage_platform"
  stage_args=(--platform "$stage_platform" --from "$source" --to "$payload")
  if [ "$keepall" = 1 ]; then stage_args+=(--keep-all-platforms); fi
  "$node_bin" "$root/desktop/scripts/stage-mygo-payload.mjs" "${stage_args[@]}"
fi

# What the shell runs out of the installed folder: node.exe and its wrappers, the
# dsh host closure, and the profile seed (internal/launch/runtime.go). These names
# are the payload's contract on Windows, not on mac.
for required in \
  "$payload/node/node.exe" \
  "$payload/node/npm.cmd" \
  "$payload/node/npx.cmd" \
  "$payload/host/node_modules/@deepseek-ai/dsh/lib/bin.js" \
  "$payload/profile-trading/package.json" \
  "$payload/profile-trading/cordis.patch.yml"; do
  [ -e "$required" ] || fail "the payload is missing $required (stage it with desktop/scripts/stage-mygo-payload.mjs --platform $stage_platform)"
done
say "payload: $(du -sh "$payload" | cut -f1) under $payload"

# mygo v0.7.4 leaves every name that starts with a dot out of the resources it
# copies (cmd/mygo/resources.go:551 hiddenName, applied at :643), and the installer
# is written inside that same build, so the files have to arrive at install time:
# this writes the macro the include in installer/windows.nsh inserts, with the
# build machine's absolute paths, into the build directory (gitignored, and nothing
# mygo wipes). With the macro missing the include stops makensis on its own message.
say "the files mygo drops, and the installer macro that puts them back"
dotfiles_args=(--source "$payload" --prefix runtime --macro "$dotfiles_macro" --report "$work/dotfiles.json")
"$node_bin" "$root/desktop/scripts/stage-mygo-dotfiles.mjs" "${dotfiles_args[@]}"
report_field() { "$node_bin" -e 'const r=require(process.argv[1]);process.stdout.write(String(r[process.argv[2]]))' "$work/dotfiles.json" "$1"; }
dotfiles_files=$(report_field files)
dotfiles_dirs=$(report_field dirs)
dotfiles_bytes=$(report_field bytes)
# What the macro has to hold, counted from what it was written from: a File command
# per file, a CreateDirectory per directory. A mismatch means the installer would
# ship an app without some of them, so the build stops here, before makensis.
macro_files=$(file_commands "$dotfiles_macro")
macro_dirs=$(grep -c '^  CreateDirectory ' "$dotfiles_macro" || true)
[ "$macro_files" = "$dotfiles_files" ] || fail "the macro in $dotfiles_macro holds $macro_files File commands for the $dotfiles_files files the payload needs put back: the installer would ship an app without them"
[ "$macro_dirs" = "$dotfiles_dirs" ] || fail "the macro in $dotfiles_macro holds $macro_dirs CreateDirectory commands for the $dotfiles_dirs directories the payload needs put back"
say "  $dotfiles_files files ($dotfiles_bytes bytes) and $dotfiles_dirs directories in the macro"

mygo="${MYGO_BIN:-}"
if [ -z "$mygo" ] && command -v mygo >/dev/null 2>&1; then mygo=$(command -v mygo); fi
if [ -z "$mygo" ]; then
  [ -n "$go" ] || fail "no mygo CLI on PATH and no go to build one: install Go or set MYGO_BIN"
  mygo="$work/mygo"
  say "building the mygo CLI with $("$go" version | cut -d' ' -f3)"
  ( cd "$project" && "$go" build -o "$mygo" github.com/egoist/mygo/cmd/mygo )
fi

# A release is the production form: -X github.com/egoist/mygo.production=1, which
# mygo build sets itself, plus the inspector and the automation plugin, which it
# keeps only with MYGO_INSPECTOR=1 (cmd/mygo/build.go:keepInspector). The agent
# channel has to drive the app that was installed, so it is on unless a build that
# carries no local driver at all is asked for.
if [ "$channel" = 1 ]; then
  export MYGO_INSPECTOR=1
  say "release form: MYGO_INSPECTOR=1 keeps the inspector and the automation plugin"
else
  unset MYGO_INSPECTOR
  say "release form without the agent channel: MYGO_INSPECTOR unset adds -tags mygo_noinspector"
fi

# mygo hands makensis a script it deletes with its work directory
# (cmd/mygo/nsis.go:159, installer.nsi), and that script is the one place that says
# which uninstaller target it writes and where the include's macros are inserted. A
# makensis on PATH that keeps a copy before running the real one makes it readable.
# 7z cannot stand in for it: its NSIS parser stops at a command of this script (its
# listing says BadCmd=13), so it lists the files and no uninstaller entry.
shim="$work/bin"
mkdir -p "$shim"
real_makensis=$(command -v makensis)
cat > "$shim/makensis" <<SHIM
#!/bin/sh
for arg in "\$@"; do
  case "\$arg" in
    *.nsi) cp "\$arg" "$work/installer.nsi" 2>/dev/null || true ;;
  esac
done
exec "$real_makensis" "\$@"
SHIM
chmod +x "$shim/makensis"
PATH="$shim:$PATH"
export PATH

say "mygo build -platform $platform"
( cd "$project" && "$mygo" build -platform "$platform" )

script="$work/installer.nsi"
[ -f "$script" ] || fail "makensis never ran with a script this build could keep: mygo made no installer"

# The uninstaller, from the script mygo wrote: WriteUninstaller is what makes
# Uninstall.exe at install time and puts the app in Settings > Apps. 7z cannot
# confirm it for this installer (its NSIS parser stops at a command it does not
# know and then lists no uninstaller entry), so the script is the evidence.
grep -Fq 'WriteUninstaller "$INSTDIR\Uninstall.exe"' "$script" \
  || fail "the installer script has no WriteUninstaller \"\$INSTDIR\Uninstall.exe\", so Settings > Apps would list nothing to remove"
say "the script mygo wrote: $script ($(byte_size "$script") bytes), and where the include's macros are inserted"
grep -n -E '^!include |WriteUninstaller|!insertmacro custom' "$script" | sed 's/^/  /'

out="$project/build/$stage_platform"
exe=$(find "$out" -maxdepth 1 -type f -name '*.exe' ! -name '*-setup-*' ! -name 'MicrosoftEdgeWebview2Setup.exe' -print -quit 2>/dev/null || true)
setup=$(find "$out" -maxdepth 1 -type f -name '*-setup-*.exe' -print -quit 2>/dev/null || true)
[ -n "$exe" ] || fail "the build produced no .exe under $out"
[ -n "$setup" ] || fail "the build produced no installer (*-setup-*.exe) under $out"

say "the app mygo built holds the payload"
for required in \
  runtime/node/node.exe \
  runtime/node/npm.cmd \
  runtime/host/node_modules/@deepseek-ai/dsh/lib/bin.js \
  runtime/profile-trading/package.json \
  runtime/VERSION.json \
  MicrosoftEdgeWebview2Setup.exe; do
  [ -e "$out/$required" ] || fail "the built app is missing $required (mygo.json ships resources/ as the folder beside the executable)"
done
say "  runtime/ $(du -sh "$out/runtime" | cut -f1), and the bootstrapper beside the executable"

# The same files, into the app directory: an app started straight out of build/ is
# what the owner runs first, before any installer, and it has to be whole too.
say "the files mygo left out, into the built app"
"$node_bin" "$root/desktop/scripts/stage-mygo-dotfiles.mjs" --source "$payload" --prefix runtime --app "$out" | sed 's/^/  /'
"$node_bin" "$root/desktop/scripts/stage-mygo-dotfiles.mjs" --source "$payload" --prefix runtime --app "$out" --check | sed 's/^/  /'

# An independent reading of the same thing: restore-mygo-dotfiles.mjs compares the
# whole tree of the app with the staged payload and expects nothing missing, which
# is now true of an app that has the dotfiles too. This used to be the warning that
# an installed app would start without them.
"$node_bin" "$root/desktop/scripts/restore-mygo-dotfiles.mjs" --source "$payload" --bundle "$out/runtime" --check \
  || fail "the built app does not hold every entry of the staged payload"
say "  the app carries every entry of the staged payload"

say "artifacts"
ls -l "$exe" "$setup"
exe_bytes=$(byte_size "$exe")
setup_bytes=$(byte_size "$setup")
say "  app       $exe  $(human "$exe_bytes") ($exe_bytes bytes)"
say "  installer $setup  $(human "$setup_bytes") ($setup_bytes bytes)"

if [ "$installercheck" = 1 ]; then
  # 7z reads the NSIS header, which names the packed files but holds no contents, and
  # its parser stops at a command of this script it does not know (the listing says
  # BadCmd=13), after which it reports no size and no uninstaller entry. So presence
  # comes from the listing, and bytes from unpacking the installer and comparing what
  # comes out with the files this build packed.
  plugins='$PLUGINSDIR'
  say "what the installer carries ($sevenzip l -slt, then $sevenzip x)"
  listing=$("$sevenzip" l -slt "$setup" 2>/dev/null || true)
  [ -n "$listing" ] || fail "$sevenzip could not read $setup"
  entries=$(echo "$listing" | sed -n 's/^Path = //p')

  for entry in \
    runtime/node/node.exe \
    runtime/node/npm.cmd \
    runtime/host/node_modules/@deepseek-ai/dsh/lib/bin.js \
    runtime/profile-trading/package.json \
    runtime/VERSION.json \
    MicrosoftEdgeWebview2Setup.exe \
    "$plugins/MicrosoftEdgeWebview2Setup.exe"; do
    echo "$entries" | grep -qxF "$entry" || fail "the installer does not carry $entry"
  done
  say "  packed: runtime/node/node.exe, the host closure, the profile seed, and the bootstrapper twice"
  say "          once beside the app, which mygo ships from resources/windows-amd64, and once in $plugins where the install runs it"
  if [ "$redist_present" = 1 ]; then
    echo "$entries" | grep -qxF "$plugins/vc_redist.x64.exe" \
      || fail "the installer does not carry $plugins/vc_redist.x64.exe, so the Visual C++ step would have nothing to run"
    say "  packed: $plugins/vc_redist.x64.exe, which the install runs on a machine without the Visual C++ Runtime"
  else
    say "  not packed: no vc_redist.x64.exe was on this machine, so the install step reports that instead"
  fi

  if echo "$listing" | grep -qx 'Path = Uninstall.exe'; then
    say "  Uninstall.exe: 7z lists it (it is written at install time from the installer data)"
  else
    say "  Uninstall.exe: 7z lists no entry for it, because its parser stops at a command of the script above; the WriteUninstaller line of that script is what an install runs"
  fi

  unpack="$work/unpacked"
  mkdir -p "$unpack"
  say "  unpacking the payload of the installer to check its bytes"
  "$sevenzip" x -y -o"$unpack" "$setup" >"$work/extract.log" 2>&1 \
    || fail "$sevenzip could not unpack $setup (see $work/extract.log)"

  inside_bootstrapper="$unpack/$plugins/MicrosoftEdgeWebview2Setup.exe"
  [ -f "$inside_bootstrapper" ] || fail "the installer has no $plugins/MicrosoftEdgeWebview2Setup.exe"
  [ "$(digest "$inside_bootstrapper")" = "$(digest "$bootstrapper")" ] \
    || fail "the bootstrapper inside the installer is not the file this build fetched ($bootstrapper)"
  say "  MicrosoftEdgeWebview2Setup.exe: $(byte_size "$inside_bootstrapper") bytes in $plugins, sha256 $(digest "$inside_bootstrapper")"

  if [ "$redist_present" = 1 ]; then
    inside_redist="$unpack/$plugins/vc_redist.x64.exe"
    [ -f "$inside_redist" ] || fail "the installer has no $plugins/vc_redist.x64.exe"
    [ "$(digest "$inside_redist")" = "$(digest "$redist")" ] \
      || fail "vc_redist.x64.exe inside the installer is not desktop/resources/redist/vc_redist.x64.exe"
    say "  vc_redist.x64.exe: $(byte_size "$inside_redist") bytes in $plugins, sha256 $(digest "$inside_redist")"
  fi

  # The files mygo drops, from the installer rather than from the build: the app it
  # installs has to hold them, which is what the macro above is for. Files only: an
  # installer packs no directory, so a dotted directory that holds nothing is made at
  # install time by the macro's CreateDirectory and cannot appear in an unpacked tree
  # (the count of those is checked above, from the macro itself).
  "$node_bin" "$root/desktop/scripts/stage-mygo-dotfiles.mjs" --source "$payload" --prefix runtime --app "$unpack" --check --files-only \
    || fail "the installer does not carry the $dotfiles_files files mygo leaves out of the app's resources"
  say "  the installer carries all $dotfiles_files files of them ($dotfiles_bytes bytes), byte for byte, and $dotfiles_dirs directories by the macro's CreateDirectory"
  say "  the install steps are those of installer/windows.nsh: the WebView2 client id, the VC++ registry test, the dotfile macro and the two data directories of the uninstall question"
fi

say "neither the installer nor the app was run: this is a Windows build made on $(uname -s), and both need Windows to run"
say "app       $exe"
say "installer $setup"
