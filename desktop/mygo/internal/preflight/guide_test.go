package preflight

import (
	"errors"
	"strings"
	"testing"
)

func TestGuidanceNamesTheRuntimeAndThePageThatInstallsIt(t *testing.T) {
	p := Guidance()
	text := p.Message + "\n" + p.Detail
	for _, want := range []string{"WebView2", "Windows 10", "Windows 11", Download} {
		if !strings.Contains(text, want) {
			t.Errorf("the guidance reads %q, want it to name %q", text, want)
		}
	}
	if len(p.Buttons) != 3 {
		t.Fatalf("Buttons = %q, want one per action", p.Buttons)
	}
	if !strings.Contains(p.Buttons[ActionQuit], "Quit") {
		t.Errorf("Buttons[%d] = %q, want the quit button", ActionQuit, p.Buttons[ActionQuit])
	}
}

// session is one run of the guidance: the buttons the window reports in turn,
// and what its buttons asked of the machine.
type session struct {
	answers []int
	asks    int
	opens   []string
	copies  []string
	askErr  error
	openErr error
}

func (s *session) effects() Effects {
	return Effects{
		Ask: func(Prompt) (int, error) {
			s.asks++
			if s.askErr != nil {
				return 0, s.askErr
			}
			if len(s.answers) == 0 {
				return ActionQuit, nil
			}
			answer := s.answers[0]
			s.answers = s.answers[1:]
			return answer, nil
		},
		Open: func(url string) error {
			if s.openErr != nil {
				return s.openErr
			}
			s.opens = append(s.opens, url)
			return nil
		},
		Copy: func(text string) error {
			s.copies = append(s.copies, text)
			return nil
		},
	}
}

func TestRunOpensTheDownloadPageAndKeepsTheWindowUp(t *testing.T) {
	s := &session{answers: []int{ActionOpen, ActionQuit}}
	if err := Run(s.effects()); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if len(s.opens) != 1 || s.opens[0] != Download {
		t.Errorf("opened %q, want the download address %q", s.opens, Download)
	}
	if s.asks != 2 {
		t.Errorf("the window was shown %d times, want 2: it comes back after opening the page", s.asks)
	}
	if len(s.copies) != 0 {
		t.Errorf("copied %q, want nothing", s.copies)
	}
}

func TestRunCopiesTheAddressAndKeepsTheWindowUp(t *testing.T) {
	s := &session{answers: []int{ActionCopy, ActionQuit}}
	if err := Run(s.effects()); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if len(s.copies) != 1 || s.copies[0] != Download {
		t.Errorf("copied %q, want the download address %q", s.copies, Download)
	}
	if s.asks != 2 {
		t.Errorf("the window was shown %d times, want 2: it comes back after copying the address", s.asks)
	}
	if len(s.opens) != 0 {
		t.Errorf("opened %q, want nothing", s.opens)
	}
}

func TestRunEndsWhenTheWindowIsClosed(t *testing.T) {
	s := &session{answers: []int{-1}}
	if err := Run(s.effects()); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if len(s.opens) != 0 || len(s.copies) != 0 {
		t.Errorf("opened %q and copied %q, want nothing: the window was closed", s.opens, s.copies)
	}
	if s.asks != 1 {
		t.Errorf("the window was shown %d times, want 1", s.asks)
	}
}

func TestRunReportsAFailureAndKeepsTheWindowUp(t *testing.T) {
	s := &session{answers: []int{ActionOpen, ActionQuit}, openErr: errors.New("no browser")}
	err := Run(s.effects())
	if err == nil || !strings.Contains(err.Error(), "no browser") {
		t.Fatalf("Run = %v, want the failure of opening the page", err)
	}
	if s.asks != 2 {
		t.Errorf("the window was shown %d times, want 2: a button that fails does not end it", s.asks)
	}
}

func TestRunReportsAWindowThatCannotShow(t *testing.T) {
	s := &session{askErr: errors.New("no task dialog")}
	err := Run(s.effects())
	if err == nil || !strings.Contains(err.Error(), "no task dialog") {
		t.Fatalf("Run = %v, want the failure of showing the window", err)
	}
	if s.asks != 1 {
		t.Errorf("the window was shown %d times, want 1", s.asks)
	}
}
