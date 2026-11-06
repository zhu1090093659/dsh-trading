package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// scriptedLister hands out readings in order and repeats the last one, which is
// what drives the settle and drain loops without real processes.
func scriptedLister(readings ...[]process) lister {
	var index int
	return func() ([]process, error) {
		if index >= len(readings) {
			return readings[len(readings)-1], nil
		}
		reading := readings[index]
		index++
		return reading, nil
	}
}

// reading builds a process table entry that carries an identity a recycled pid
// would not.
func entry(pid, ppid int, exe string) process {
	return process{pid: pid, ppid: ppid, exe: exe, cmd: exe, start: "started-once"}
}

func TestTreeOfFollowsParentLinks(t *testing.T) {
	table := []process{
		entry(100, 1, "mygo"),
		entry(101, 100, "node"),
		entry(102, 101, "pnpm"),
		entry(200, 1, "elsewhere"),
		entry(300, 0, "orphan"),
	}
	tree := treeOf(table, 100)
	want := []int{100, 101, 102}
	if len(tree) != len(want) {
		t.Fatalf("tree = %v, want the three processes of the shell", tree)
	}
	for i, pid := range want {
		if tree[i].pid != pid {
			t.Fatalf("tree[%d].pid = %d, want %d (tree %v)", i, tree[i].pid, pid, tree)
		}
	}
	if tree := treeOf(table, 999); len(tree) != 0 {
		t.Fatalf("tree of an absent root = %v, want none", tree)
	}
}

func TestTreeOfDoesNotLoopOnAParentCycle(t *testing.T) {
	table := []process{entry(400, 401, "a"), entry(401, 400, "b")}
	// A table that cannot happen is still a table the walk must survive: the
	// search is bounded by the table's size.
	tree := treeOf(table, 400)
	if len(tree) > len(table) {
		t.Fatalf("tree = %v, want at most the table's %d processes", tree, len(table))
	}
}

func TestSettleTreeWaitsForTheMembershipToStopChanging(t *testing.T) {
	readings := [][]process{
		{entry(500, 1, "mygo")},
		{entry(500, 1, "mygo"), entry(501, 500, "node")},
		{entry(500, 1, "mygo"), entry(501, 500, "node")},
	}
	settled, tracked, ok, err := settleTree(scriptedLister(readings...), 500, 40*time.Millisecond, 5*time.Second)
	if err != nil {
		t.Fatalf("settleTree err = %v, want nil", err)
	}
	if !ok {
		t.Fatal("settleTree did not settle on a tree that stopped changing")
	}
	if len(settled.processes) != 2 {
		t.Fatalf("settled tree = %v, want the shell and its host", settled.processes)
	}
	if settled.total != 2 {
		t.Errorf("total = %d, want the reading's %d processes", settled.total, 2)
	}
	if tracked.count() != 2 {
		t.Errorf("tracked = %d, want the shell and its host", tracked.count())
	}
}

func TestSettleTreeGivesUpAtTheDeadline(t *testing.T) {
	var pid int = 600
	growing := func() ([]process, error) {
		pid++
		return []process{entry(600, 1, "mygo"), entry(pid, 600, "spawned")}, nil
	}
	start := time.Now()
	settled, _, ok, err := settleTree(growing, 600, time.Millisecond, 100*time.Millisecond)
	if err != nil {
		t.Fatalf("settleTree err = %v, want nil", err)
	}
	if ok {
		t.Fatal("settleTree settled on a tree that kept growing")
	}
	if elapsed := time.Since(start); elapsed < 100*time.Millisecond {
		t.Errorf("settleTree returned after %s, want the deadline spent", elapsed)
	}
	if len(settled.processes) == 0 {
		t.Error("settleTree returned no reading at all")
	}
}

