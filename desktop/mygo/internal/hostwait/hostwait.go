// Package hostwait is the shell's view of a booting host's output: the tokenized
// GUI URL the host prints on its "dsh web: " line.
//
// The URL belongs to one host process, so a recovery has to start from none at
// all. Reusing the previous boot's line loads a port nobody serves — measured on
// the Electron shell 2026-10-15: ERR_CONNECTION_REFUSED on the dead host's port
// while the restarted one was serving another.
package hostwait

import (
	"errors"
	"sync"
	"time"

	"github.com/dshtrading/desktop-mygo/internal/launch"
)

// PollInterval is how often Wait looks for the URL.
const PollInterval = 50 * time.Millisecond

// URLWaiter keeps the tokenized URL of the host that is booting now.
type URLWaiter struct {
	mu  sync.Mutex
	url string
}

// Reset forgets the previous host's URL. Every boot starts with it.
func (w *URLWaiter) Reset() {
	w.mu.Lock()
	w.url = ""
	w.mu.Unlock()
}

// Observe takes the URL out of one host output line, if it carries one.
func (w *URLWaiter) Observe(line string) {
	parsed, ok := launch.ParseTokenURL(line)
	if !ok {
		return
	}
	w.mu.Lock()
	w.url = parsed
	w.mu.Unlock()
}

// URL is the URL the current host printed, or "".
func (w *URLWaiter) URL() string {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.url
}

// Wait blocks until the current host prints its URL. exited is closed when that
// host is gone, so a host that dies before printing fails the wait instead of
// hanging it.
func (w *URLWaiter) Wait(exited <-chan struct{}, timeout time.Duration) (string, error) {
	expired := time.NewTimer(timeout)
	defer expired.Stop()
	ticker := time.NewTicker(PollInterval)
	defer ticker.Stop()
	for {
		if url := w.URL(); url != "" {
			return url, nil
		}
		select {
		case <-exited:
			return "", errors.New("the dsh host exited before it printed its tokenized GUI URL")
		case <-expired.C:
			return "", errors.New("timed out after " + timeout.String() + " waiting for the host to print its tokenized GUI URL")
		case <-ticker.C:
		}
	}
}
