//go:build windows

package preflight

import (
	"fmt"
	"os"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/transfer"
)

// exitCode is what the app exits with once the guidance window is gone: it did
// not start, and main's own failures exit with the same code.
const exitCode = 1

// Missing reports whether this machine cannot show the shell's window: the
// Windows shell shows a WebView2 page, and mygo creates no such window without
// the runtime.
func Missing() bool {
	_, ok := Locate(RootsFor(os.Getenv))
	return !ok
}

// Guide shows the guidance window, logs why the app cannot start, and returns
// the code the app exits with.
//
// The window is the platform's task dialog, drawn by mygo from the Prompt: it
// starts no webview, which is the point of showing it where the runtime is
// missing, and it needs no window of the app's to belong to.
func Guide() int {
	fmt.Fprintln(os.Stderr, "[preflight] "+MissingLine(RootsFor(os.Getenv)))
	mygo.App.WhenReady(func() {
		// Off the main thread: the dialog blocks until it is answered, and
		// the main thread is what answers it.
		go func() {
			reportGuidanceFailure(Run(taskDialog()))
			mygo.App.Quit()
		}()
	})
	reportGuidanceFailure(mygo.App.Run())
	return exitCode
}

// reportGuidanceFailure writes a guidance window that could not show or could
// not answer, in the log line shape the shell's own failures use. The app still
// exits with exitCode: the runtime is missing either way.
func reportGuidanceFailure(err error) {
	if err == nil {
		return
	}
	fmt.Fprintln(os.Stderr, "[preflight] showing the WebView2 guidance failed: "+err.Error())
}

// taskDialog is the guidance's window: the platform's task dialog, and the
// shell's own browser and clipboard behind its buttons.
func taskDialog() Effects {
	return Effects{
		Ask: func(p Prompt) (int, error) {
			result, err := mygo.Dialog.Message(mygo.MessageOptions{
				Type:    mygo.MessageWarning,
				Title:   p.Title,
				Message: p.Message,
				Detail:  p.Detail,
				Buttons: p.Buttons,
				// Enter opens the download page, and the window's own close
				// button answers Quit: closing the window without a button
				// still ends an app that cannot run.
				DefaultButton: ActionOpen,
				CancelButton:  ActionQuit,
			})
			if err != nil {
				return ActionQuit, err
			}
			return result.Button, nil
		},
		Open: mygo.Shell.OpenExternal,
		Copy: func(text string) error {
			return mygo.Clipboard.Write(transfer.TextData(text))
		},
	}
}
