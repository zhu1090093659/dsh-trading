//go:build linux

package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

// startFixture runs script as a real shell in its own process group; the cleanup
// ends the whole group, so a failing test leaves nothing behind.
func startFixture(t *testing.T, script string) *exec.Cmd {
	t.Helper()
	cmd := exec.Command("/bin/sh", "-c", script)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := cmd.Start(); err != nil {
		t.Fatalf("starting the fixture: %v", err)
	}
	t.Cleanup(func() {
		_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		_ = cmd.Wait()
	})
	return cmd
}

// waitFor polls condition until it holds or the deadline passes.
func waitFor(deadline time.Time, condition func() bool) bool {
	for {
		if condition() {
			return true
		}
		if !time.Now().Before(deadline) {
			return false
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestListProcessesReadsTheProcTable(t *testing.T) {
	processes, err := listProcesses()
	if err != nil {
		t.Fatalf("listProcesses err = %v", err)
	}
	var self *process
	for i := range processes {
		if processes[i].pid == os.Getpid() {
			self = &processes[i]
		}
	}
	if self == nil {
		t.Fatalf("the process table holds no entry for this process (%d)", os.Getpid())
	}
	if self.ppid != os.Getppid() {
		t.Errorf("ppid = %d, want %d", self.ppid, os.Getppid())
	}
	if self.start == "" {
		t.Error("start time is empty, want the identity half a recycled pid loses")
	}
	if !strings.Contains(self.cmd, filepath.Base(os.Args[0])) {
		t.Errorf("cmdline = %q, want this test binary", self.cmd)
	}
}

func TestTreeOfFindsTheChildrenOfARealShell(t *testing.T) {
	cmd := startFixture(t, "sleep 30 & sleep 30")

	var tree []process
	deadline := time.Now().Add(10 * time.Second)
	if !waitFor(deadline, func() bool {
		processes, err := listProcesses()
		if err != nil {
			return false
		}
		tree = treeOf(processes, cmd.Process.Pid)
		return len(tree) >= 2
	}) {
		t.Fatalf("tree of the fixture = %v, want the shell and at least one sleep", tree)
	}
	sleeps := 0
	for _, p := range tree {
		if p.exe == "sleep" {
			sleeps++
			if !strings.Contains(p.cmd, "sleep 30") {
				t.Errorf("sleep cmdline = %q, want the sleep's own command line", p.cmd)
			}
		}
	}
	if sleeps == 0 {
		t.Fatalf("tree = %v, want the sleeps the fixture spawned", tree)
	}
	if tree := treeOf(tree, 0); len(tree) != 0 {
		t.Errorf("tree of pid 0 = %v, want none", tree)
	}
}

func TestFindProcessesByCommandLineFindsARunningProcess(t *testing.T) {
	startFixture(t, "sleep 37.5")
	marker := "sleep 37.5"
	var pids []int
	deadline := time.Now().Add(10 * time.Second)
	if !waitFor(deadline, func() bool {
		found, err := findProcessesByCommandLine(marker)
		if err != nil {
			return false
		}
		pids = found
		return len(pids) > 0
	}) {
		t.Fatalf("findProcessesByCommandLine(%q) = %v, want the fixture", marker, pids)
	}
	if _, err := findProcessesByCommandLine("no-process-runs-this-command-line"); err != nil {
		t.Fatalf("findProcessesByCommandLine err = %v", err)
	}
}

func TestResidualIsWhatOutlivedItsRoot(t *testing.T) {
	// The shell lives just long enough to be seen with its child, then exits on
	// its own while the child keeps running: the child is reparented, so only a
	// tracked identity can still find it.
	cmd := startFixture(t, "sleep 30 & sleep 1")
	tracked := newTracker(cmd.Process.Pid)
	deadline := time.Now().Add(10 * time.Second)
	if !waitFor(deadline, func() bool {
		processes, err := listProcesses()
		if err != nil {
			return false
		}
		tracked.add(treeOf(processes, cmd.Process.Pid))
		return tracked.count() >= 2
	}) {
		t.Fatalf("tracked = %d, want the shell and its child", tracked.count())
	}
	_ = cmd.Wait()
	final, drained := settleResidue(listProcesses, tracked, 50*time.Millisecond, 5*time.Second)
	if !drained {
		t.Fatal("settleResidue = not drained while the child was still there")
	}
	residual := tracked.residue(final)
	if len(residual) == 0 {
		t.Fatal("residual = none, want the child that outlived the shell")
	}
	for _, record := range residual {
		if !record.InTree {
			t.Errorf("residual %+v is not marked as part of the tree", record)
		}
	}
}

// goodShell kills its child when it is asked to quit, the behaviour the shell
// this drill observes is supposed to have.
const goodShell = `trap 'kill "$child" 2>/dev/null; exit 0' TERM
sleep 30 &
child=$!
wait "$child"
`

// badShell exits on the quit request and leaves its child behind.
const badShell = `trap 'exit 0' TERM
sleep 30 &
wait
`

// optionsFor settles and drains quickly: the fixture is not a real GUI shell.
func optionsFor(t *testing.T) proctreeOptions {
	t.Helper()
	return proctreeOptions{
		out:     t.TempDir(),
		settle:  100 * time.Millisecond,
		appear:  10 * time.Second,
		grace:   10 * time.Second,
		residue: 5 * time.Second,
	}
}

// logFile is where the fixture's own output goes: a real file, so exec hands the
// child the descriptor instead of copying through a pipe.
func logFile(t *testing.T) *os.File {
	t.Helper()
	file, err := os.Create(filepath.Join(t.TempDir(), "fixture.log"))
	if err != nil {
		t.Fatalf("creating the fixture log: %v", err)
	}
	t.Cleanup(func() { _ = file.Close() })
	return file
}

func TestObserveTreePassesForAShellThatTakesItsChildWithIt(t *testing.T) {
	evidence, err := observeTree([]string{"/bin/sh", "-c", goodShell}, optionsFor(t), logFile(t))
	if err != nil {
		t.Fatalf("observeTree err = %v", err)
	}
	report := evidence.report()
	if !report.Settled {
		t.Error("treeSettled = false, want the tree settled before the quit request")
	}
	if report.Quit != "sigterm" {
		t.Errorf("quitRequest = %q, want sigterm", report.Quit)
	}
	if !report.Exited || report.Forced {
		t.Errorf("exitedOnRequest = %v forced = %v, want true and false", report.Exited, report.Forced)
	}
	if len(report.Running.Processes) < 2 {
		t.Errorf("running tree = %+v, want the shell and its child", report.Running.Processes)
	}
	if len(report.Residual) != 0 {
		t.Errorf("residual = %+v, want none", report.Residual)
	}
	if !report.OK {
		t.Error("ok = false for a shell that took its child with it")
	}
}

func TestObserveTreeFailsForAShellThatLeavesItsChildBehind(t *testing.T) {
	evidence, err := observeTree([]string{"/bin/sh", "-c", badShell}, optionsFor(t), logFile(t))
	if err != nil {
		t.Fatalf("observeTree err = %v", err)
	}
	report := evidence.report()
	if !report.Exited || report.Forced {
		t.Errorf("exitedOnRequest = %v forced = %v, want true and false", report.Exited, report.Forced)
	}
	if len(report.Residual) == 0 {
		t.Fatal("residual = none, want the sleep the shell left behind")
	}
	if report.OK {
		t.Error("ok = true for a run whose tree outlived the shell")
	}
	// The evidence run leaves the survivor alone on purpose, so the test ends it.
	for _, record := range report.Residual {
		_ = syscall.Kill(record.PID, syscall.SIGKILL)
	}
}
