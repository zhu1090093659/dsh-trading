//go:build linux

package main

import (
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// listProcesses reads the process table out of /proc: every directory named
// after a pid carries its stat line, its command line and a link to its
// executable.
func listProcesses() ([]process, error) {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return nil, err
	}
	processes := make([]process, 0, len(entries))
	for _, entry := range entries {
		pid, err := strconv.Atoi(entry.Name())
		if err != nil {
			continue
		}
		p, err := readProcess(pid)
		if err != nil {
			// A process that vanished mid-walk is not an error: a process table
			// is a sample, not a transaction.
			continue
		}
		processes = append(processes, p)
	}
	return processes, nil
}

// readProcess reads one process: its parent and start time from the stat line,
// its command line from cmdline, its executable name from the exe link.
func readProcess(pid int) (process, error) {
	dir := "/proc/" + strconv.Itoa(pid)
	stat, err := os.ReadFile(dir + "/stat")
	if err != nil {
		return process{}, err
	}
	// The second field is the executable's name in parentheses and may itself
	// hold spaces or parentheses, so the numbered fields start after the last
	// ')' of the line.
	line := string(stat)
	end := strings.LastIndexByte(line, ')')
	if end < 0 {
		return process{}, errors.New("stat has no command field")
	}
	fields := strings.Fields(line[end+1:])
	// After the command: state, ppid, pgrp, session, tty, tpgid, flags, minflt,
	// cminflt, majflt, cmajflt, utime, stime, cutime, cstime, priority, nice,
	// threads, itrealvalue, starttime.
	if len(fields) < 20 {
		return process{}, errors.New("stat is shorter than the kernel writes it")
	}
	ppid, err := strconv.Atoi(fields[1])
	if err != nil {
		return process{}, err
	}
	p := process{pid: pid, ppid: ppid, start: fields[19]}
	if target, err := os.Readlink(dir + "/exe"); err == nil {
		p.exe = filepath.Base(target)
	} else if open := strings.IndexByte(line, '('); open >= 0 && open < end {
		p.exe = line[open+1 : end]
	}
	if raw, err := os.ReadFile(dir + "/cmdline"); err == nil {
		p.cmd = strings.TrimSpace(strings.ReplaceAll(strings.TrimRight(string(raw), string(rune(0))), string(rune(0)), " "))
	}
	return p, nil
}
