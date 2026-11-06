package attach

import (
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// env returns a getenv that knows one variable.
func env(key, value string) func(string) string {
	return func(name string) string {
		if name == key {
			return value
		}
		return ""
	}
}

func TestDecideHandsOffWhenAGUIAnswers(t *testing.T) {
	probed := ""
	decision := Decide(env("", ""), func(url string) bool {
		probed = url
		return true
	})
	if !decision.Attach {
		t.Fatalf("Attach = false, want true (%s)", decision.Reason)
	}
	if decision.URL != DefaultGUIURL {
		t.Errorf("URL = %q, want %q", decision.URL, DefaultGUIURL)
	}
	if probed != DefaultGUIURL {
		t.Errorf("probed %q, want %q", probed, DefaultGUIURL)
	}
}

func TestDecideStartsAHostWhenNothingAnswers(t *testing.T) {
	decision := Decide(env("", ""), func(string) bool { return false })
	if decision.Attach {
		t.Fatalf("Attach = true, want false (%s)", decision.Reason)
	}
	if decision.URL != "" {
		t.Errorf("URL = %q, want empty", decision.URL)
	}
}

func TestDecideSkipsTheProbeWhenNoAttachIsSet(t *testing.T) {
	probeCalled := false
	for _, value := range []string{"1", "yes", " true "} {
		decision := Decide(env(NoAttachEnv, value), func(string) bool {
			probeCalled = true
			return true
		})
		if decision.Attach {
			t.Fatalf("%s=%q: Attach = true, want false", NoAttachEnv, value)
		}
	}
	if probeCalled {
		t.Errorf("probe ran although %s was set", NoAttachEnv)
	}
}

func TestProbeHTTPAcceptsAnyAnswerBelow500(t *testing.T) {
	for _, status := range []int{http.StatusOK, http.StatusUnauthorized, http.StatusForbidden, http.StatusNotFound, http.StatusInternalServerError} {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(status)
		}))
		got := ProbeHTTP(server.URL, time.Second)
		server.Close()
		want := status < 500
		if got != want {
			t.Errorf("ProbeHTTP(%d) = %v, want %v", status, got, want)
		}
	}
}

func TestProbeHTTPReportsNothingListening(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("Listen err = %v", err)
	}
	address := listener.Addr().String()
	listener.Close()
	if ProbeHTTP("http://"+address+"/", 300*time.Millisecond) {
		t.Error("ProbeHTTP = true for a closed port, want false")
	}
}
