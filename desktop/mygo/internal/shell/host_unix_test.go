//go:build !windows

package shell

import (
	"os/exec"
	"testing"
	"time"
)

// startTree starts a real host with three background children in its own
// process group, the shape of a dsh host that spawned plugin work: the children
// only die when the whole group is signalled.
func startTree(t *testing.T) (*exec.Cmd, *processGroup) {
	t.Helper()
	cmd := exec.Command("/bin/sh", "-c", "sleep 30 & sleep 30 & sleep 30")
	configureHostCommand(cmd)
	if err := cmd.Start(); err != nil {
		t.Fatalf("starting the host fixture: %v", err)
	}
	group := &processGroup{}
	if err := group.bind(cmd.Process); err != nil {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		t.Fatalf("binding the host fixture: %v", err)
	}
	return cmd, group
}

func TestProcessGroupOwnsTheChildrenTheHostSpawned(t *testing.T) {
	cmd, group := startTree(t)

	if group.gone() {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		t.Fatal("the group is empty while the host and its three children run")
	}
	group.kill()
	// The leader is reaped by hand before the group is judged: a zombie leader
	// is still a member, and this test is about the children, not about a child
	// this process forgot to wait for.
	_ = cmd.Wait()
	if !awaitCondition(time.Now().Add(10*time.Second), group.gone) {
		t.Fatal("a process of the host's group outlived SIGKILL to the group")
	}
}

func TestStopReapsTheWholeGroupOfARealHost(t *testing.T) {
	cmd, group := startTree(t)
	host := &hostProcess{cmd: cmd, tree: group, exited: make(chan struct{}), startedAt: time.Now()}
	go func() {
		_ = cmd.Wait()
		close(host.exited)
	}()

	if exit := host.stop(50*time.Millisecond, 10*time.Second); exit != "reaped" {
		t.Fatalf("stop = %q, want %q", exit, "reaped")
	}
	// stop() returns on the host's own exit; the group is judged separately (it
	// is what says nothing a plugin spawned outlived the shutdown), so the wait
	// for the signal to land is bounded rather than assumed.
	if !awaitCondition(time.Now().Add(10*time.Second), host.groupGone) {
		t.Fatal("a process of the host's group outlived stop")
	}
}
