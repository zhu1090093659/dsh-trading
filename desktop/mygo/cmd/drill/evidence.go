package main

import (
	"errors"
	"io"
	"os"
	"strings"
	"time"
)

// step records one observable the drill drove and what it saw.
func (d *drill) step(name string, ok bool, observed string) {
	d.mu.Lock()
	d.steps = append(d.steps, step{Name: name, OK: ok, Observed: observed})
	d.mu.Unlock()
	d.logf("drill: step %q ok=%v: %s", name, ok, observed)
}

// logLines returns the lines the host log gained since this run started that
// contain want.
func (d *drill) logLines(want string) []string {
	text := d.logTailText()
	if text == "" {
		return nil
	}
	var found []string
	for _, line := range strings.Split(text, "\n") {
		if strings.Contains(line, want) {
			found = append(found, line)
		}
	}
	return found
}

// waitLogLine waits for one such line and returns the first match.
func (d *drill) waitLogLine(want string, limit time.Duration) (string, error) {
	deadline := time.Now().Add(limit)
	for {
		if lines := d.logLines(want); len(lines) > 0 {
			return lines[0], nil
		}
		if time.Now().After(deadline) {
			return "", errors.New("the host log never carried " + quote(want))
		}
		time.Sleep(100 * time.Millisecond)
	}
}

// logTailText is what the host log gained since this run started, so the
// evidence comes from this run and not from the one before it.
func (d *drill) logTailText() string {
	s := d.shellInstance()
	if s == nil {
		return ""
	}
	path := s.LogPath()
	if path == "" {
		return ""
	}
	file, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer file.Close()
	d.mu.Lock()
	offset := d.logOffset
	d.mu.Unlock()
	if offset > 0 {
		if _, err := file.Seek(offset, io.SeekStart); err != nil {
			return ""
		}
	}
	blob, err := io.ReadAll(file)
	if err != nil {
		return ""
	}
	return string(blob)
}

// captureLogOffset remembers where this run's log lines start.
func (d *drill) captureLogOffset() {
	s := d.shellInstance()
	if s == nil {
		return
	}
	path := s.LogPath()
	if path == "" {
		return
	}
	info, err := os.Stat(path)
	if err != nil {
		return
	}
	d.mu.Lock()
	d.logOffset = info.Size()
	d.mu.Unlock()
}

// logEvidence gathers the lines the report carries.
func (d *drill) logEvidence() logEvidence {
	evidence := logEvidence{}
	if s := d.shellInstance(); s != nil {
		evidence.Path = s.LogPath()
	}
	evidence.RestartLines = firstLines(d.logLines("restarting the host (attempt "), 8)
	evidence.BudgetLines = firstLines(d.logLines("host restart budget spent"), 4)
	evidence.RendererLines = firstLines(d.logLines("[renderer] "), 8)
	blocked := append(d.logLines("blocked a navigation to "), d.logLines("denied a window.open() for ")...)
	evidence.BlockedLines = firstLines(blocked, 8)
	return evidence
}

// firstLines keeps at most max lines.
func firstLines(lines []string, max int) []string {
	if len(lines) <= max {
		return lines
	}
	return lines[:max]
}
