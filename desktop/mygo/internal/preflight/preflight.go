// Package preflight decides, before the shell starts, whether this machine
// can show the shell's window.
//
// On Windows that window is a WebView2 page: mygo loads the Microsoft Edge
// WebView2 Runtime to show it, and with no runtime installed it can create no
// window at all, so the app would end on one line of stderr and no window. The
// runtime is a separate installation on Windows 10, where Windows 11 usually
// ships with it, which is why the app asks for it first and, when it is
// missing, shows a window the runtime is no part of instead: the guidance
// window, which points at the page that installs it (see Guide).
//
// The runtime is looked for on the file system rather than in the registry. An
// installed runtime is a directory holding mygo's browser process and the
// client library it loads, the Windows installer writes those directories
// under the machine's Program Files (x86) and under the user's LOCALAPPDATA,
// and the registry only names the one an EdgeUpdate channel recorded. A probe
// of the directories needs no Windows API and no dependency, so it stays a
// function of an environment and a directory tree, and its tests run on any
// platform (see Locate).
package preflight

import (
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
)

// Download is where Microsoft serves the runtime: the address the guidance
// window shows, copies and opens. It is mygo's own, internal/webview2's
// Download, the one its "not installed" error names, so the window and the
// error an installed-runtime check would print agree.
const Download = "https://go.microsoft.com/fwlink/p/?LinkId=2124703"

// The pieces of a runtime, named as mygo names them: its browser process at the
// root of its directory, and the client library it loads for this process's
// architecture under EBWebView. Both must be there: a directory holding only
// one of them is an installation that starts no page, which mygo's own lookup
// reports as incomplete rather than installed (internal/webview2.ClientDLL).
const (
	browserExe = "msedgewebview2.exe"
	clientDir  = "EBWebView"
	clientDLL  = "EmbeddedBrowserWebView.dll"
)

// Roots are the places a runtime can be, in the order mygo looks them up.
type Roots struct {
	// Fixed is WEBVIEW2_BROWSER_EXECUTABLE_FOLDER: the directory of a
	// fixed-version runtime, which is the runtime the app uses when it is set,
	// installed or not.
	Fixed string
	// Machine is %ProgramFiles(x86)%MicrosoftEdgeWebViewApplication, where
	// the installer puts a runtime for every user of the machine.
	Machine string
	// User is %LOCALAPPDATA%MicrosoftEdgeWebViewApplication, where it puts
	// one for a user alone.
	User string
}

// RootsFor reads the roots of one machine's environment, as the installer
// writes them: getenv is os.Getenv of the running process, and a test's own
// environment.
func RootsFor(getenv func(string) string) Roots {
	return Roots{
		Fixed:   getenv("WEBVIEW2_BROWSER_EXECUTABLE_FOLDER"),
		Machine: installDir(getenv("ProgramFiles(x86)")),
		User:    installDir(getenv("LOCALAPPDATA")),
	}
}

// installDir is where the installer keeps the versions of the runtime under
// base, one directory each, or "" without a base.
func installDir(base string) string {
	if base == "" {
		return ""
	}
	return filepath.Join(base, "Microsoft", "EdgeWebView", "Application")
}

// Locate returns the directory of the runtime mygo would load from roots, and
// whether one is there, the directory empty when it is not: the fixed-version
// runtime the environment names, or else the newest installed one, the
// machine's before the user's.
//
// A fixed-version runtime named but not there ends the search, as it does for
// mygo: the app is told to install the runtime rather than load one from a
// directory the environment does not name.
func Locate(roots Roots) (dir string, ok bool) {
	if roots.Fixed != "" {
		if !runtimeAt(roots.Fixed) {
			return "", false
		}
		return roots.Fixed, true
	}
	for _, root := range []string{roots.Machine, roots.User} {
		if dir := newestRuntime(root); dir != "" {
			return dir, true
		}
	}
	return "", false
}

// newestRuntime returns the newest version directory of an install root that
// holds a runtime, or "" when none does or the root is no directory.
func newestRuntime(root string) string {
	entries, err := os.ReadDir(root)
	if err != nil {
		return ""
	}
	newest, newestVersion := "", []int(nil)
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		dir := filepath.Join(root, entry.Name())
		if !runtimeAt(dir) {
			continue
		}
		version := parseVersion(entry.Name())
		if newest == "" || compareVersions(version, newestVersion) > 0 {
			newest, newestVersion = dir, version
		}
	}
	return newest
}

// runtimeAt reports whether dir holds a runtime this process can load.
func runtimeAt(dir string) bool {
	if _, err := os.Stat(filepath.Join(dir, browserExe)); err != nil {
		return false
	}
	_, err := os.Stat(filepath.Join(dir, clientDir, archDir(), clientDLL))
	return err == nil
}

// archDir is the client library's directory for this process's architecture.
func archDir() string {
	switch runtime.GOARCH {
	case "arm64":
		return "arm64"
	case "386":
		return "x86"
	}
	return "x64"
}

// parseVersion reads a runtime directory's name as its version, and nil when
// it is not one, so that a directory named otherwise sorts below every version.
func parseVersion(name string) []int {
	var version []int
	for _, part := range strings.Split(name, ".") {
		n, err := strconv.Atoi(part)
		if err != nil {
			return nil
		}
		version = append(version, n)
	}
	return version
}

// compareVersions orders two versions, a missing part counting as zero, so
// that "1.2" is older than "1.2.1" and neither is older than itself.
func compareVersions(a, b []int) int {
	for i := 0; i < len(a) || i < len(b); i++ {
		var x, y int
		if i < len(a) {
			x = a[i]
		}
		if i < len(b) {
			y = b[i]
		}
		if x != y {
			if x < y {
				return -1
			}
			return 1
		}
	}
	return 0
}

// MissingLine is the one line the app logs when it stops on a missing runtime:
// what was looked for, every place that was searched, and the page that
// installs it. It is one line so that it reads as the shell's own log lines do.
func MissingLine(roots Roots) string {
	searched := make([]string, 0, 3)
	if roots.Fixed != "" {
		searched = append(searched, "WEBVIEW2_BROWSER_EXECUTABLE_FOLDER="+roots.Fixed)
	}
	for _, dir := range []string{roots.Machine, roots.User} {
		if dir != "" {
			searched = append(searched, dir)
		}
	}
	line := "the Microsoft Edge WebView2 Runtime is missing: no " + browserExe +
		" with " + filepath.Join(clientDir, archDir(), clientDLL)
	if len(searched) > 0 {
		line += " under " + strings.Join(searched, ", ")
	} else {
		line += " in any install location this machine names"
	}
	return line + "; it comes from " + Download
}
