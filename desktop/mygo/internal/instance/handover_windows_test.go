//go:build windows

package instance

import (
	"errors"
	"os"
	"testing"
)

// Windows has no AF_UNIX handover channel (handoverListener returns nil), so the
// lock alone must turn a second launch away — and acquiring it must not fail for
// the missing channel.
func TestAcquireExcludesASecondLaunchWithoutAHandoverChannel(t *testing.T) {
	path := lockPath(t)
	first, err := Acquire(path, func() { t.Error("a focus handover happened, want none on Windows") })
	if err != nil {
		t.Fatalf("Acquire err = %v, want nil", err)
	}
	defer first.Release()

	second, err := Acquire(path, nil)
	if !errors.Is(err, ErrRunning) {
		t.Fatalf("Acquire (second) err = %v, want ErrRunning", err)
	}
	if second != nil {
		t.Fatal("Acquire (second) returned a lock, want nil")
	}
	if _, err := os.Stat(socketPath(path)); err == nil {
		t.Errorf("a handover socket exists at %s, want none on Windows", socketPath(path))
	}
}
