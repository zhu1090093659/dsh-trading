//go:build windows

package main

import (
	"fmt"
	"syscall"

	"golang.org/x/sys/windows"
)

// wmClose is WM_CLOSE, the message a click on a window's close button posts.
const wmClose = 0x0010

// user32 is where the window calls live; none of them have a cgo-free wrapper in
// the standard library.
var (
	user32          = windows.NewLazySystemDLL("user32.dll")
	procPostMessage = user32.NewProc("PostMessageW")
)

// killProcess ends one process outright with TerminateProcess, the Windows
// equivalent of SIGKILL: no handler runs, so the shell cannot mistake it for its
// own shutdown.
func killProcess(pid int) error {
	handle, err := windows.OpenProcess(windows.PROCESS_TERMINATE, false, uint32(pid))
	if err != nil {
		return err
	}
	defer windows.CloseHandle(handle)
	return windows.TerminateProcess(handle, 1)
}

// requestQuit asks the observed shell to quit the way a click on its window's
// close button does: WM_CLOSE to its top-level window. That is the path the
// shell's own teardown hangs off, so the tree reclaim it performs is what the
// run then measures.
func requestQuit(pid int) (string, error) {
	window := topLevelWindow(uint32(pid))
	if window == 0 {
		return "", fmt.Errorf("pid %d has no visible top-level window to close", pid)
	}
	if err := postMessage(window, wmClose, 0, 0); err != nil {
		return "", fmt.Errorf("posting WM_CLOSE to the shell window: %w", err)
	}
	return "wm-close", nil
}

// topLevelWindow finds the first visible top-level window owned by pid.
func topLevelWindow(pid uint32) windows.HWND {
	var found windows.HWND
	callback := syscall.NewCallback(func(window windows.HWND, _ uintptr) uintptr {
		var owner uint32
		if _, err := windows.GetWindowThreadProcessId(window, &owner); err != nil {
			return 1
		}
		if owner == pid && windows.IsWindowVisible(window) {
			found = window
			return 0
		}
		return 1
	})
	_ = windows.EnumWindows(callback, nil)
	return found
}

// postMessage posts one window message.
func postMessage(window windows.HWND, message uint32, wparam, lparam uintptr) error {
	posted, _, err := procPostMessage.Call(uintptr(window), uintptr(message), wparam, lparam)
	if posted == 0 {
		return err
	}
	return nil
}
