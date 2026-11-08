//go:build !windows

package instance

import (
	"errors"
	"net"
	"os"
	"syscall"
)

// maxUnixSocketPath keeps the socket inside the platforms' sun_path: 104 bytes
// on macOS and 108 on Linux, both counting the terminating NUL, so 96 leaves
// room for the ".sock" suffix either way.
const maxUnixSocketPath = 96

// handoverListener is the AF_UNIX socket a later launch knocks on to make this
// one show its window.
func handoverListener(socket string) (net.Listener, error) {
	return net.Listen("unix", socket)
}

// lockFile takes the exclusive, non-blocking flock on file. The kernel drops it
// when the process dies, so a crashed shell never leaves a stale lock, and
// closing the file is all the release this needs.
func lockFile(file *os.File) (func() error, error) {
	if err := syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		if errors.Is(err, syscall.EWOULDBLOCK) || errors.Is(err, syscall.EAGAIN) {
			return nil, errLockHeld
		}
		return nil, err
	}
	return nil, nil
}
