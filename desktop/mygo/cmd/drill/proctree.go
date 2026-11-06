package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"time"
)

// pollInterval is how often a process table is re-read while a tree settles or
// drains. It is a poll floor, never the only wait: every loop below also carries
// a deadline, so nothing here can hang on a tree that keeps changing.
const pollInterval = 50 * time.Millisecond

// residueQuiet is how long the survivors of a stopped tree must stay unchanged
// before one of them is called residue: a child on its way out is not.
const residueQuiet = 300 * time.Millisecond

// reapWait bounds the wait for a force-killed shell to be reaped.
const reapWait = 10 * time.Second

// proctreeUsage is the proctree command's own help. The owner runs it as one
// command on a machine with a GUI session and reads the JSON it writes.
const proctreeUsage = `proctree: evidence that the shell takes its whole process tree with it

  mygo-drill proctree [flags] [-- command args...]

Starts the shell, snapshots the tree it spawns, asks it to quit the way a click
on its window's close button does, then snapshots again and reports which
processes of that tree outlived it. The report is JSON, and every process in it
carries pid, ppid, executable name, command line and whether it belongs to this
shell's tree.

Without a command after --, the shell beside this drill is observed (mygo.exe on
Windows, mygo on the unices). Exit code 0 means the shell exited when asked and
no process of its tree survived it.

The report file is the artifact: a GUI binary run from a console gets no console
back on Windows, so read the JSON, or start the run with cmd /c start /wait to
get the exit code as well.

Flags:
`

// process is one entry of a process table reading.
type process struct {
	pid  int
	ppid int
	// exe is the executable's file name.
	exe string
	// cmd is the full command line, empty when the platform refused the read.
	cmd string
	// start is the process's start time: the half of a process's identity that a
	// recycled pid loses.
	start string
}

// identity names one process beyond its pid.
func (p process) identity() string { return strconv.Itoa(p.pid) + "@" + p.start }

// procRecord is how one process is written to the report.
type procRecord struct {
	PID     int    `json:"pid"`
	PPID    int    `json:"ppid"`
	Exe     string `json:"exe"`
	Cmdline string `json:"cmdline"`
	InTree  bool   `json:"inTree"`
}

// record renders one process for the report.
func (p process) record(inTree bool) procRecord {
	return procRecord{PID: p.pid, PPID: p.ppid, Exe: p.exe, Cmdline: p.cmd, InTree: inTree}
}

// snapshot is one reading of the machine's process table.
type snapshot struct {
	at time.Time
	// total is how many processes the read saw, which is what the report says
	// about the machine beyond the tree.
	total int
	// processes are the entries this reading kept for the report.
	processes []process
}

// lister reads the machine's process table; the indirection is what lets the
// settle and drain loops be tested against scripted readings.
type lister func() ([]process, error)

// treeOf returns the processes whose parent chain reaches root, root included.
func treeOf(processes []process, root int) []process {
	byPID := make(map[int]process, len(processes))
	for _, p := range processes {
		byPID[p.pid] = p
	}
	tree := make([]process, 0, len(processes))
	for _, p := range processes {
		if descends(byPID, p.pid, root) {
			tree = append(tree, p)
		}
	}
	sort.Slice(tree, func(i, j int) bool { return tree[i].pid < tree[j].pid })
	return tree
}

// descends reports whether pid is root or descends from it. The walk is bounded
// by the table's size because a parent link that cycles must not hang the read.
func descends(byPID map[int]process, pid, root int) bool {
	for steps := 0; steps <= len(byPID); steps++ {
		if pid == root {
			return true
		}
		parent, ok := byPID[pid]
		if !ok || parent.ppid == pid || parent.ppid == 0 {
			return false
		}
		pid = parent.ppid
	}
	return false
}

// treeSignature is a tree's membership as one comparable string: two readings
// with the same signature hold the same processes.
func treeSignature(tree []process) string {
	identities := make([]string, 0, len(tree))
	for _, p := range tree {
		identities = append(identities, p.identity())
	}
	sort.Strings(identities)
	return strings.Join(identities, ",")
}

