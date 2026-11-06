// Package policy decides what the shell's window may load and open. It is the
// Go counterpart of the rules in desktop/src/main.cjs createWindow: a
// navigation stays in the window only on the GUI's own loopback origin (and for
// the shell's file: pages), everything else leaves for the system browser, and
// a window.open() never gets a window of its own.
package policy

import (
	"net/url"
	"strings"
)

// Decision is the outcome of one navigation or window-open request.
type Decision struct {
	// Allow keeps the request inside the shell.
	Allow bool
	// External is the URL to hand to the system browser, or "" for none.
	External string
}

// Navigation decides one pending main-frame navigation: the window keeps the
// GUI's loopback origin and the shell's own file: pages, an http(s) URL
// anywhere else opens in the system browser instead, and everything else (a
// javascript: URL, an app scheme) is simply cancelled.
func Navigation(rawURL string) Decision {
	if IsLoopback(rawURL) || IsFile(rawURL) {
		return Decision{Allow: true}
	}
	if IsHTTP(rawURL) {
		return Decision{External: rawURL}
	}
	return Decision{}
}

// WindowOpen decides one window.open() or target="_blank" request. Nothing gets
// a window of its own — the GUI is one window — so the answer is always deny,
// and an http(s) URL outside the loopback origin is handed to the system
// browser on the way out.
//
// The loopback test here is the one Navigation applies, which also accepts a
// loopback URL without a path; the Electron regex required a trailing "/" in
// this branch alone, so a bare "http://127.0.0.1:50929" from window.open would
// have left for the system browser. A loopback URL is never worth handing out.
func WindowOpen(rawURL string) Decision {
	if IsHTTP(rawURL) && !IsLoopback(rawURL) {
		return Decision{External: rawURL}
	}
	return Decision{}
}

// PermissionAllowed answers a page's permission request, for every kind: no.
//
// The Electron window is sandboxed and this shell needs no camera, microphone,
// location or notification, while mygo grants the pages of trusted origins
// whatever they ask for by default — the GUI's own origin included. Saying no
// here is what keeps the two shells' privileges the same.
func PermissionAllowed([]string) bool { return false }

// IsLoopback reports whether rawURL is http or https on 127.0.0.1 or localhost,
// on any port. The host must be the whole host: "127.0.0.1.example.com" and
// "localhost.example.com" are not the loopback.
func IsLoopback(rawURL string) bool {
	parsed, ok := parse(rawURL)
	if !ok || !isHTTP(parsed) {
		return false
	}
	switch strings.ToLower(parsed.Hostname()) {
	case "127.0.0.1", "localhost":
		return true
	}
	return false
}

// IsHTTP reports whether rawURL is an http or https URL.
func IsHTTP(rawURL string) bool {
	parsed, ok := parse(rawURL)
	return ok && isHTTP(parsed)
}

// IsFile reports whether rawURL is a file: URL, which is how the shell's own
// pages are loaded when they come from disk.
func IsFile(rawURL string) bool {
	parsed, ok := parse(rawURL)
	return ok && strings.EqualFold(parsed.Scheme, "file")
}

// parse reads a URL, reporting whether it carries a scheme.
func parse(rawURL string) (*url.URL, bool) {
	parsed, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil || parsed.Scheme == "" {
		return nil, false
	}
	return parsed, true
}

// isHTTP reports whether the parsed URL is http or https.
func isHTTP(parsed *url.URL) bool {
	scheme := strings.ToLower(parsed.Scheme)
	return scheme == "http" || scheme == "https"
}
