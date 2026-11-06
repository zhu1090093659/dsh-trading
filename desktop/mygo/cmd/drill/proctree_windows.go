//go:build windows

package main

import (
	"errors"
	"fmt"
	"strconv"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Offsets inside the PEB and inside RTL_USER_PROCESS_PARAMETERS that hold the
// command line. A 32-bit process on 64-bit Windows keeps its own 32-bit PEB, so
// the offsets differ from the native ones; the drill itself is amd64.
const (
	pebProcessParameters64 = 0x20
	pebProcessParameters32 = 0x10
	processParametersCmd64 = 0x70
	processParametersCmd32 = 0x40
)

// ntdll carries the one call that hands out a process's PEB: there is no
// kernel32 wrapper for it.
var (
	ntdll                         = windows.NewLazySystemDLL("ntdll.dll")
	procNtQueryInformationProcess = ntdll.NewProc("NtQueryInformationProcess")
)

// listProcesses reads the process table with Toolhelp32 and each process's
// command line out of its own PEB: Windows has no /proc. The executable's parent
// link comes from the snapshot, which is what the tree is built from.
func listProcesses() ([]process, error) {
	snapshot, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return nil, fmt.Errorf("CreateToolhelp32Snapshot: %w", err)
	}
	defer windows.CloseHandle(snapshot)
	entry := windows.ProcessEntry32{Size: uint32(unsafe.Sizeof(windows.ProcessEntry32{}))}
	if err := windows.Process32First(snapshot, &entry); err != nil {
		if errors.Is(err, windows.ERROR_NO_MORE_FILES) {
			return nil, nil
		}
		return nil, fmt.Errorf("Process32First: %w", err)
	}
	var processes []process
	for {
		p := process{
			pid:  int(entry.ProcessID),
			ppid: int(entry.ParentProcessID),
			exe:  windows.UTF16ToString(entry.ExeFile[:]),
		}
		p.start, p.cmd = readProcessDetails(uint32(entry.ProcessID))
		processes = append(processes, p)
		if err := windows.Process32Next(snapshot, &entry); err != nil {
			if errors.Is(err, windows.ERROR_NO_MORE_FILES) {
				break
			}
			return nil, fmt.Errorf("Process32Next: %w", err)
		}
	}
	return processes, nil
}

// readProcessDetails reads a process's start time (the half of its identity a
// recycled pid loses) and its command line, both from the process itself.
//
// A process that refuses the read - a protected one, or one of another integrity
// level - yields empty values instead of failing the snapshot: pids, parents and
// executable names are the evidence that matters, and a missing command line
// shows as one.
func readProcessDetails(pid uint32) (string, string) {
	handle, err := windows.OpenProcess(
		windows.PROCESS_QUERY_LIMITED_INFORMATION|windows.PROCESS_VM_READ, false, pid)
	if err != nil {
		return "", ""
	}
	defer windows.CloseHandle(handle)
	start := ""
	var creation, exit, kernel, user windows.Filetime
	if err := windows.GetProcessTimes(handle, &creation, &exit, &kernel, &user); err == nil {
		start = strconv.FormatInt(creation.Nanoseconds(), 10)
	}
	return start, readCommandLine(handle)
}

// processBasicInformation mirrors PROCESS_BASIC_INFORMATION. Every field is
// pointer sized, which is what makes the declaration right on both bitnesses.
type processBasicInformation struct {
	exitStatus                   uintptr
	pebBaseAddress               uintptr
	affinityMask                 uintptr
	basePriority                 uintptr
	uniqueProcessID              uintptr
	inheritedFromUniqueProcessID uintptr
}

// unicodeString mirrors UNICODE_STRING.
type unicodeString struct {
	length        uint16
	maximumLength uint16
	buffer        uintptr
}

// readCommandLine reads the command line the process was started with, through
// its PEB. It returns "" rather than an error when the process will not say: a
// caller that cannot read a protected process's command line still has its pid,
// its parent and its executable.
func readCommandLine(handle windows.Handle) string {
	var info processBasicInformation
	var returned uint32
	status, _, _ := procNtQueryInformationProcess.Call(
		uintptr(handle), 0, // ProcessBasicInformation
		uintptr(unsafe.Pointer(&info)), unsafe.Sizeof(info), uintptr(unsafe.Pointer(&returned)))
	if status != 0 || info.pebBaseAddress == 0 {
		return ""
	}
	parametersOffset, commandOffset := uintptr(pebProcessParameters64), uintptr(processParametersCmd64)
	var wow64 bool
	if err := windows.IsWow64Process(handle, &wow64); err == nil && wow64 {
		parametersOffset, commandOffset = pebProcessParameters32, processParametersCmd32
	}
	var parameters uintptr
	if !readMemory(handle, info.pebBaseAddress+parametersOffset, unsafe.Pointer(&parameters), unsafe.Sizeof(parameters)) {
		return ""
	}
	if parameters == 0 {
		return ""
	}
	var commandLine unicodeString
	if !readMemory(handle, parameters+commandOffset, unsafe.Pointer(&commandLine), unsafe.Sizeof(commandLine)) {
		return ""
	}
	if commandLine.length == 0 || commandLine.buffer == 0 {
		return ""
	}
	buffer := make([]uint16, int(commandLine.length)/2)
	if len(buffer) == 0 {
		return ""
	}
	if !readMemory(handle, commandLine.buffer, unsafe.Pointer(&buffer[0]), uintptr(len(buffer))*2) {
		return ""
	}
	return windows.UTF16ToString(buffer)
}

// readMemory reads size bytes of the target process into out.
func readMemory(handle windows.Handle, address uintptr, out unsafe.Pointer, size uintptr) bool {
	if size == 0 {
		return false
	}
	var read uintptr
	if err := windows.ReadProcessMemory(handle, address, (*byte)(out), size, &read); err != nil {
		return false
	}
	return read == size
}
