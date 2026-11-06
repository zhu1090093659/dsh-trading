package shell

import (
	"strings"
	"testing"

	"github.com/dshtrading/desktop-mygo/internal/renderer"
)

func TestRendererLogKeepsTheLevelsTheHostLogCarries(t *testing.T) {
	s := &Shell{metrics: Metrics{BridgeCalls: map[string]int{}}}
	s.rendererLog(renderer.Entry{Level: "info", Message: "the GUI narrating itself"})
	s.rendererLog(renderer.Entry{Level: "debug", Message: "more noise"})
	s.rendererLog(renderer.Entry{Level: "log", Message: "more noise"})
	if len(s.logTail) != 0 {
		t.Fatalf("logTail = %v, want the quiet levels dropped", s.logTail)
	}
	s.rendererLog(renderer.Entry{Level: "warn", Message: "Failed to load plugins", Source: "app.js", Line: 7})
	if len(s.logTail) != 1 {
		t.Fatalf("logTail = %v, want one line", s.logTail)
	}
	want := "[renderer] warning app.js:7 Failed to load plugins"
	if s.logTail[0] != want {
		t.Errorf("logTail[0] = %q, want %q", s.logTail[0], want)
	}
}

func TestRendererLogMasksNothingItShouldNot(t *testing.T) {
	s := &Shell{metrics: Metrics{BridgeCalls: map[string]int{}}}
	s.rendererLog(renderer.Entry{Level: "error", Message: "request failed: /?token=deadbeef", Source: "app.js", Line: 1})
	if len(s.logTail) != 1 {
		t.Fatalf("logTail = %v, want one line", s.logTail)
	}
	if strings.Contains(s.logTail[0], "deadbeef") {
		t.Errorf("logTail[0] = %q, still carries the token", s.logTail[0])
	}
}
