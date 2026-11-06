package shell

import (
	"bufio"
	"errors"
	"os"
	"os/exec"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/dshtrading/desktop-mygo/internal/launch"
)

// hostProcess is one dsh host this shell started. It lives in its own process
// group, so the shell can end the whole tree the host spawns (node workers,
// pnpm, anything a plugin shells out to) with one signal.
//
// The shell targets macOS and Linux: Windows needs taskkill /T for the same
// job, which is why the Electron shell keeps a separate branch there.
type hostProcess struct {
	cmd       *exec.Cmd
	exited    chan struct{}
	startedAt time.Time
	// expected is set when the shell itself asked the host to go, so its exit
	// is a shutdown rather than a failure to report.
	expected atomic.Bool

	mu     sync.Mutex
	code   *int
	signal string
}

// startHost spawns the host and starts reading its output. onLine sees every
// line of it, already read but not yet masked: the caller logs it. onExit learns
// how the host ended, and whether the shell asked for it.
func startHost(spec launch.HostSpec, onLine func(line string), onExit func(code *int, signal string, expected bool)) (*hostProcess, error) {
	reader, writer, err := os.Pipe()
	if err != nil {
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
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := cmd.Start(); err != nil {
		_ = reader.Close()
		_ = writer.Close()
		return nil, err
	}
	// The child holds the last write end now; closing ours is what makes the
	// reader see EOF when the host goes.
	_ = writer.Close()

	host := &hostProcess{cmd: cmd, exited: make(chan struct{}), startedAt: time.Now()}
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
		if status, ok := state.Sys().(syscall.WaitStatus); ok && status.Signaled() {
			h.signal = status.Signal().String()
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
// the error page.
func (h *hostProcess) exitState() (*int, string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.code, h.signal
}

// pid is the host's process id, which is also its process group id.
func (h *hostProcess) pid() int {
	if h.cmd.Process == nil {
		return 0
	}
	return h.cmd.Process.Pid
}

// stop ends the host's process group: SIGTERM first, SIGKILL once the grace is
// spent. It reports how the host ended.
func (h *hostProcess) stop(grace, killWait time.Duration) string {
	select {
	case <-h.exited:
		return "already exited"
	default:
	}
	h.expected.Store(true)
	pgid := h.pid()
	_ = syscall.Kill(-pgid, syscall.SIGTERM)
	select {
	case <-h.exited:
		return "reaped"
	case <-time.After(grace):
	}
	_ = syscall.Kill(-pgid, syscall.SIGKILL)
	select {
	case <-h.exited:
		return "reaped"
	case <-time.After(killWait):
		return "not reaped"
	}
}

// groupGone reports whether the host's process group is empty, which is what
// says no plugin-spawned child outlived the shutdown.
func (h *hostProcess) groupGone() bool {
	pgid := h.pid()
	if pgid == 0 {
		return true
	}
	return errors.Is(syscall.Kill(-pgid, 0), syscall.ESRCH)
}
