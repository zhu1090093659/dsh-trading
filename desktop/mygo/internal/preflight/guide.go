package preflight

// The guidance window's buttons, in the order its content lists them.
const (
	// ActionOpen hands the download page to the system browser.
	ActionOpen = iota
	// ActionCopy puts the download address on the clipboard, so that a machine
	// whose browser no window can reach can still be told where to go.
	ActionCopy
	// ActionQuit ends the app. Closing the window asks for this too: the app
	// cannot run without the runtime.
	ActionQuit
)

// Prompt is what the guidance window shows.
type Prompt struct {
	// Title is the window's title.
	Title string
	// Message is the window's main line.
	Message string
	// Detail is the text under it: what is missing, how the Windows versions
	// differ, and the address that installs the runtime.
	Detail string
	// Buttons are the window's buttons, the Action constants indexing them.
	Buttons []string
}

// Guidance is the content of the guidance window, worded as the shell's own
// startup page words a failure: the problem, then what to do about it, in the
// two languages that page uses.
func Guidance() Prompt {
	return Prompt{
		Title:   "DSH Trading",
		Message: "Microsoft Edge WebView2 Runtime is missing / 缺少 Microsoft Edge WebView2 运行时",
		Detail: "DSH Trading 的窗口由 Microsoft Edge WebView2 渲染，这台机器上没有安装该运行时。\n" +
			"This window is drawn by Microsoft Edge WebView2, which this machine does not have.\n\n" +
			"Windows 10 需要安装一次；Windows 11 通常自带，缺失说明安装已损坏，重新安装可修复。\n" +
			"Windows 10 does not include it; Windows 11 usually does, so a missing one there is an installation to repair.\n\n" +
			"下载地址 / Download: " + Download,
		Buttons: []string{
			"打开下载页 / Open the download page",
			"复制地址 / Copy the link",
			"退出 / Quit",
		},
	}
}

// Effects is what the guidance needs of the world: its window, the system's
// browser, and the clipboard. The window is the platform's own (see Guide);
// these are what a test stands in for.
type Effects struct {
	// Ask shows the guidance window and reports the button that answered it.
	Ask func(p Prompt) (button int, err error)
	// Open hands the download page to the system browser.
	Open func(url string) error
	// Copy puts the download address on the clipboard.
	Copy func(text string) error
}

// Run shows the guidance window until the user quits it, and reports what
// failed on the way.
//
// A button that cannot do its work, a machine with no browser or no clipboard,
// does not end the window: it stays up, asking again, so the address can still
// be read off it and typed elsewhere. Run reports the first such failure once
// the user is done. A window that answers with no button at all, which is a
// window closed, ends the app like the quit button does.
func Run(e Effects) error {
	var failure error
	for {
		button, err := e.Ask(Guidance())
		if err != nil {
			return err
		}
		switch button {
		case ActionOpen:
			failure = firstFailure(failure, e.Open(Download))
		case ActionCopy:
			failure = firstFailure(failure, e.Copy(Download))
		default:
			return failure
		}
	}
}

// firstFailure keeps the first failure of a run: the ones after it are the
// same attempt failing again.
func firstFailure(kept, err error) error {
	if kept != nil {
		return kept
	}
	return err
}
