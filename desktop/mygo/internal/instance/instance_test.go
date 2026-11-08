package instance

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// lockPath names a lock file inside the test's temp dir.
func lockPath(t *testing.T) string {
	t.Helper()
	return filepath.Join(t.TempDir(), "nested", "instance.lock")
}

// waitForFocus reports whether the focus callback ran within a second.
func waitForFocus(t *testing.T, focused <-chan struct{}) {
	t.Helper()
	select {
	case <-focused:
	case <-time.After(2 * time.Second):
		t.Fatal("the second launch never reached the first instance")
	}
}

func TestAcquireIsExclusiveAndNotifiesTheFirstInstance(t *testing.T) {
	path := lockPath(t)
	focused := make(chan struct{}, 1)
	first, err := Acquire(path, func() { focused <- struct{}{} })
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
	waitForFocus(t, focused)
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

func TestAcquireClearsAStaleSocket(t *testing.T) {
	path := lockPath(t)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("MkdirAll err = %v", err)
	}
	if err := os.WriteFile(socketPath(path), []byte("stale"), 0o600); err != nil {
		t.Fatalf("writing the stale socket err = %v", err)
	}
	lock, err := Acquire(path, nil)
	if err != nil {
		t.Fatalf("Acquire err = %v, want nil", err)
	}
	defer lock.Release()

	info, err := os.Stat(socketPath(path))
	if err != nil {
		t.Fatalf("Stat socket err = %v", err)
	}
	if info.Mode()&os.ModeSocket == 0 {
		t.Errorf("socket mode = %v, want a socket", info.Mode())
	}
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
	long := filepath.Join(t.TempDir(), string(make([]byte, 0))+repeat("/a-very-long-directory-name-that-goes-on", 4), "instance.lock")
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

func TestASecondLaunchLeavesTheFirstSocketAlone(t *testing.T) {
	path := lockPath(t)
	focused := make(chan struct{}, 1)
	first, err := Acquire(path, func() { focused <- struct{}{} })
	if err != nil {
		t.Fatalf("Acquire (first) err = %v, want nil", err)
	}
	defer first.Release()

	// The rejected launch knocks on the socket the first instance owns.
	if _, err := Acquire(path, nil); !errors.Is(err, ErrRunning) {
		t.Fatalf("Acquire (second) err = %v, want ErrRunning", err)
	}
	waitForFocus(t, focused)
	info, err := os.Stat(socketPath(path))
	if err != nil {
		t.Fatalf("Stat socket after the rejected launch err = %v, want the first instance's socket", err)
	}
	if info.Mode()&os.ModeSocket == 0 {
		t.Fatalf("socket mode = %v, want the first instance's socket", info.Mode())
	}
	// And it is still the handover channel: a third launch reaches the first.
	if _, err := Acquire(path, nil); !errors.Is(err, ErrRunning) {
		t.Fatalf("Acquire (third) err = %v, want ErrRunning", err)
	}
	waitForFocus(t, focused)
}

func TestALongLockPathFallsBackToAHashInTheTempDir(t *testing.T) {
	long := filepath.Join(t.TempDir(), repeat("/a-very-long-directory-name-that-goes-on", 4), "instance.lock")
	got := socketPath(long)
	if !strings.HasPrefix(got, os.TempDir()+string(os.PathSeparator)) {
		t.Fatalf("socketPath(long) = %q, want a path inside %q", got, os.TempDir())
	}
	if again := socketPath(long); again != got {
		t.Errorf("socketPath(long) = %q then %q, want a stable name", got, again)
	}
	if other := socketPath(long + "-other"); other == got {
		t.Errorf("socketPath of another lock path = %q, want a different name", other)
	}
}
