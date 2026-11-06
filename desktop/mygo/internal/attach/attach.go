// Package attach decides whether a launch hands the GUI over to a dsh web that
// already answers, or starts its own host (desktop/README.md, "Handoff instead
// of double hosts").
package attach

import (
	"io"
	"net/http"
	"strings"
	"time"
)

// DefaultGUIURL is the dsh web GUI's default address. A dsh web host serves
// there, so a second host on one home would collide with it.
const DefaultGUIURL = "http://127.0.0.1:3080/"

// NoAttachEnv skips the handoff check and always starts a bundled host.
const NoAttachEnv = "DSH_DESKTOP_NO_ATTACH"

// ProbeTimeout bounds the handoff check: a port that does not answer this
// quickly is not a GUI the user is waiting for.
const ProbeTimeout = 1500 * time.Millisecond

// Decision is the outcome of the check.
type Decision struct {
	// Attach hands the URL to the system browser and quits without a host.
	Attach bool
	// URL is the GUI to open when Attach is set.
	URL string
	// Reason is the log line that explains the branch.
	Reason string
}

// Decide reports whether this launch attaches. probe answers whether a GUI is
// listening; NoAttachEnv short-circuits it, so an explicit DSH_DESKTOP_NO_ATTACH
// never probes at all.
func Decide(getenv func(string) string, probe func(url string) bool) Decision {
	if strings.TrimSpace(getenv(NoAttachEnv)) != "" {
		return Decision{Reason: NoAttachEnv + " is set: starting a bundled host"}
	}
	if probe(DefaultGUIURL) {
		return Decision{Attach: true, URL: DefaultGUIURL, Reason: "a dsh web GUI already answers at " + DefaultGUIURL}
	}
	return Decision{Reason: "nothing answers at " + DefaultGUIURL + ": starting a bundled host"}
}

// ProbeHTTP reports whether url answers with a status below 500, which is the
// test the Electron shell's probeGui applies: a 401 or 403 means a GUI is there
// and wants its token, a 5xx means something is broken and a bundled host is
// the better answer.
func ProbeHTTP(url string, timeout time.Duration) bool {
	client := &http.Client{Timeout: timeout}
	response, err := client.Get(url)
	if err != nil {
		return false
	}
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, response.Body)
	return response.StatusCode < 500
}