func TestSettleTreeStopsWhenTheShellIsGone(t *testing.T) {
	readings := [][]process{
		{entry(700, 1, "mygo")},
		{},
	}
	start := time.Now()
	_, tracked, ok, err := settleTree(scriptedLister(readings...), 700, time.Second, 30*time.Second)
	if err != nil {
		t.Fatalf("settleTree err = %v, want nil", err)
	}
	if ok {
		t.Fatal("settleTree settled on a shell that is gone")
	}
	if elapsed := time.Since(start); elapsed > 5*time.Second {
		t.Errorf("settleTree waited %s for a shell that is gone", elapsed)
	}
	if tracked.count() != 1 {
		t.Errorf("tracked = %d, want the shell the first reading saw", tracked.count())
	}
}

func TestResidueCatchesAReparentedMember(t *testing.T) {
	tracked := newTracker(800)
	tracked.add([]process{entry(800, 1, "mygo"), entry(801, 800, "node")})
	// The shell is gone and its child was reparented, which is exactly the case
	// a parent-link walk cannot see any more.
	final := snapshot{total: 3, processes: []process{
		entry(801, 1, "node"),
		entry(900, 1, "unrelated"),
	}}
	residual := tracked.residue(final)
	if len(residual) != 1 {
		t.Fatalf("residual = %v, want the one process that outlived the shell", residual)
	}
	if residual[0].PID != 801 || !residual[0].InTree || residual[0].Exe != "node" {
		t.Errorf("residual[0] = %+v, want pid 801 in the tree", residual[0])
	}
}

func TestResidueIgnoresARecycledPID(t *testing.T) {
	tracked := newTracker(810)
	tracked.add([]process{entry(810, 1, "mygo"), entry(811, 810, "node")})
	recycled := entry(811, 1, "node")
	recycled.start = "started-later"
	residual := tracked.residue(snapshot{total: 2, processes: []process{recycled}})
	if len(residual) != 0 {
		t.Fatalf("residual = %v, want a recycled pid to be no residue", residual)
	}
}

func TestSettleResidueReturnsAsSoonAsNothingIsLeft(t *testing.T) {
	tracked := newTracker(820)
	tracked.add([]process{entry(820, 1, "mygo"), entry(821, 820, "node")})
	readings := [][]process{
		{entry(821, 1, "node")},
		{},
	}
	start := time.Now()
	final, drained := settleResidue(scriptedLister(readings...), tracked, 30*time.Second, 10*time.Second)
	if !drained {
		t.Fatal("settleResidue = not drained for a tree that emptied")
	}
	if elapsed := time.Since(start); elapsed > 10*time.Second {
		t.Errorf("settleResidue waited %s for a tree that emptied at once", elapsed)
	}
	if len(tracked.residue(final)) != 0 {
		t.Errorf("residue = %v, want none", tracked.residue(final))
	}
}

// reportFor builds the evidence of one finished run.
func reportFor(running, after []process, exited bool) proctreeReport {
	tracked := newTracker(830)
	tracked.add(running)
	evidence := proctreeEvidence{
		command:   []string{"/opt/mygo"},
		startedAt: time.Now(),
		shellPID:  830,
		before:    snapshot{total: 1},
		running:   snapshot{total: len(running), processes: running},
		after:     snapshot{total: len(after), processes: after},
		tracked:   tracked,
		settled:   true,
		quit:      "wm-close",
		exited:    exited,
	}
	return evidence.report()
}

