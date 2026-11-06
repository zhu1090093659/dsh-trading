package hostwait

import (
	"strings"
	"testing"
	"time"
)

// exitChannel returns a channel that is never closed, for a host that is alive.
func exitChannel() <-chan struct{} { return make(chan struct{}) }

func TestWaitReturnsTheURLTheHostPrinted(t *testing.T) {
	var waiter URLWaiter
	waiter.Observe("dsh profile: trading-web")
	waiter.Observe("dsh web: http://127.0.0.1:50929/?token=abc123")
	got, err := waiter.Wait(exitChannel(), time.Second)
	if err != nil {
		t.Fatalf("Wait err = %v, want nil", err)
	}
	if want := "http://127.0.0.1:50929/?token=abc123"; got != want {
		t.Errorf("Wait = %q, want %q", got, want)
	}
}

func TestWaitTakesTheNewestLine(t *testing.T) {
	var waiter URLWaiter
	waiter.Observe("dsh web: http://127.0.0.1:1/?token=one")
	waiter.Observe("dsh web: http://127.0.0.1:2/?token=two")
	if got, _ := waiter.Wait(exitChannel(), time.Second); !strings.Contains(got, ":2/") {
		t.Errorf("Wait = %q, want the newest line's URL", got)
	}
}

// TestResetForgetsTheDeadHostsURL is the 2026-10-15 incident: a recovery that
// read the previous host's URL loaded a port nobody served.
func TestResetForgetsTheDeadHostsURL(t *testing.T) {
	var waiter URLWaiter
	waiter.Observe("dsh web: http://127.0.0.1:50833/?token=dead")
	waiter.Reset()
	if got := waiter.URL(); got != "" {
		t.Fatalf("URL after Reset = %q, want empty", got)
	}
	// The new host has not printed anything yet, so Wait must not answer at
	// once, and must answer with the new host's URL as soon as it does.
	type result struct {
		url string
		err error
	}
	done := make(chan result, 1)
	go func() {
		url, err := waiter.Wait(exitChannel(), 5*time.Second)
		done <- result{url: url, err: err}
	}()
	select {
	case got := <-done:
		t.Fatalf("Wait answered %+v before the new host printed anything", got)
	case <-time.After(200 * time.Millisecond):
	}
	waiter.Observe("dsh web: http://127.0.0.1:51089/?token=fresh")
	select {
	case got := <-done:
		if got.err != nil {
			t.Fatalf("Wait err = %v, want nil", got.err)
		}
		if want := "http://127.0.0.1:51089/?token=fresh"; got.url != want {
			t.Errorf("Wait = %q, want %q", got.url, want)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Wait never took the new host's URL")
	}
}

func TestWaitReportsAHostThatExited(t *testing.T) {
	var waiter URLWaiter
	exited := make(chan struct{})
	close(exited)
	if _, err := waiter.Wait(exited, time.Second); err == nil {
		t.Fatal("Wait err = nil, want the host exit reported")
	}
}

func TestWaitTimesOut(t *testing.T) {
	var waiter URLWaiter
	start := time.Now()
	_, err := waiter.Wait(exitChannel(), 150*time.Millisecond)
	if err == nil {
		t.Fatal("Wait err = nil, want a timeout")
	}
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Errorf("Wait took %s, want about the timeout", elapsed)
	}
}

func TestObservationOfJunkChangesNothing(t *testing.T) {
	var waiter URLWaiter
	waiter.Observe("dsh web: opening the default browser")
	waiter.Observe("")
	if got := waiter.URL(); got != "" {
		t.Errorf("URL = %q, want empty", got)
	}
}
