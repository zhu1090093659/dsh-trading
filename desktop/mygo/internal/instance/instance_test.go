package instance

import (
	"errors"
	"path/filepath"
	"testing"
	"time"
)

// lockPath names a lock file inside the test's temp dir.
func lockPath(t *testing.T) string {
	t.Helper()
	return filepath.Join(t.TempDir(), "nested", "instance.lock")
}

func TestAcquireIsExclusive(t *testing.T) {
	path := lockPath(t)
	first, err := Acquire(path, nil)
	if err != nil {
		t.Fatalf("Acquire (first) err = %v, want nil", err)
	}
	defer first.Release()

	second, err := Acquire(path, nil)
	if !errors.Is(err, ErrRunning) {
		t.Fatalf("Acquire (second) err = %v, want ErrRunning", err)
	}
	if second != nil {
		t.Fatal("Acquire (second) returned a lock, want nil")
	}
}

func TestReleaseLetsTheNextLaunchIn(t *testing.T) {
	path := lockPath(t)
	first, err := Acquire(path, nil)
	if err != nil {
		t.Fatalf("Acquire (first) err = %v, want nil", err)
	}
	first.Release()
	first.Release() // a second release is a no-op, not a panic

	second, err := Acquire(path, nil)
	if err != nil {
		t.Fatalf("Acquire after Release err = %v, want nil", err)
	}
	second.Release()
}

func TestNotifyWithoutAListenerDoesNotBlockTheLaunch(t *testing.T) {
	path := lockPath(t)
	start := time.Now()
	lock, err := Acquire(path, nil)
	if err != nil {
		t.Fatalf("Acquire err = %v, want nil", err)
	}
	// The lock holds an open file handle: releasing it before the temp dir goes
	// is what lets Windows remove the directory at all.
	t.Cleanup(lock.Release)
	// Nothing listens on this socket: the handover attempt must give up on its
	// own rather than hang the launch.
	notify(filepath.Join(t.TempDir(), "nobody.sock"))
	if elapsed := time.Since(start); elapsed > notifyTimeout+time.Second {
		t.Errorf("notify took %s, want under %s", elapsed, notifyTimeout)
	}
}

func TestSocketPathStaysInsideTheUnixLimit(t *testing.T) {
	short := filepath.Join(t.TempDir(), "instance.lock")
	if got := socketPath(short); got != short+".sock" {
		t.Errorf("socketPath(short) = %q, want %q", got, short+".sock")
	}
	long := filepath.Join(t.TempDir(), repeat("/a-very-long-directory-name-that-goes-on", 4), "instance.lock")
	if got := socketPath(long); len(got) > maxUnixSocketPath {
		t.Errorf("socketPath(long) = %q (%d bytes), want at most %d", got, len(got), maxUnixSocketPath)
	}
}

// repeat builds a string of n copies of s.
func repeat(s string, n int) string {
	out := ""
	for i := 0; i < n; i++ {
		out += s
	}
	return out
}
