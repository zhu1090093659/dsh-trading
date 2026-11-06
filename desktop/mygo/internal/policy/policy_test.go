package policy

import "testing"

func TestNavigationKeepsTheShellsOwnPages(t *testing.T) {
	for _, rawURL := range []string{
		"http://127.0.0.1:50929/",
		"http://127.0.0.1:50929/settings?tab=1#top",
		"http://127.0.0.1",
		"http://127.0.0.1/",
		"http://localhost:8888/",
		"http://localhost/",
		"https://127.0.0.1:50930/app",
		"http://LOCALHOST:8888/app",
		"file:///Users/zcl/page.html",
		"file:///tmp/splash.html",
	} {
		decision := Navigation(rawURL)
		if !decision.Allow || decision.External != "" {
			t.Errorf("Navigation(%q) = %+v, want allowed and no external", rawURL, decision)
		}
	}
}

func TestNavigationSendsTheOutsideWorldToTheBrowser(t *testing.T) {
	for _, rawURL := range []string{
		"https://example.com/",
		"http://example.com/docs",
		"http://127.0.0.1.example.com/",
		"http://localhost.example.com/",
		"http://127.0.0.1@example.com/",
		"https://example.com:8443/x?y=1",
	} {
		decision := Navigation(rawURL)
		if decision.Allow {
			t.Errorf("Navigation(%q) allowed, want blocked", rawURL)
		}
		if decision.External != rawURL {
			t.Errorf("Navigation(%q).External = %q, want the same URL", rawURL, decision.External)
		}
	}
}

func TestNavigationCancelsWhatItCannotHandOff(t *testing.T) {
	for _, rawURL := range []string{
		"about:blank",
		"javascript:alert(1)",
		"data:text/html,hello",
		"myapp://open",
		"",
		"not a url",
		"/settings",
	} {
		decision := Navigation(rawURL)
		if decision.Allow {
			t.Errorf("Navigation(%q) allowed, want blocked", rawURL)
		}
		if decision.External != "" {
			t.Errorf("Navigation(%q).External = %q, want none", rawURL, decision.External)
		}
	}
}

func TestWindowOpenNeverAllowsAWindow(t *testing.T) {
	for _, rawURL := range []string{
		"https://example.com/",
		"http://127.0.0.1:50929/",
		"http://127.0.0.1:50929",
		"about:blank",
		"file:///tmp/x.html",
		"",
	} {
		if decision := WindowOpen(rawURL); decision.Allow {
			t.Errorf("WindowOpen(%q) allowed, want deny", rawURL)
		}
	}
}

func TestWindowOpenHandsOnlyTheOutsideWorldOut(t *testing.T) {
	for _, rawURL := range []string{"https://example.com/a", "http://example.com", "http://localhost.example.com/"} {
		if decision := WindowOpen(rawURL); decision.External != rawURL {
			t.Errorf("WindowOpen(%q).External = %q, want the same URL", rawURL, decision.External)
		}
	}
	for _, rawURL := range []string{
		"http://127.0.0.1:50929/",
		"http://127.0.0.1:50929",
		"http://localhost:8888/x",
		"about:blank",
		"file:///tmp/x.html",
		"myapp://open",
		"",
	} {
		if decision := WindowOpen(rawURL); decision.External != "" {
			t.Errorf("WindowOpen(%q).External = %q, want none", rawURL, decision.External)
		}
	}
}

func TestPermissionIsNeverAllowed(t *testing.T) {
	cases := [][]string{
		nil,
		{},
		{"camera"},
		{"microphone"},
		{"geolocation"},
		{"notifications"},
		{"camera", "microphone"},
		{"notifications", "geolocation", "camera", "microphone"},
	}
	for _, requested := range cases {
		if PermissionAllowed(requested) {
			t.Errorf("PermissionAllowed(%v) = true, want false", requested)
		}
	}
}

func TestIsLoopbackRejectsLookalikes(t *testing.T) {
	for _, rawURL := range []string{
		"https://example.com/",
		"http://127.0.0.1.nip.io/",
		"http://localhost.evil/",
		"http://192.168.1.5:8888/",
		"ftp://127.0.0.1/",
		"file:///tmp/x.html",
		"",
	} {
		if IsLoopback(rawURL) {
			t.Errorf("IsLoopback(%q) = true, want false", rawURL)
		}
	}
	for _, rawURL := range []string{"http://127.0.0.1:1/", "https://localhost/", "http://localhost"} {
		if !IsLoopback(rawURL) {
			t.Errorf("IsLoopback(%q) = false, want true", rawURL)
		}
	}
}
