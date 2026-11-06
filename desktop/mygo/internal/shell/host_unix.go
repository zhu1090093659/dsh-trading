//go:build !windows

package shell

import (
	"errors"
	"os"
	"os/exec"
	"syscall"
	"time"
)

// processGroup is the unix tree handle: the host is started as its own process
// group leader, so one signal to -pgid reaches everything it spawned and the
// kernel keeps the group together after the leader dies.
type processGroup struct {
	pid int
}

// newHostTree returns the unix handle; the group is created by the spawn itself
// (configureHostCommand), so there is nothing to open here.
func newHostTree() (hostTree, error) { return &processGroup{}, nil }

// configureHostCommand puts the host in its own process group.
func configureHostCommand(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

// bind records the group's id, which is the host's pid.
func (g *processGroup) bind(process *os.Process) error {
	if process == nil {
		return errors.New("host process group: no process to bind")
	}
	g.pid = process.Pid
	return nil
}

// terminate asks the whole group to shut down; the profile's shutdown handler
// turns SIGTERM into a graceful exit.
func (g *processGroup) terminate() {
	if g.pid == 0 {
		return
	}
	_ = syscall.Kill(-g.pid, syscall.SIGTERM)
}

// kill ends the whole group.
func (g *processGroup) kill() {
	if g.pid == 0 {
		return
	}
	_ = syscall.Kill(-g.pid, syscall.SIGKILL)
}

// gone reports whether the group is empty: signal 0 is delivered to nobody once
// the last member is gone (ESRCH).
func (g *processGroup) gone() bool {
	if g.pid == 0 {
		return true
	}
	return errors.Is(syscall.Kill(-g.pid, 0), syscall.ESRCH)
}

// close is a no-op: the group is the kernel's, not a handle this shell holds.
func (g *processGroup) close() {}

// awaitEnd waits for the host process to be reaped, the unix measure of a
// shutdown: the group dies with it (SIGKILL to -pgid), and groupGone() reports
// the tree separately.
func (h *hostProcess) awaitEnd(limit time.Duration) bool {
	return h.awaitExit(limit)
}

// exitedOnSignal names the signal the host ended on, or "" when it exited on
// its own.
func exitedOnSignal(state *os.ProcessState) string {
	if status, ok := state.Sys().(syscall.WaitStatus); ok && status.Signaled() {
		return status.Signal().String()
	}
	return ""
}
