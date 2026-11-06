//go:build !windows

package preflight

// Missing is always false away from Windows: the shell's window is a WebView2
// page on Windows alone, so every other platform starts the shell exactly as
// it always has, with no probe and no window of this package's.
func Missing() bool { return false }

// Guide never runs away from Windows, where Missing reports false. It is the
// call main makes when the runtime is missing, and there is no such runtime
// here to miss.
func Guide() int { return 0 }