// tracker remembers every process seen inside the shell's tree. It is what makes
// the residue judgeable after the shell is gone: once the root dies its children
// are reparented, so walking parent links can no longer find them.
type tracker struct {
	root int
	seen map[string]process
}

// newTracker starts a tracker for the tree rooted at root.
func newTracker(root int) *tracker {
	return &tracker{root: root, seen: map[string]process{}}
}

// add records one reading of the tree.
func (t *tracker) add(tree []process) {
	for _, p := range tree {
		t.seen[p.identity()] = p
	}
}

// count is how many distinct processes the tree was seen to hold.
func (t *tracker) count() int { return len(t.seen) }

// survivors is the tracked membership a reading still finds, the shell itself
// excluded: it was reaped, and the question is about what it left behind.
func (t *tracker) survivors(processes []process) []process {
	var alive []process
	for _, p := range processes {
		if _, ok := t.seen[p.identity()]; ok && p.pid != t.root {
			alive = append(alive, p)
		}
	}
	sort.Slice(alive, func(i, j int) bool { return alive[i].pid < alive[j].pid })
	return alive
}

// residue is what is left of the tracked tree in the final reading.
func (t *tracker) residue(final snapshot) []procRecord {
	survivors := t.survivors(final.processes)
	records := make([]procRecord, 0, len(survivors))
	for _, p := range survivors {
		records = append(records, p.record(true))
	}
	return records
}

// settleTree reads the process table until the shell's tree stops changing for
// quiet, which is what says the shell has finished starting its host and nothing
// newer is appearing under it. It returns the reading that settled, the tracked
// membership, and whether it settled before limit.
func settleTree(list lister, root int, quiet, limit time.Duration) (snapshot, *tracker, bool, error) {
	tracked := newTracker(root)
	deadline := time.Now().Add(limit)
	var previous string
	var stableSince time.Time
	havePrevious := false
	for {
		processes, err := list()
		if err != nil {
			return snapshot{}, tracked, false, err
		}
		now := time.Now()
		tree := treeOf(processes, root)
		tracked.add(tree)
		reading := snapshot{at: now, total: len(processes), processes: tree}
		if len(tree) == 0 {
			// A shell that is already gone cannot grow a tree: there is nothing
			// left to settle.
			return reading, tracked, false, nil
		}
		signature := treeSignature(tree)
		switch {
		case !havePrevious || signature != previous:
			previous, stableSince, havePrevious = signature, now, true
		case now.Sub(stableSince) >= quiet && len(tree) > 1:
			return reading, tracked, true, nil
		}
		if !now.Before(deadline) {
			return reading, tracked, false, nil
		}
		time.Sleep(pollInterval)
	}
}

// settleResidue watches what is left of the tree after the shell is gone: it
// returns as soon as nothing tracked is alive, or once the survivors stop
// changing for quiet, so a child that is on its way out is not called residue.
func settleResidue(list lister, tracked *tracker, quiet, limit time.Duration) (snapshot, bool) {
	deadline := time.Now().Add(limit)
	var previous string
	var stableSince time.Time
	havePrevious := false
	for {
		processes, err := list()
		now := time.Now()
		if err != nil {
			return snapshot{at: now}, false
		}
		reading := snapshot{at: now, total: len(processes), processes: processes}
		survivors := tracked.survivors(processes)
		if len(survivors) == 0 {
			return reading, true
		}
		signature := treeSignature(survivors)
		switch {
		case !havePrevious || signature != previous:
			previous, stableSince, havePrevious = signature, now, true
		case now.Sub(stableSince) >= quiet:
			return reading, true
		}
		if !now.Before(deadline) {
			return reading, false
		}
		time.Sleep(pollInterval)
	}
}

// proctreeOptions are the flags of the proctree command.
type proctreeOptions struct {
	out     string
	report  string
	shell   string
	settle  time.Duration
	appear  time.Duration
	grace   time.Duration
	residue time.Duration
}

