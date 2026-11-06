package renderer

import (
	"strings"
	"testing"
	"unicode/utf8"
)

func TestLineKeepsOnlyWarningsAndErrors(t *testing.T) {
	cases := []struct {
		level string
		want  bool
	}{
		{"error", true},
		{"ERROR", true},
		{"warning", true},
		{"warn", true},
		{"Warning", true},
		{"info", false},
		{"log", false},
		{"debug", false},
		{"verbose", false},
		{"", false},
		{"trace", false},
	}
	for _, c := range cases {
		line := Line(Entry{Level: c.level, Message: "boom", Source: "app.js", Line: 7})
		if got := line != ""; got != c.want {
			t.Errorf("Line(level=%q) rendered=%v, want %v", c.level, got, c.want)
		}
	}
}

func TestLineShapeNamesSourceAndMessage(t *testing.T) {
	got := Line(Entry{Level: "warn", Message: "Failed to load plugins", Source: "http://127.0.0.1:50929/plugins/??a,b", Line: 12})
	want := "[renderer] warning http://127.0.0.1:50929/plugins/??a,b:12 Failed to load plugins"
	if got != want {
		t.Errorf("Line = %q, want %q", got, want)
	}
}

func TestLineWithoutSourceOrLine(t *testing.T) {
	if got, want := Line(Entry{Level: "error", Message: "uncaught"}), "[renderer] error uncaught"; got != want {
		t.Errorf("Line = %q, want %q", got, want)
	}
	if got, want := Line(Entry{Level: "error", Message: "uncaught", Source: "app.js"}), "[renderer] error app.js uncaught"; got != want {
		t.Errorf("Line = %q, want %q", got, want)
	}
}

func TestLineCollapsesNewlinesIntoOneRecord(t *testing.T) {
	got := Line(Entry{Level: "error", Message: "first line\n  second line\r\nthird", Source: "app.js", Line: 1})
	want := "[renderer] error app.js:1 first line second line third"
	if got != want {
		t.Errorf("Line = %q, want %q", got, want)
	}
}

func TestLineCapsTheWholeLineAndSaysItCut(t *testing.T) {
	long := strings.Repeat("x", 2000)
	line := Line(Entry{Level: "error", Message: long, Source: "app.js", Line: 3})
	if len(line) > LineMax {
		t.Fatalf("line length = %d, want at most %d", len(line), LineMax)
	}
	if !strings.HasSuffix(line, Truncation) {
		t.Errorf("line does not end with %q: %q", Truncation, line)
	}
	if !strings.HasPrefix(line, "[renderer] error app.js:3 ") {
		t.Errorf("line lost its head: %q", line)
	}
}

func TestLineShortensAnOverlongSourceAndCountsWhatItDropped(t *testing.T) {
	source := "http://127.0.0.1:50929/plugins/??" + strings.Repeat("entry,", 200)
	line := Line(Entry{Level: "error", Message: "the message that matters", Source: source, Line: 1})
	if len(line) > LineMax {
		t.Fatalf("line length = %d, want at most %d", len(line), LineMax)
	}
	if !strings.Contains(line, "…(+") {
		t.Errorf("line does not count the dropped source: %q", line)
	}
	if !strings.Contains(line, "the message that matters") {
		t.Errorf("line lost the message: %q", line)
	}
}

func TestLineKeepsUTF8Intact(t *testing.T) {
	message := strings.Repeat("插件加载失败", 200)
	line := Line(Entry{Level: "error", Message: message})
	if !utf8.ValidString(line) {
		t.Fatalf("line is not valid UTF-8: %q", line)
	}
	if len(line) > LineMax {
		t.Fatalf("line length = %d, want at most %d", len(line), LineMax)
	}
}

func TestProcessGoneLine(t *testing.T) {
	if got, want := ProcessGoneLine("terminated"), "[renderer] render process gone: reason=terminated"; got != want {
		t.Errorf("ProcessGoneLine = %q, want %q", got, want)
	}
}

func TestLineSurvivesAnAbsurdSource(t *testing.T) {
	line := Line(Entry{Level: "error", Message: "m", Source: strings.Repeat("s", 5000), Line: 1})
	if len(line) > LineMax {
		t.Fatalf("line length = %d, want at most %d", len(line), LineMax)
	}
}
