package shell

import (
	"os"
	"sync"
	"testing"
	"time"
)

// fakeTree is a hostTree with no process behind it: it records what the shell
// asked of the tree and answers gone() from the test's script, which is what
// makes the shutdown policy testable without a job object or a process group.
type fakeTree struct {
	mu     sync.Mutex
	calls  []string
	empty  bool
	closed bool
	onKill func()
}

func (f *fakeTree) bind(*os.Process) error { return nil }

func (f *fakeTree) terminate() { f.record("terminate") }

func (f *fakeTree) kill() {
	f.record("kill")
	if f.onKill != nil {
		f.onKill()
	}
}

func (f *fakeTree) gone() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.empty
}

func (f *fakeTree) close() {
	f.record("close")
	f.mu.Lock()
	f.closed = true
	f.mu.Unlock()
}

func (f *fakeTree) record(name string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, name)
}

// recorded is what the tree was asked to do, in order.
func (f *fakeTree) recorded() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.calls...)
}

// setEmpty makes gone() answer with no process left.
func (f *fakeTree) setEmpty(empty bool) {
	f.mu.Lock()
	f.empty = empty
	f.mu.Unlock()
}

// wasClosed reports whether the handle was released.
func (f *fakeTree) wasClosed() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.closed
}

// stoppedHost is a host the test drives: no process, a tree it scripts, and an
// exited channel only the test closes.
func stoppedHost(tree hostTree) (*hostProcess, chan struct{}) {
	exited := make(chan struct{})
	return &hostProcess{exited: exited, tree: tree, startedAt: time.Now()}, exited
}

// expectCalls compares the tree's call log with want.
func expectCalls(t *testing.T, tree *fakeTree, want ...string) {
	t.Helper()
	got := tree.recorded()
	if len(got) != len(want) {
		t.Fatalf("tree calls = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("tree calls = %v, want %v", got, want)
		}
	}
}

func TestStopLeavesAnAlreadyExitedHostAloneButReleasesItsTree(t *testing.T) {
	tree := &fakeTree{empty: true}
	host, exited := stoppedHost(tree)
	close(exited) // the host died before the shell asked it to

	if exit := host.stop(10*time.Millisecond, 10*time.Millisecond); exit != "already exited" {
		t.Fatalf("stop = %q, want %q", exit, "already exited")
	}
	// No signal to a host that is gone, but the handle is still released: that
	// release is what ends a plugin child that outlived the host.
	expectCalls(t, tree, "close")
	if !tree.wasClosed() {
		t.Fatal("the tree handle was not released")
	}
	if host.expected.Load() {
		t.Error("expected flag = true, want the shell not to claim a stop it never asked for")
	}
}

func TestStopAsksTheTreeBeforeItKillsIt(t *testing.T) {
	tree := &fakeTree{}
	host, exited := stoppedHost(tree)
	// The tree only goes once it is killed, which is what the escalation exists
	// for: the graceful ask was ignored.
	// The kill is what empties the tree (on Windows that is the job object the
	// reaper waits on), so the escalation is the step that ends in "reaped".
	tree.onKill = func() { tree.setEmpty(true); close(exited) }

	if exit := host.stop(20*time.Millisecond, 5*time.Second); exit != "reaped" {
		t.Fatalf("stop = %q, want %q", exit, "reaped")
	}
	expectCalls(t, tree, "terminate", "kill", "close")
	if !host.expected.Load() {
		t.Error("expected flag = false, want the stop recorded as the shell's own")
	}
}

func TestStopReportsNotReapedWhenTheTreeNeverGoes(t *testing.T) {
	tree := &fakeTree{}
	host, _ := stoppedHost(tree)

	start := time.Now()
	if exit := host.stop(20*time.Millisecond, 40*time.Millisecond); exit != "not reaped" {
		t.Fatalf("stop = %q, want %q", exit, "not reaped")
	}
	// Both waits were spent before giving up, so the failure is a real verdict
	// and not an early return.
	if elapsed := time.Since(start); elapsed < 60*time.Millisecond {
		t.Errorf("stop gave up after %s, want the grace and the kill wait spent", elapsed)
	}
	expectCalls(t, tree, "terminate", "kill", "close")
}

func TestAwaitTreeNeedsBothTheHostAndItsTreeGone(t *testing.T) {
	tree := &fakeTree{empty: true}
	host, exited := stoppedHost(tree)

	// The host is still running: an empty tree is not the end of the host.
	if host.awaitTree(time.Now().Add(20 * time.Millisecond)) {
		t.Fatal("awaitTree = true while the host still runs")
	}
	close(exited)
	tree.setEmpty(false)
	// The host is gone but a child is left: that is exactly the residue the
	// job object exists to catch, so it is not the end either.
	if host.awaitTree(time.Now().Add(20 * time.Millisecond)) {
		t.Fatal("awaitTree = true while the tree still holds a process")
	}
	// The wait polls rather than samples once: a child that leaves after the
	// caller started waiting still ends the wait.
	done := make(chan bool, 1)
	go func() { done <- host.awaitTree(time.Now().Add(5 * time.Second)) }()
	time.Sleep(pollInterval)
	tree.setEmpty(true)
	if !<-done {
		t.Fatal("awaitTree = false after the tree emptied")
	}
}

func TestAwaitConditionPollsUntilTheDeadline(t *testing.T) {
	if !awaitCondition(time.Now().Add(time.Second), func() bool { return true }) {
		t.Fatal("awaitCondition = false for a condition that already holds")
	}
	polls := 0
	if awaitCondition(time.Now().Add(40*time.Millisecond), func() bool { polls++; return false }) {
		t.Fatal("awaitCondition = true for a condition that never holds")
	}
	if polls < 2 {
		t.Errorf("condition was read %d times, want it polled until the deadline", polls)
	}
}
