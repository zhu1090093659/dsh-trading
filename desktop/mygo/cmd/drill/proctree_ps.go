//go:build !linux && !windows

package main

import (
	"fmt"
	"os/exec"
	"strconv"
	"strings"
)

// listProcesses reads the process table through ps, which is what the platforms
// without /proc offer.
//
// This reading has no start time, so a process here is identified by its pid
// alone: pids recycled inside one run would read as one process. The tree the
// evidence is about lives for seconds, which is why that is acceptable on these
// platforms.
func listProcesses() ([]process, error) {
	out, err := exec.Command("ps", "-axo", "pid=,ppid=,comm=,args=").Output()
	if err != nil {
		return nil, fmt.Errorf("ps: %w", err)
	}
	var processes []process
	for _, line := range strings.Split(string(out), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 3 {
			continue
		}
		pid, err := strconv.Atoi(fields[0])
		if err != nil {
			continue
		}
		ppid, err := strconv.Atoi(fields[1])
		if err != nil {
			continue
		}
		p := process{pid: pid, ppid: ppid, exe: fields[2]}
		if len(fields) > 3 {
			p.cmd = strings.Join(fields[3:], " ")
		}
		processes = append(processes, p)
	}
	return processes, nil
}
