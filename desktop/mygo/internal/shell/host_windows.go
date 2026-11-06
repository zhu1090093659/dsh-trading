//go:build windows

package shell

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// taskkillTimeout bounds one taskkill call: a taskkill that hangs must never
// hold the quit.
const taskkillTimeout = 10 * time.Second

// jobTree is the Windows tree handle. The host is assigned to a job object that
// is armed with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, so the kernel empties the
// job when its last handle closes: a shell that disappears without running
// teardown (crash, Task Manager, a killed parent) still takes the whole host
// tree with it, which a taskkill from the dying shell could not do.
type jobTree struct {
	job windows.Handle
	pid int
	// closed and lastAlive keep the population the handle saw on the way out, so
	// the run record reports what was still there rather than what close killed.
	// observed separates "the job was empty" from "the query failed": an
	// unreadable population is not an empty one.
	closed    bool
	lastAlive int
	observed  bool
}

// newHostTree creates and arms the host's job object.
func newHostTree() (hostTree, error) {
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return nil, fmt.Errorf("creating the host job object: %w", err)
	}
	limits := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	limits.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	if _, err := windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&limits)), uint32(unsafe.Sizeof(limits))); err != nil {
		_ = windows.CloseHandle(job)
		return nil, fmt.Errorf("arming the host job object: %w", err)
	}
	return &jobTree{job: job}, nil
}

// configureHostCommand keeps the host from opening a console window: the shell
// is a GUI process and the host is a console child. The job object, not a
// process group, is what owns the tree on Windows.
func configureHostCommand(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: windows.CREATE_NO_WINDOW, HideWindow: true}
}

// bind assigns the just-started host to its job.
//
// os/exec has no way to create a process already inside a job (Windows would
// need STARTUPINFOEX with PROC_THREAD_ATTRIBUTE_JOB_LIST), so the host runs for
// a few instructions before this call. The window is closed from both ends: node
// cannot spawn a child before its first tick, which is far longer than the
// assignment takes, and kill() walks the parent chain with taskkill /T as well,
// so a child that somehow slipped out is still reclaimed. When the assignment
// itself fails the caller ends the host instead of running a tree this shell
// could not reclaim.
func (t *jobTree) bind(process *os.Process) error {
	if process == nil {
		return errors.New("host job: no process to bind")
	}
	handle, err := windows.OpenProcess(windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE, false, uint32(process.Pid))
	if err != nil {
		return fmt.Errorf("opening host pid %d to assign it to its job: %w", process.Pid, err)
	}
	defer windows.CloseHandle(handle)
	if err := windows.AssignProcessToJobObject(t.job, handle); err != nil {
		return fmt.Errorf("assigning host pid %d to its job: %w", process.Pid, err)
	}
	t.pid = process.Pid
	return nil
}

// terminate asks the tree to close down the way the Electron shell does, with
// the graceful taskkill: it sends WM_CLOSE to windowed descendants and fails for
// a console process that offers no such channel. Failure is ignored; the grace
// that follows is what the host gets to end on its own.
func (t *jobTree) terminate() {
	if t.pid == 0 {
		return
	}
	_ = taskkill(t.pid, false)
}

// kill ends the tree two ways at once: taskkill /F /T walks the parent chain
// from the host, which also catches a process that slipped out of the job before
// it was assigned, and TerminateJobObject takes everything the job knows about.
func (t *jobTree) kill() {
	if t.pid == 0 {
		return
	}
	_ = taskkill(t.pid, true)
	if t.job != 0 {
		_ = windows.TerminateJobObject(t.job, 1)
	}
}

// gone reports whether the job holds no running process.
func (t *jobTree) gone() bool {
	if t.closed {
		return t.observed && t.lastAlive == 0
	}
	if t.job == 0 {
		return true
	}
	alive, err := t.activeProcesses()
	if err != nil {
		return false
	}
	return alive == 0
}

// close releases the job handle, and with it every process still in the job:
// the kernel terminates them, which is the backstop for a child that outlived
// the host. The population is read first so the run record can say what was
// still there.
func (t *jobTree) close() {
	if t.job == 0 {
		return
	}
	alive, err := t.activeProcesses()
	t.lastAlive, t.observed = alive, err == nil
	t.closed = true
	_ = windows.CloseHandle(t.job)
	t.job = 0
}

// activeProcesses is the job's live population.
func (t *jobTree) activeProcesses() (int, error) {
	var info jobObjectBasicAccounting
	var returned uint32
	if err := windows.QueryInformationJobObject(t.job, windows.JobObjectBasicAccountingInformation,
		uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info)), &returned); err != nil {
		return 0, err
	}
	return int(info.ActiveProcesses), nil
}

// jobObjectBasicAccounting mirrors JOBOBJECT_BASIC_ACCOUNTING_INFORMATION, which
// x/sys does not declare.
type jobObjectBasicAccounting struct {
	TotalUserTime             int64
	TotalKernelTime           int64
	ThisPeriodTotalUserTime   int64
	ThisPeriodTotalKernelTime int64
	TotalPageFaultCount       uint32
	TotalProcesses            uint32
	ActiveProcesses           uint32
	TotalTerminatedProcesses  uint32
}

// awaitEnd waits for the host to be reaped and for the job to empty: on Windows
// the tree, not just the host, is what has to be gone.
func (h *hostProcess) awaitEnd(limit time.Duration) bool {
	return h.awaitTree(time.Now().Add(limit))
}

// exitedOnSignal is empty on Windows: a process there always ends on an exit
// code, so the log line and the error page carry a code and no signal.
func exitedOnSignal(*os.ProcessState) string { return "" }

// taskkill asks Windows to end the process tree rooted at pid, the same call the
// Electron shell makes (desktop/src/main.cjs stopHost). It runs hidden and
// bounded, and its failure is the caller's to judge: the graceful attempt is
// allowed to fail.
func taskkill(pid int, force bool) error {
	args := []string{"/PID", strconv.Itoa(pid), "/T"}
	if force {
		args = append(args, "/F")
	}
	ctx, cancel := context.WithTimeout(context.Background(), taskkillTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "taskkill", args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: windows.CREATE_NO_WINDOW, HideWindow: true}
	return cmd.Run()
}
