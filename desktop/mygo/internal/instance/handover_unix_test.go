//go:build !windows

package instance

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// waitForFocus reports whether the focus callback ran within a second.
func waitForFocus(t *testing.T, focused <-chan struct{}) {
	t.Helper()
	select {
	case <-focused:
	case <-time.After(2 * time.Second):
		t.Fatal("the second launch never reached the first instance")
	}
}

func TestAcquireNotifiesTheFirstInstance(t *testing.T) {
	path := lockPath(t)
	focused := make(chan struct{}, 1)
	first, err := Acquire(path, func() { focused <- struct{}{} })
	if err != nil {
		t.Fatalf("Acquire (first) err = %v, want nil", err)
	}
	defer first.Release()

	if _, err := Acquire(path, nil); !errors.Is(err, ErrRunning) {
		t.Fatalf("Acquire (second) err = %v, want ErrRunning", err)
	}
	waitForFocus(t, focused)
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
