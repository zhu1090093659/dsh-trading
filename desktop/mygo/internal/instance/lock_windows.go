//go:build windows

package instance

import (
	"errors"
	"os"

	"golang.org/x/sys/windows"
)

// maxUnixSocketPath keeps the socket inside the Windows afunix sun_path: 108
// bytes in the sockaddr layout (UNIX_PATH_MAX), one of which the API reserves
// for the terminating NUL of a named socket, so 107 is the last usable length.
const maxUnixSocketPath = 107

// lockFile takes the exclusive, non-blocking byte-range lock on file with
// LockFileEx. The lock belongs to the handle, so the kernel drops it when the
// process dies, exactly like flock; a second instance gets ERROR_LOCK_VIOLATION
// instead of a lock, which maps onto the same ErrRunning branch as the unices.
func lockFile(file *os.File) (func() error, error) {
	handle := windows.Handle(file.Fd())
	err := windows.LockFileEx(handle,
		windows.LOCKFILE_EXCLUSIVE_LOCK|windows.LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, new(windows.Overlapped))
	if err != nil {
		if errors.Is(err, windows.ERROR_LOCK_VIOLATION) {
			return nil, errLockHeld
		}
		return nil, err
	}
	return func() error {
		return windows.UnlockFileEx(handle, 0, 1, 0, new(windows.Overlapped))
	}, nil
}
