// Package recovery is the shell's host restart budget: how many unexpected host
// exits it restarts through before it parks on the startup-problem page. It is
// the Go counterpart of desktop/src/runtime.cjs:planHostRecovery.
package recovery

import (
	"strconv"
	"sync"
	"time"
)

const (
	// Max is how many unexpected exits the shell restarts through inside one
	// window before it stops and leaves the error page up.
	Max = 3
	// Window is the period the exits are counted in: a crash an hour ago is not
	// evidence about this one.
	Window = 10 * time.Minute
)

// Plan is one decision, plus the exits the shell carries forward.
type Plan struct {
	// Recover reports whether the shell may start the host again.
	Recover bool
	// Attempt is this exit's place in the window, 1 for the first.
	Attempt int
	// ExitTimes are the exits inside the window, this one included.
	ExitTimes []time.Time
	// Max and Window are the budget this decision applied.
	Max    int
	Window time.Duration
}

// WindowShort renders the window the way the log line says it.
func (p Plan) WindowShort() string {
	minutes := int(p.Window / time.Minute)
	if minutes <= 0 {
		return p.Window.String()
	}
	return strconv.Itoa(minutes) + "min"
}

// Budget counts the unexpected host exits the shell has restarted through. The
// zero value is not usable; call NewBudget.
type Budget struct {
	mu        sync.Mutex
	exitTimes []time.Time
}

// NewBudget returns an empty budget.
func NewBudget() *Budget { return &Budget{} }

// Record adds one unexpected exit and reports whether to restart the host. A
// human Retry calls Reset, which hands the budget back.
func (b *Budget) Record(now time.Time) Plan {
	b.mu.Lock()
	defer b.mu.Unlock()
	kept := make([]time.Time, 0, len(b.exitTimes)+1)
	for _, exit := range b.exitTimes {
		if now.Sub(exit) < Window {
			kept = append(kept, exit)
		}
	}
	kept = append(kept, now)
	b.exitTimes = kept
	attempt := len(kept)
	return Plan{
		Recover:   attempt <= Max,
		Attempt:   attempt,
		ExitTimes: append([]time.Time(nil), kept...),
		Max:       Max,
		Window:    Window,
	}
}

// Reset forgets every exit: the page's Retry is a human decision and gets the
// budget back.
func (b *Budget) Reset() {
	b.mu.Lock()
	b.exitTimes = nil
	b.mu.Unlock()
}

// Pending is how many exits the budget currently holds.
func (b *Budget) Pending() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return len(b.exitTimes)
}
