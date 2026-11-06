//go:build !windows

package main

import "syscall"

// killProcess ends one process outright, the way an outside kill would: no
// handler runs, so the shell cannot mistake it for its own shutdown.
func killProcess(pid int) error { return syscall.Kill(pid, syscall.SIGKILL) }

// requestQuit asks the observed shell to leave the way a window manager's close
// request does. SIGTERM is what a GUI toolkit on these platforms turns into its
// quit path.
func requestQuit(pid int) (string, error) {
	if err := syscall.Kill(pid, syscall.SIGTERM); err != nil {
		return "", err
	}
	return "sigterm", nil
}
