// Command agentctl drives a running DSH Trading mygo shell through the socket
// the mygo automation plugin listens on.
//
// It is the local client of the agent channel card: list the shell's windows,
// evaluate a script inside the GUI page, capture a window as a PNG, and wait for
// the window to settle. The app must be built with the inspector kept (mygo
// build -debug, or MYGO_INSPECTOR=1 mygo build) and started with
// MYGO_AUTOMATION=<socket path>.
//
// Usage:
//
//	agentctl [-socket path] [-window id] <command> [arguments]
//
// Commands:
//
//	windows                 list the app's windows as JSON
//	eval <script>           evaluate a script in the window's page, print its JSON value
//	capture <file.png>      capture the window as PNG, print {path,bytes,width,height}
//	idle [timeout]          wait until the window settles (default 2s)
//	tree                    print the window's accessibility tree (a web page answers unsupported)
//
// The socket defaults to $MYGO_AUTOMATION, the variable the app listens on, and
// the window to 0, which the app reads as the focused window, else the first.
package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/dshtrading/desktop-mygo/internal/automation"
)

// exit codes: 1 is the app refusing or failing a request, 2 a usage error.
const (
	exitFailed = 1
	exitUsage  = 2
)

// usage is what -h and a usage error print.
const usage = `agentctl drives a running DSH Trading mygo shell through its automation socket.

Usage:
  agentctl [-socket path] [-window id] <command> [arguments]

Commands:
  windows                 list the app's windows as JSON
  eval <script>           evaluate a script in the window's page, print its JSON value
  capture <file.png>      capture the window as PNG, print {path,bytes,width,height}
  idle [timeout]          wait until the window settles (default 2s)
  tree                    print the window's accessibility tree (a web page answers unsupported)

The socket defaults to $MYGO_AUTOMATION; the window to 0 (the focused window, else the first).`

func main() {
	if err := run(os.Args[1:]); err != nil {
		if errors.Is(err, errUsage) {
			fmt.Fprintln(os.Stderr, usage)
			os.Exit(exitUsage)
		}
		fmt.Fprintln(os.Stderr, "agentctl: "+err.Error())
		os.Exit(exitFailed)
	}
}

// errUsage marks a bad command line, which prints the usage text.
var errUsage = errors.New("usage")

func run(args []string) error {
	socket := os.Getenv(automation.Env)
	window := 0
	for len(args) > 0 && strings.HasPrefix(args[0], "-") {
		flag := args[0]
		if flag == "-h" || flag == "--help" {
			fmt.Println(usage)
			return nil
		}
		if len(args) < 2 {
			return fmt.Errorf("%w: %s needs a value", errUsage, flag)
		}
		value := args[1]
		args = args[2:]
		switch flag {
		case "-socket":
			socket = value
		case "-window":
			parsed, err := strconv.Atoi(value)
			if err != nil {
				return fmt.Errorf("%w: -window %q is not a number", errUsage, value)
			}
			window = parsed
		default:
			return fmt.Errorf("%w: no flag %s", errUsage, flag)
		}
	}
	if len(args) == 0 {
		return fmt.Errorf("%w: no command", errUsage)
	}
	command, rest := args[0], args[1:]
	if socket == "" {
		return fmt.Errorf("no socket: set %s or pass -socket (the app listens on it only in a build that kept the inspector)", automation.Env)
	}
	client, err := automation.Dial(socket)
	if err != nil {
		return err
	}
	defer client.Close()
	switch command {
	case "windows":
		return listWindows(client)
	case "eval":
		if len(rest) != 1 {
			return fmt.Errorf("%w: eval takes one script", errUsage)
		}
		return eval(client, window, rest[0])
	case "capture":
		if len(rest) != 1 {
			return fmt.Errorf("%w: capture takes one output file", errUsage)
		}
		return capture(client, window, rest[0])
	case "idle":
		return idle(client, window, rest)
	case "tree":
		return tree(client, window)
	}
	return fmt.Errorf("%w: unknown command %q", errUsage, command)
}

// listWindows prints the app's windows.
func listWindows(client *automation.Client) error {
	windows, err := client.Windows()
	if err != nil {
		return err
	}
	return printJSON(windows)
}

// eval prints the JSON value a script answered.
func eval(client *automation.Client, window int, script string) error {
	value, err := client.Eval(window, script)
	if err != nil {
		return err
	}
	fmt.Println(string(value))
	return nil
}

// capture writes a window's PNG and reports what it captured.
func capture(client *automation.Client, window int, path string) error {
	captured, err := client.Capture(window)
	if err != nil {
		return err
	}
	if err := os.WriteFile(path, captured.PNG, 0o644); err != nil {
		return err
	}
	return printJSON(struct {
		Path   string `json:"path"`
		Bytes  int    `json:"bytes"`
		Width  int    `json:"width"`
		Height int    `json:"height"`
	}{Path: path, Bytes: len(captured.PNG), Width: captured.Width, Height: captured.Height})
}

// idle waits for the window to settle.
func idle(client *automation.Client, window int, rest []string) error {
	timeout := 2 * time.Second
	if len(rest) > 1 {
		return fmt.Errorf("%w: idle takes at most one timeout", errUsage)
	}
	if len(rest) == 1 {
		parsed, err := time.ParseDuration(rest[0])
		if err != nil {
			return fmt.Errorf("%w: idle %q is not a duration (try 2s)", errUsage, rest[0])
		}
		timeout = parsed
	}
	if err := client.Idle(window, timeout); err != nil {
		return err
	}
	return printJSON(struct {
		Settled bool `json:"settled"`
	}{Settled: true})
}

// tree prints the window's accessibility tree. A window of this shell shows a
// web page, which answers unsupported: the tree is no way into it, eval is.
func tree(client *automation.Client, window int) error {
	raw, err := client.Tree(window)
	if err != nil {
		return err
	}
	fmt.Println(string(raw))
	return nil
}

// printJSON writes one indented JSON value.
func printJSON(value any) error {
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	fmt.Println(string(data))
	return nil
}
