// Package instance keeps one shell per machine, the Go counterpart of
// Electron's requestSingleInstanceLock plus second-instance window focus.
//
// Two Go primitives carry it: an exclusive flock on a lock file says who is
// first (and the kernel drops it when that process dies, so no stale lock
// survives a crash), and a unix socket lets a later launch ask the first one to
// show its window before it exits.
package instance

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net"
	"os"
	"path/filepath"
	"sync"
	"syscall"
	"time"
)

// ErrRunning reports that another instance already owns the lock. The launch
// has handed itself over to that instance and must exit.
var ErrRunning = errors.New("instance: another instance is already running")

// notifyTimeout bounds the handover: a first instance that stopped answering
// must not keep this launch hanging.
const notifyTimeout = 2 * time.Second

// maxUnixSocketPath keeps the socket inside the platforms' sun_path limit (104
// bytes on macOS, 108 on Linux); a longer path falls back to the temp dir.
const maxUnixSocketPath = 96

// Lock is the single-instance lock one running shell holds.
type Lock struct {
	file     *os.File
	socket   string
	listener net.Listener

	release sync.Once
}

// Acquire takes the single-instance lock at lockPath. It returns ErrRunning
// when another instance holds it, after asking that instance to focus its
// window through onSecondLaunch.
func Acquire(lockPath string, onSecondLaunch func()) (*Lock, error) {
	if err := os.MkdirAll(filepath.Dir(lockPath), 0o755); err != nil {
		return nil, err
	}
	file, err := os.OpenFile(lockPath, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		_ = file.Close()
		if errors.Is(err, syscall.EWOULDBLOCK) || errors.Is(err, syscall.EAGAIN) {
			notify(socketPath(lockPath))
			return nil, ErrRunning
		}
		return nil, err
	}
	socket := socketPath(lockPath)
	// A crashed instance leaves its socket file behind; the flock is the lock,
	// so the file itself is only garbage to clear.
	_ = os.Remove(socket)
	listener, err := net.Listen("unix", socket)
	if err != nil {
		_ = file.Close()
		return nil, err
	}
	lock := &Lock{file: file, socket: socket, listener: listener}
	go lock.accept(onSecondLaunch)
	return lock, nil
}

// accept answers every later launch's handover request with a focus callback.
func (l *Lock) accept(onSecondLaunch func()) {
	for {
		conn, err := l.listener.Accept()
		if err != nil {
			return
		}
		_, _ = conn.Write([]byte("focus\n"))
		_ = conn.Close()
		if onSecondLaunch != nil {
			onSecondLaunch()
		}
	}
}

// Release gives up the lock: the listener goes, the socket file goes, and
// closing the file drops the flock.
func (l *Lock) Release() {
	l.release.Do(func() {
		if l.listener != nil {
			_ = l.listener.Close()
		}
		_ = os.Remove(l.socket)
		_ = l.file.Close()
	})
}

// notify tells the running instance to show its window. Failure is silent: the
// launch must exit either way.
func notify(socket string) {
	conn, err := net.DialTimeout("unix", socket, notifyTimeout)
	if err != nil {
		return
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(notifyTimeout))
	_, _ = conn.Write([]byte("focus\n"))
	_, _ = conn.Read(make([]byte, 8))
}

// socketPath places the focus socket beside the lock file, or in the temp dir
// under a hash of it when that path would not fit a unix socket address.
func socketPath(lockPath string) string {
	path := lockPath + ".sock"
	if len(path) <= maxUnixSocketPath {
		return path
	}
	sum := sha256.Sum256([]byte(lockPath))
	return filepath.Join(os.TempDir(), "dsh-mygo-"+hex.EncodeToString(sum[:4])+".sock")
}