// runProctree is the owner's one-command evidence run. It never starts a GUI of
// its own: it observes the shell, which does.
func runProctree(args []string, stderr io.Writer) int {
	opts := proctreeOptions{}
	flags := flag.NewFlagSet("proctree", flag.ContinueOnError)
	flags.SetOutput(stderr)
	flags.StringVar(&opts.out, "out", defaultEnv("DRILL_OUT", "."), "directory the report lands in")
	flags.StringVar(&opts.report, "report", "", "report file (default <out>/proctree-<drill pid>.json)")
	flags.StringVar(&opts.shell, "shell", "", "shell executable to observe (default: the mygo shell beside this drill)")
	flags.DurationVar(&opts.settle, "settle", 1500*time.Millisecond, "the tree counts as settled once its membership stops changing for this long")
	flags.DurationVar(&opts.appear, "appear", 60*time.Second, "how long the tree may take to settle")
	flags.DurationVar(&opts.grace, "grace", 30*time.Second, "how long the shell gets after the quit request")
	flags.DurationVar(&opts.residue, "residue", 5*time.Second, "how long the tree gets to drain after the shell exits")
	flags.Usage = func() {
		fmt.Fprint(stderr, proctreeUsage)
		flags.PrintDefaults()
	}
	if err := flags.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return 0
		}
		return 2
	}
	command := flags.Args()
	if len(command) == 0 {
		shell, err := defaultShell(opts.shell)
		if err != nil {
			fmt.Fprintf(stderr, "proctree: %v\n", err)
			return 2
		}
		command = []string{shell}
	}
	evidence, err := observeTree(command, opts, stderr)
	if err != nil {
		fmt.Fprintf(stderr, "proctree: %v\n", err)
		return 2
	}
	report := evidence.report()
	path := opts.report
	if path == "" {
		path = filepath.Join(opts.out, fmt.Sprintf("proctree-%d.json", os.Getpid()))
	}
	if err := writeJSON(path, report); err != nil {
		fmt.Fprintf(stderr, "proctree: writing %s: %v\n", path, err)
		return 2
	}
	fmt.Fprintf(stderr, "proctree: %s shellPid=%d exitedOnRequest=%v forced=%v tracked=%d residual=%d report=%s\n",
		verdict(report.OK), report.ShellPID, report.Exited, report.Forced, report.Tracked, len(report.Residual), path)
	if report.Reason != "" {
		fmt.Fprintf(stderr, "proctree: %s\n", report.Reason)
	}
	if report.OK {
		return 0
	}
	return 1
}

// proctreeEvidence is what one run observed, before it is written out.
type proctreeEvidence struct {
	command   []string
	startedAt time.Time
	shellPID  int
	before    snapshot
	running   snapshot
	after     snapshot
	tracked   *tracker
	settled   bool
	quit      string
	exited    bool
	forced    bool
	exitCode  *int
}

