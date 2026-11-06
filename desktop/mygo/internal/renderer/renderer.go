// Package renderer formats the page's own messages for the host log: the Go
// counterpart of desktop/src/runtime.cjs:rendererLogLine, which the Electron
// shell feeds from webContents' console-message, preload-error and
// render-process-gone events.
//
// Only warning and error are written: the GUI logs at info for everything it
// does, and those lines would bury the host's own output.
package renderer

import (
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"
)

const (
	// LineMax caps one line. A single overlong message must not grow the log
	// the error page carries line by line.
	LineMax = 500
	// SourceMax caps the source field. The client plugin batch alone is one
	// 2.8 KiB combo URL, and an unbounded source would take the whole line
	// budget, leaving only the URL and cutting the message that says why
	// (measured 2026-10-15: a "[renderer] error" line was 100% URL).
	SourceMax = 120
	// Truncation marks a line the cap cut. It is the evidence that something
	// was dropped, rather than a silent tail loss.
	Truncation = " ...[truncated]"
	// SourceReserve is how much of the source cap the shortening hint takes.
	sourceReserve = 20
	// MaxMessage bounds what the preload sends over the bridge.
	MaxMessage = 2000
)

// newlines collapses the whitespace around a line break into one space: the
// host log is one record per line.
var newlines = regexp.MustCompile("[ \t]*\r?\n[ \t]*")

// Entry is one message a page or the preload reported.
type Entry struct {
	// Level is the console level: warning/warn or error. Everything else is
	// dropped.
	Level string
	// Message is the rendered message.
	Message string
	// Source is the script or document the message came from.
	Source string
	// Line is the line number in Source, or 0 when unknown.
	Line int
}

// Line renders one entry as a host log line, or "" when the shell does not log
// that level. The shape is:
//
//	[renderer] <level> <source>:<line> <message>
//
// The source comes before the message so a truncated line still names who
// logged it and where.
func Line(entry Entry) string {
	level := normalizedLevel(entry.Level)
	if level == "" {
		return ""
	}
	source := shortenSource(entry.Source)
	head := "[renderer] " + level
	if source != "" {
		head += " " + source
		if entry.Line > 0 {
			head += ":" + strconv.Itoa(entry.Line)
		}
	}
	message := newlines.ReplaceAllString(entry.Message, " ")
	budget := LineMax - len(head) - 1 - len(Truncation)
	if budget < 0 {
		budget = 0
	}
	body := truncate(message, budget, Truncation)
	rendered := head + " " + body
	if len(rendered) > LineMax {
		rendered = truncate(rendered, LineMax-len(Truncation), "") + Truncation
	}
	return rendered
}

// ProcessGoneLine is the one line a web content process that crashed or was
// killed leaves in the host log. Electron's console-message event reports an
// exit code beside the reason; mygo reports the reason alone, so that is all
// this line can carry.
func ProcessGoneLine(reason string) string {
	return "[renderer] render process gone: reason=" + reason
}

// normalizedLevel names a level the log carries, or "" for one it drops.
func normalizedLevel(level string) string {
	switch strings.ToLower(strings.TrimSpace(level)) {
	case "warning", "warn":
		return "warning"
	case "error":
		return "error"
	}
	return ""
}

// shortenSource keeps a source short enough to leave the message its budget,
// counting what it dropped rather than losing the tail silently.
func shortenSource(source string) string {
	if source == "" {
		return ""
	}
	if len(source) <= SourceMax {
		return source
	}
	head := truncate(source, SourceMax-sourceReserve, "")
	return head + "…(+" + strconv.Itoa(len(source)-len(head)) + "ch)"
}

// truncate cuts text to at most max bytes without splitting a UTF-8 sequence,
// appending suffix when it cut anything.
func truncate(text string, max int, suffix string) string {
	if max <= 0 {
		return suffix
	}
	if len(text) <= max {
		return text
	}
	cut := max
	for cut > 0 && !utf8.RuneStart(text[cut]) {
		cut--
	}
	return text[:cut] + suffix
}