func TestReportCarriesTheTreeAndTheResidual(t *testing.T) {
	running := []process{entry(830, 1, "mygo"), entry(831, 830, "node")}
	after := []process{entry(831, 1, "node")}
	report := reportFor(running, after, true)

	if report.Mode != "proctree" {
		t.Errorf("mode = %q, want proctree", report.Mode)
	}
	if report.ShellPID != 830 || report.Tracked != 2 {
		t.Errorf("shellPid = %d tracked = %d, want 830 and 2", report.ShellPID, report.Tracked)
	}
	if len(report.Running.Processes) != 2 || !report.Running.Processes[0].InTree {
		t.Errorf("running processes = %+v, want the tree with inTree set", report.Running.Processes)
	}
	if len(report.Residual) != 1 || report.Residual[0].PID != 831 {
		t.Errorf("residual = %+v, want the surviving child", report.Residual)
	}
	if report.OK {
		t.Error("ok = true for a run whose tree outlived the shell")
	}
	blob, err := json.Marshal(report)
	if err != nil {
		t.Fatalf("encoding the report: %v", err)
	}
	for _, key := range []string{"pid", "ppid", "exe", "cmdline", "inTree", "shellPid", "residual", "ok"} {
		if !strings.Contains(string(blob), "\""+key+"\"") {
			t.Errorf("report has no %q field: %s", key, blob)
		}
	}
}

func TestReportFailsWhenTheShellHadToBeForced(t *testing.T) {
	running := []process{entry(840, 1, "mygo")}
	// A shell that ignored the quit request was killed by the drill, so its own
	// reclamation never ran: the run cannot pass even with nothing left behind.
	tracked := newTracker(840)
	tracked.add(running)
	evidence := proctreeEvidence{
		command:   []string{"/opt/mygo"},
		startedAt: time.Now(),
		shellPID:  840,
		running:   snapshot{total: 1, processes: running},
		tracked:   tracked,
		exited:    false,
		forced:    true,
	}
	if report := evidence.report(); report.OK {
		t.Error("ok = true for a shell that had to be killed")
	}
}

func TestReportPassesWhenNothingSurvivedTheShell(t *testing.T) {
	running := []process{entry(850, 1, "mygo"), entry(851, 850, "node")}
	if report := reportFor(running, nil, true); !report.OK {
		t.Fatalf("ok = false for a clean run: residual %+v", report.Residual)
	}
}

func TestWriteJSONCreatesTheReportDirectory(t *testing.T) {
	path := filepath.Join(t.TempDir(), "nested", "proctree.json")
	if err := writeJSON(path, reportFor(nil, nil, true)); err != nil {
		t.Fatalf("writeJSON err = %v", err)
	}
	blob, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("reading the report err = %v", err)
	}
	var decoded proctreeReport
	if err := json.Unmarshal(blob, &decoded); err != nil {
		t.Fatalf("the report is not JSON: %v", err)
	}
	if decoded.Mode != "proctree" {
		t.Errorf("mode = %q, want proctree", decoded.Mode)
	}
}

func TestDefaultShellKeepsTheGivenPath(t *testing.T) {
	got, err := defaultShell("/opt/dsh/mygo")
	if err != nil {
		t.Fatalf("defaultShell err = %v", err)
	}
	if got != "/opt/dsh/mygo" {
		t.Errorf("defaultShell = %q, want the given path", got)
	}
}

func TestReportFailsWhenTheTreeNeverAppeared(t *testing.T) {
	// A shell that died before starting a host proves nothing about reclaiming a
	// tree, so the vacuous run must not read as a pass.
	evidence := proctreeEvidence{
		command:   []string{"/opt/mygo"},
		startedAt: time.Now(),
		shellPID:  860,
		tracked:   newTracker(860),
		exited:    true,
		settled:   false,
	}
	report := evidence.report()
	if report.OK {
		t.Fatal("ok = true for a run that never saw the shell's tree")
	}
	if report.Reason == "" {
		t.Error("reason is empty, want why the run proved nothing")
	}
}

func TestReportNamesTheResidueAsTheReason(t *testing.T) {
	running := []process{entry(870, 1, "mygo"), entry(871, 870, "node")}
	report := reportFor(running, []process{entry(871, 1, "node")}, true)
	if report.OK {
		t.Fatal("ok = true for a tree that outlived the shell")
	}
	if !strings.Contains(report.Reason, "outlived") {
		t.Errorf("reason = %q, want the surviving processes named", report.Reason)
	}
}