// observeTree runs the shell, watches its tree, asks it to quit and judges what
// is left. Every path that gives up still ends the shell it started, so a failed
// evidence run never leaves the observed thing behind.
func observeTree(command []string, opts proctreeOptions, stderr io.Writer) (proctreeEvidence, error) {
	evidence := proctreeEvidence{command: command, startedAt: time.Now()}
	before, err := listProcesses()
	if err != nil {
		return evidence, fmt.Errorf("reading the process table before the shell starts: %w", err)
	}
	evidence.before = snapshot{at: time.Now(), total: len(before), processes: matching(before, command[0])}

	shell := exec.Command(command[0], command[1:]...)
	shell.Stdout = stderr
	shell.Stderr = stderr
	// WaitDelay bounds the wait for the child's output once the child itself is
	// gone. Without it a process the shell spawned and left behind holds the log
	// pipe open, exec.Cmd.Wait would block on it for that process's lifetime, and
	// the evidence run would report a shell that never exited.
	shell.WaitDelay = 3 * time.Second
	if err := shell.Start(); err != nil {
		return evidence, fmt.Errorf("starting %s: %w", strings.Join(command, " "), err)
	}
	evidence.shellPID = shell.Process.Pid
	waited := make(chan error, 1)
	go func() { waited <- shell.Wait() }()

	evidence.running, evidence.tracked, evidence.settled, err = settleTree(listProcesses, evidence.shellPID, opts.settle, opts.appear)
	if err != nil {
		_ = killProcess(evidence.shellPID)
		<-waited
		return evidence, fmt.Errorf("reading the shell's tree: %w", err)
	}

	quit, err := requestQuit(evidence.shellPID)
	if err != nil {
		fmt.Fprintf(stderr, "proctree: the shell (pid %d) was not asked to quit: %v\n", evidence.shellPID, err)
	} else {
		evidence.quit = quit
	}

	select {
	case waitErr := <-waited:
		evidence.exited = true
		evidence.exitCode = exitCode(waitErr)
	case <-time.After(opts.grace):
	}
	if !evidence.exited {
		evidence.forced = true
		fmt.Fprintf(stderr, "proctree: the shell did not exit within %s; ending pid %d\n", opts.grace, evidence.shellPID)
		_ = killProcess(evidence.shellPID)
		select {
		case waitErr := <-waited:
			evidence.exitCode = exitCode(waitErr)
		case <-time.After(reapWait):
			fmt.Fprintf(stderr, "proctree: pid %d was not reaped within %s\n", evidence.shellPID, reapWait)
		}
	}

	evidence.after, _ = settleResidue(listProcesses, evidence.tracked, residueQuiet, opts.residue)
	return evidence, nil
}

// proctreePhase is one snapshot in the report.
type proctreePhase struct {
	TakenAt   string       `json:"takenAt"`
	Total     int          `json:"totalProcesses"`
	Processes []procRecord `json:"processes"`
}

// proctreeReport is the evidence one proctree run writes.
type proctreeReport struct {
	Mode       string        `json:"mode"`
	StartedAt  string        `json:"startedAt"`
	FinishedAt string        `json:"finishedAt"`
	Command    []string      `json:"command"`
	ShellPID   int           `json:"shellPid"`
	Quit       string        `json:"quitRequest,omitempty"`
	Settled    bool          `json:"treeSettled"`
	Exited     bool          `json:"exitedOnRequest"`
	Forced     bool          `json:"forced"`
	ExitCode   *int          `json:"exitCode"`
	Tracked    int           `json:"trackedProcesses"`
	Residual   []procRecord  `json:"residual"`
	Before     proctreePhase `json:"before"`
	Running    proctreePhase `json:"running"`
	After      proctreePhase `json:"after"`
	OK         bool          `json:"ok"`
	// Reason says why a run failed, in the words the owner needs to act on: a
	// bare ok:false is not evidence of anything.
	Reason string `json:"reason,omitempty"`
}

// report turns one run's observations into the evidence document. ok is the
// verdict the exit code carries: the shell left because it was asked to, and
// nothing of its tree outlived it.
func (e proctreeEvidence) report() proctreeReport {
	if e.tracked == nil {
		e.tracked = newTracker(e.shellPID)
	}
	residual := e.tracked.residue(e.after)
	out := proctreeReport{
		Mode:       "proctree",
		StartedAt:  e.startedAt.UTC().Format(time.RFC3339Nano),
		FinishedAt: time.Now().UTC().Format(time.RFC3339Nano),
		Command:    e.command,
		ShellPID:   e.shellPID,
		Quit:       e.quit,
		Settled:    e.settled,
		Exited:     e.exited,
		Forced:     e.forced,
		ExitCode:   e.exitCode,
		Tracked:    e.tracked.count(),
		Residual:   residual,
		Before:     candidatePhase(e.before),
		Running:    treePhase(e.running),
		After:      residuePhase(e.after, residual),
	}
	out.Reason = verdictReasons(&out)
	out.OK = out.Reason == ""
	return out
}

