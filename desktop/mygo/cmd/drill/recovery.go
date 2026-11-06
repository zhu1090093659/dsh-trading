package main

import (
	"errors"
	"fmt"
	"time"

	"github.com/egoist/mygo"

	"github.com/dshtrading/desktop-mygo/internal/recovery"
)

// runRecovery drives the host restart budget: it kills the host with SIGKILL,
// watches the shell restart it up to the budget, watches it park on the
// startup-problem page when the budget is spent, and then hands the budget back
// with the page's own Retry button.
func (d *drill) runRecovery() error {
	state, err := d.waitRendered()
	if err != nil {
		return err
	}
	d.recordPage(state)
	d.recordPresence(state, "present but not driven in recovery mode")
	d.check("guiRendered", state.ReadyState == "complete" && state.TextLen > 0)
	d.check("tokenFromHostLine", d.metrics().TokenWaitMs > 0)

	for attempt := 1; attempt <= recovery.Max; attempt++ {
		boots := d.metrics().Boots
		pid, err := d.killHost()
		if err != nil {
			return err
		}
		if err := d.waitGui(boots + 1); err != nil {
			return fmt.Errorf("attempt %d: the shell did not bring the GUI back: %w", attempt, err)
		}
		metrics := d.metrics()
		ok := metrics.RestartAttempt == attempt && metrics.Recoveries == attempt && !metrics.RestartBudgetSpent
		d.step(fmt.Sprintf("restart attempt %d/%d", attempt, recovery.Max), ok, fmt.Sprintf(
			"killed host pid %d; the shell started boot #%d (GUI URL in %dms) with restartAttempt=%d recoveries=%d spent=%v",
			pid, metrics.Boots, metrics.TokenWaitMs, metrics.RestartAttempt, metrics.Recoveries, metrics.RestartBudgetSpent))
		if !ok {
			return fmt.Errorf("attempt %d: restartAttempt=%d recoveries=%d spent=%v, want %d/%d/false",
				attempt, metrics.RestartAttempt, metrics.Recoveries, metrics.RestartBudgetSpent, attempt, attempt)
		}
	}

	// One kill past the budget: the shell must stop restarting and leave the
	// startup-problem page up.
	boots := d.metrics().Boots
	pid, err := d.killHost()
	if err != nil {
		return err
	}
	rendered, err := d.waitErrorPage()
	if err != nil {
		return fmt.Errorf("the budget-spent error page never appeared: %w", err)
	}
	settled := waitUntil(func() bool { return d.metrics().Boots == boots }, 4*time.Second)
	metrics := d.metrics()
	spent := settled && metrics.RestartBudgetSpent && metrics.RestartAttempt == recovery.Max+1
	d.step("budget spent", spent, fmt.Sprintf(
		"killed host pid %d; the error page says %s; boots stayed %d; restartAttempt=%d spent=%v",
		pid, quote(rendered.Message), metrics.Boots, metrics.RestartAttempt, metrics.RestartBudgetSpent))
	if !spent {
		return errors.New("the shell did not stop on the restart budget")
	}

	// Retry is a human decision: it hands the budget back, which the next kill
	// proves.
	boots = d.metrics().Boots
	clicked, err := d.eval(clickRetryJS)
	if err != nil {
		return err
	}
	if clicked != "clicked" {
		return errors.New("the error page's Retry button did not answer: " + clicked)
	}
	if err := d.waitGui(boots + 1); err != nil {
		return fmt.Errorf("Retry did not bring the GUI back: %w", err)
	}
	d.step("retry restarted the host", d.metrics().Boots == boots+1, fmt.Sprintf(
		"the page's Retry button started boot #%d", d.metrics().Boots))

	boots = d.metrics().Boots
	pid, err = d.killHost()
	if err != nil {
		return err
	}
	if err := d.waitGui(boots + 1); err != nil {
		return fmt.Errorf("the shell did not recover after Retry handed the budget back: %w", err)
	}
	after := d.metrics()
	recovered := after.RestartAttempt == 1 && !after.RestartBudgetSpent
	d.step("retry handed the budget back", recovered, fmt.Sprintf(
		"killed host pid %d; boot #%d; restartAttempt=%d recoveries=%d spent=%v",
		pid, after.Boots, after.RestartAttempt, after.Recoveries, after.RestartBudgetSpent))
	if !recovered {
		return errors.New("Retry did not hand the restart budget back")
	}

	d.check("restartBudget", recovered)
	mygo.App.Quit()
	<-time.After(exitWait)
	return errors.New("the app did not quit within " + exitWait.String())
}

// killHost ends the host process the shell started, the way an outside kill
// would: an outright kill straight at the pid, so no shutdown handler runs and
// the shell cannot mistake the exit for its own stop. The host is looked up by
// its command line through this machine's own process table (proctree.go), which
// is the same lookup on every platform.
func (d *drill) killHost() (int, error) {
	metrics := d.metrics()
	pattern := fmt.Sprintf("bin.js --profile trading-web --no-open --host 127.0.0.1 --port %d", metrics.Port)
	pids, err := findProcessesByCommandLine(pattern)
	if err != nil {
		return 0, fmt.Errorf("reading the process table for %q: %w", pattern, err)
	}
	if len(pids) == 0 {
		return 0, fmt.Errorf("no host process matched %q", pattern)
	}
	pid := pids[0]
	if err := killProcess(pid); err != nil {
		return 0, fmt.Errorf("killing host pid %d: %w", pid, err)
	}
	return pid, nil
}

// waitUntil reports whether condition came true within limit.
func waitUntil(condition func() bool, limit time.Duration) bool {
	deadline := time.Now().Add(limit)
	for {
		if condition() {
			return true
		}
		if time.Now().After(deadline) {
			return false
		}
		time.Sleep(100 * time.Millisecond)
	}
}
