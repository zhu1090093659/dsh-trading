// Command dsh-trading-mygo is the mygo desktop shell of DSH Trading.
//
// It is the migration target of the Electron shell in desktop/src: the window
// and its launcher, the single-instance lock, the attach handoff, the cookie
// prune and the window.desktop bridge all live in internal/shell. Both shells
// ship side by side while the migration lands.
package main

import (
	"fmt"
	"os"

	"github.com/dshtrading/desktop-mygo/internal/preflight"
	"github.com/dshtrading/desktop-mygo/internal/shell"
)

// appName names this shell's own directories. It is deliberately not the
// Electron app's "DSH Trading": the two shells coexist, and a shared user data
// directory would mean a shared cookie jar, webview cache and instance lock.
const appName = "DSH Trading Mygo"

func main() {
	// On Windows the window is a WebView2 page, so the runtime is asked for
	// before the shell starts: without it no window can show, and the guidance
	// window says where the runtime comes from instead of the shell dying on a
	// line of stderr.
	if preflight.Missing() {
		os.Exit(preflight.Guide())
	}
	if err := shell.New(shell.Options{Name: appName}).Run(); err != nil {
		fmt.Fprintln(os.Stderr, "dsh-trading-mygo: "+err.Error())
		os.Exit(1)
	}
}
