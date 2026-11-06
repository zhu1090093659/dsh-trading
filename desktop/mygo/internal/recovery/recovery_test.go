package recovery

import (
	"testing"
	"time"
)

// at returns a fixed instant, offset from a fixed start by minutes.
func at(minutes int) time.Time {
	return time.Date(2026, 11, 6, 12, 0, 0, 0, time.UTC).Add(time.Duration(minutes) * time.Minute)
}

func TestBudgetRecoversThreeTimesThenStops(t *testing.T) {
	budget := NewBudget()
	for attempt := 1; attempt <= Max; attempt++ {
		plan := budget.Record(at(attempt))
		if !plan.Recover {
			t.Fatalf("attempt %d: Recover = false, want true", attempt)
		}
		if plan.Attempt != attempt {
			t.Errorf("attempt = %d, want %d", plan.Attempt, attempt)
		}
		if plan.Max != Max || plan.Window != Window {
			t.Errorf("plan budget = %d/%s, want %d/%s", plan.Max, plan.Window, Max, Window)
		}
	}
	plan := budget.Record(at(Max + 1))
	if plan.Recover {
		t.Fatalf("attempt %d: Recover = true, want the budget spent", plan.Attempt)
	}
	if plan.Attempt != Max+1 {
		t.Errorf("attempt = %d, want %d", plan.Attempt, Max+1)
	}
	if len(plan.ExitTimes) != Max+1 {
		t.Errorf("carried %d exits, want %d", len(plan.ExitTimes), Max+1)
	}
}

func TestBudgetForgetsExitsThatSlidOutOfTheWindow(t *testing.T) {
	budget := NewBudget()
	budget.Record(at(0)) // long before the ones that matter
	plan := budget.Record(at(int(Window/time.Minute) + 1))
	if plan.Attempt != 1 {
		t.Fatalf("attempt = %d, want 1: the older exit slid out of the window", plan.Attempt)
	}
	if budget.Pending() != 1 {
		t.Errorf("pending = %d, want 1", budget.Pending())
	}
}

func TestBudgetKeepsAnExitAtTheWindowEdge(t *testing.T) {
	// A nanosecond inside the window still counts (the JS filter is
	// now - t < window).
	budget := NewBudget()
	budget.Record(at(0))
	if plan := budget.Record(at(0).Add(Window - time.Nanosecond)); plan.Attempt != 2 {
		t.Fatalf("attempt = %d, want 2", plan.Attempt)
	}
	// Exactly Window ago is already outside.
	edge := NewBudget()
	edge.Record(at(0))
	if plan := edge.Record(at(0).Add(Window)); plan.Attempt != 1 {
		t.Fatalf("attempt = %d, want 1: an exit exactly Window old is outside", plan.Attempt)
	}
}

func TestResetHandsTheBudgetBack(t *testing.T) {
	budget := NewBudget()
	for i := 1; i <= Max+1; i++ {
		budget.Record(at(i))
	}
	if budget.Pending() != Max+1 {
		t.Fatalf("pending = %d, want %d", budget.Pending(), Max+1)
	}
	budget.Reset()
	if budget.Pending() != 0 {
		t.Fatalf("pending after reset = %d, want 0", budget.Pending())
	}
	plan := budget.Record(at(Max + 2))
	if !plan.Recover || plan.Attempt != 1 {
		t.Fatalf("after reset: recover=%v attempt=%d, want true/1", plan.Recover, plan.Attempt)
	}
}

func TestWindowShortNamesTheWindowForTheLogLine(t *testing.T) {
	plan := NewBudget().Record(at(0))
	if got, want := plan.WindowShort(), "10min"; got != want {
		t.Errorf("WindowShort = %q, want %q", got, want)
	}
}
