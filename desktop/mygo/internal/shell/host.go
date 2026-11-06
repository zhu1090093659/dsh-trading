package shell

import (
	"bufio"
	"os"
	"os/exec"
	"sync"
	"sync/atomic"
	"time"

	"github.com/dshtrading/desktop-mygo/internal/launch"
)

// hostProcess is one dsh host this shell started, together with the platform
// handle that owns the whole tree it spawns (node workers, pnpm, anything a
// plugin shells out to): a process group on the unices, a job object on Windows.
// Ending the shell has to end that tree, so the handle is what stop() releases.
type hostProcess struct {
	cmd  *exec.Cmd
	tree hostTree
	// exited is closed once the host process itself has been reaped.
	exited    chan struct{}
	startedAt time.Time
	// expected is set when the shell itself asked the host to go, so its exit
	// is a shutdown rather than a failure to report.
	expected atomic.Bool

	mu     sync.Mutex
	code   *int
	signal string
}

// hostTree is the platform's handle on a host and everything it spawns.
type hostTree interface {
	// bind makes the just-started host the root of the tree. A failure must not
	// be papered over: a host outside its tree is a host that outlives the shell.
	bind(process *os.Process) error
	// terminate asks the tree to exit on its own.
	terminate()
	// kill ends the tree outright.
	kill()
	// gone reports whether no process of the tree is left.
	gone() bool
	// close releases the handle, ending whatever is still in the tree.
	close()
}

// pollInterval is how often a wait re-reads a tree's population.
const pollInterval = 25 * time.Millisecond

// startHost spawns the host and starts reading its output. onLine sees every
// line of it, already read but not yet masked: the caller logs it. onExit learns
// how the host ended, and whether the shell asked for it.
func startHost(spec launch.HostSpec, onLine func(line string), onExit func(code *int, signal string, expected bool)) (*hostProcess, error) {
	reader, writer, err := os.Pipe()
	if err != nil {
		return nil, err
	}
	// The tree handle comes first: the host is put into it the moment it starts,
	// and a host that cannot be bound is ended rather than run unmanaged.
	tree, err := newHostTree()
	if err != nil {
		_ = reader.Close()
		_ = writer.Close()
		return nil, err
	}
	cmd := exec.Command(spec.Paths.NodeBin, spec.Args()...)
	cmd.Dir = spec.Dir()
	cmd.Env = spec.Env()
	// One pipe for both streams, as the Electron shell logs them together: the
	// host's lifecycle lines arrive on stderr and its GUI URL on stdout, and a
	// reader that split them would have to interleave them anyway.
	cmd.Stdout = writer
	cmd.Stderr = writer
	configureHostCommand(cmd)
	if err := cmd.Start(); err != nil {
		tree.close()
		_ = reader.Close()
		_ = writer.Close()
		return nil, err
	}
	if err := tree.bind(cmd.Process); err != nil {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		tree.close()
		_ = reader.Close()
		_ = writer.Close()
		return nil, err
	}
	// The child holds the last write end now; closing ours is what makes the
	// reader see EOF when the host goes.
	_ = writer.Close()

	host := &hostProcess{cmd: cmd, tree: tree, exited: make(chan struct{}), startedAt: time.Now()}
	go host.read(reader, onLine)
	go host.wait(onExit)
	return host, nil
}

// read reports every output line until the host closes the pipe.
func (h *hostProcess) read(reader *os.File, onLine func(line string)) {
	defer reader.Close()
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 64*1024), 4*1024*1024)
	for scanner.Scan() {
		if line := scanner.Text(); onLine != nil && line != "" {
			onLine(line)
		}
	}
}

// wait reaps the host and records how it ended.
func (h *hostProcess) wait(onExit func(code *int, signal string, expected bool)) {
	_ = h.cmd.Wait()
	h.mu.Lock()
	if state := h.cmd.ProcessState; state != nil {
		if name := exitedOnSignal(state); name != "" {
			h.signal = name
		} else {
			code := state.ExitCode()
			h.code = &code
		}
	}
	code, signal := h.code, h.signal
	h.mu.Unlock()
	close(h.exited)
	if onExit != nil {
		onExit(code, signal, h.expected.Load())
	}
}

// exitState is the code and signal the host ended with, for the log line and
// the error page. Windows leaves the signal empty: a process there always ends
// on an exit code (see exitedOnSignal).
func (h *hostProcess) exitState() (*int, string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.code, h.signal
}

// pid is the host's process id, which is also its process group id on the
// unices and the root of its job on Windows.
func (h *hostProcess) pid() int {
	if h.cmd.Process == nil {
		return 0
	}
	return h.cmd.Process.Pid
}

// stop ends the host's tree: an ask first, an outright kill once the grace is
// spent, then the wait for the tree to be gone. It reports how the host ended.
//
// The handle is released on every path, including the one where the host was
// already gone: on Windows that release is what ends a plugin-spawned child that
// outlived the host, so it must never be skipped.
func (h *hostProcess) stop(grace, killWait time.Duration) string {
	defer h.tree.close()
	if h.exitedAlready() {
		return "already exited"
	}
	h.expected.Store(true)
	h.tree.terminate()
	if h.awaitExit(grace) {
		return "reaped"
	}
	h.tree.kill()
	if h.awaitEnd(killWait) {
		return "reaped"
	}
	return "not reaped"
}

// exitedAlready reports whether the host has already been reaped.
func (h *hostProcess) exitedAlready() bool {
	select {
	case <-h.exited:
		return true
	default:
		return false
	}
}

// awaitExit waits up to limit for the host process itself to end.
func (h *hostProcess) awaitExit(limit time.Duration) bool {
	timer := time.NewTimer(limit)
	defer timer.Stop()
	select {
	case <-h.exited:
		return true
	case <-timer.C:
		return false
	}
}

// awaitTree waits until the host is reaped and no process of its tree is left,
// which is what says no plugin-spawned child outlived the shutdown.
func (h *hostProcess) awaitTree(deadline time.Time) bool {
	return awaitCondition(deadline, func() bool { return h.exitedAlready() && h.tree.gone() })
}

// awaitCondition polls condition until it holds or the deadline passes.
func awaitCondition(deadline time.Time, condition func() bool) bool {
	for {
		if condition() {
			return true
		}
		if !time.Now().Before(deadline) {
			return false
		}
		time.Sleep(pollInterval)
	}
}

// groupGone reports whether the host's process tree is empty, which is what
// says no plugin-spawned child outlived the shutdown.
func (h *hostProcess) groupGone() bool {
	if h.tree == nil {
		return true
	}
	return h.tree.gone()
}