// verdictReasons fills the reason a run failed, most fundamental first: a shell
// that never left, or one that had to be killed, or one whose tree was never
// seen, is not evidence about what that tree does when the shell exits.
func verdictReasons(out *proctreeReport) string {
	switch {
	case !out.Exited:
		return "the shell did not exit when it was asked to"
	case out.Forced:
		return "the shell ignored the quit request and was killed, so its own shutdown never ran"
	case !out.Settled:
		return "the shell's tree never settled, so there was nothing to measure"
	case out.Tracked <= 1:
		return "the shell started no process tree, so nothing proves the tree is reclaimed"
	case len(out.Residual) > 0:
		return "processes of the shell's tree outlived it"
	}
	return ""
}

// treePhase renders a reading of the tree itself.
func treePhase(reading snapshot) proctreePhase {
	records := make([]procRecord, 0, len(reading.processes))
	for _, p := range reading.processes {
		records = append(records, p.record(true))
	}
	return proctreePhase{TakenAt: stamp(reading.at), Total: reading.total, Processes: records}
}

// candidatePhase renders the processes already running the executable the run is
// about to start: what a second instance would collide with.
func candidatePhase(reading snapshot) proctreePhase {
	records := make([]procRecord, 0, len(reading.processes))
	for _, p := range reading.processes {
		records = append(records, p.record(false))
	}
	return proctreePhase{TakenAt: stamp(reading.at), Total: reading.total, Processes: records}
}

// residuePhase renders what was left of the tree.
func residuePhase(reading snapshot, residual []procRecord) proctreePhase {
	return proctreePhase{TakenAt: stamp(reading.at), Total: reading.total, Processes: residual}
}

// stamp is one timestamp in the report's fixed form.
func stamp(at time.Time) string { return at.UTC().Format(time.RFC3339Nano) }

// matching names the processes already running executable, which is what a
// second instance would be.
func matching(processes []process, executable string) []process {
	want := strings.ToLower(filepath.Base(executable))
	var out []process
	for _, p := range processes {
		if strings.ToLower(p.exe) == want {
			out = append(out, p)
		}
	}
	return out
}

// defaultShell is the shell this drill was built beside: the packaging puts both
// binaries in the same directory.
func defaultShell(given string) (string, error) {
	if given != "" {
		return given, nil
	}
	self, err := os.Executable()
	if err != nil {
		return "", fmt.Errorf("no shell given and this executable's own path is unknown: %w", err)
	}
	name := "mygo"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	path := filepath.Join(filepath.Dir(self), name)
	if _, err := os.Stat(path); err != nil {
		return "", fmt.Errorf("no shell given and %s is not there: pass --shell <path to the shell>", path)
	}
	return path, nil
}

// exitCode is the code the observed shell ended with, or nil when it reported
// none.
func exitCode(waited error) *int {
	var exit *exec.ExitError
	if errors.As(waited, &exit) {
		code := exit.ExitCode()
		return &code
	}
	// ErrWaitDelay only ever replaces a nil result (os/exec reports it after a
	// successful exit whose log pipe something the shell left behind still
	// holds), so the shell itself exited 0.
	if waited == nil || errors.Is(waited, exec.ErrWaitDelay) {
		code := 0
		return &code
	}
	return nil
}

// writeJSON writes one report, creating the directory it lands in.
func writeJSON(path string, value any) error {
	blob, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(path, append(blob, '\n'), 0o644)
}

// verdict words the run's outcome for the log line.
func verdict(ok bool) string {
	if ok {
		return "PASS"
	}
	return "FAIL"
}

// findProcessesByCommandLine names the pids whose command line contains
// pattern: the drill's own pgrep -f, so the same lookup works on every platform.
func findProcessesByCommandLine(pattern string) ([]int, error) {
	processes, err := listProcesses()
	if err != nil {
		return nil, err
	}
	var pids []int
	for _, p := range processes {
		if strings.Contains(p.cmd, pattern) {
			pids = append(pids, p.pid)
		}
	}
	sort.Ints(pids)
	return pids, nil
}

// defaultEnv reads an environment default.
func defaultEnv(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}
