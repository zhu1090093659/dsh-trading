package shell

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// desktopBridge is the page-side contract this shell rebuilds: the member the
// page calls, and the bound Go method behind it, as desktop/src/preload.cjs
// exposes them.
var desktopBridge = map[string]string{
	"retry":                "Retry",
	"revealLog":            "RevealLog",
	"openVCRedistDownload": "OpenVCRedistDownload",
	"quit":                 "Quit",
	"relaunch":             "Relaunch",
}

func TestBridgeShimExposesTheSevenMembers(t *testing.T) {
	for member, method := range desktopBridge {
		want := member + ": call('" + method + "')"
		if !strings.Contains(bridgeShim, want) {
			t.Errorf("bridgeShim has no %q", want)
		}
	}
	for _, want := range []string{
		"onStatus: listen('desktop:status')",
		"onError: listen('desktop:error')",
		"window.mygo.call('Desktop.' + method)",
	} {
		if !strings.Contains(bridgeShim, want) {
			t.Errorf("bridgeShim has no %q", want)
		}
	}
}

func TestBridgeBoundMethodsExist(t *testing.T) {
	typ := reflect.TypeOf(desktopService{})
	for member, method := range desktopBridge {
		if _, ok := typ.MethodByName(method); !ok {
			t.Errorf("desktopService has no %s method behind window.desktop.%s", method, member)
		}
	}
	// The renderer log agent rides the same service but is not one of the seven
	// members the page contract names.
	if _, ok := typ.MethodByName("RendererLog"); !ok {
		t.Error("desktopService has no RendererLog method for the preload log agent")
	}
}

func TestBridgeShimCarriesTheRendererLogAgent(t *testing.T) {
	// mygo has no console-message hook, so these carry the page's own errors and
	// the two console levels the host log wants.
	for _, want := range []string{
		"'Desktop.RendererLog'",
		"console.error = function",
		"console.warn = function",
		"addEventListener('error'",
		"addEventListener('unhandledrejection'",
		"preload error: ",
	} {
		if !strings.Contains(bridgeShim, want) {
			t.Errorf("bridgeShim has no %q", want)
		}
	}
}

func TestNewBindsTheDesktopService(t *testing.T) {
	// Binding panics on a type mygo cannot carry, or on a name already taken:
	// this is where both would surface instead of at startup. Only one test may
	// call New, since a service name can be bound once.
	if shell := New(Options{}); shell == nil {
		t.Fatal("New returned nil")
	}
}

func TestBridgeEventsMatchTheShim(t *testing.T) {
	if got, want := statusEvent.Name(), "desktop:status"; got != want {
		t.Errorf("status event = %q, want %q", got, want)
	}
	if got, want := errorEvent.Name(), "desktop:error"; got != want {
		t.Errorf("error event = %q, want %q", got, want)
	}
}

func TestErrorPayloadCarriesWhatThePageRenders(t *testing.T) {
	blob, err := json.Marshal(ErrorPayload{Message: "boom", Log: "line", LogFile: "/tmp/dsh-host.log", IsMissingVCRedist: true})
	if err != nil {
		t.Fatalf("Marshal err = %v", err)
	}
	var payload map[string]any
	if err := json.Unmarshal(blob, &payload); err != nil {
		t.Fatalf("Unmarshal err = %v", err)
	}
	for _, key := range []string{"message", "log", "logFile", "isMissingVCRedist"} {
		if _, ok := payload[key]; !ok {
			t.Errorf("payload has no %q: %s", key, blob)
		}
	}
}

func TestSplashPageSubscribesToTheStatusBridge(t *testing.T) {
	for _, want := range []string{`id="status"`, "window.desktop.onStatus", "Starting", "__dshShellPage = 'splash'"} {
		if !strings.Contains(splashPage, want) {
			t.Errorf("splashPage has no %q", want)
		}
	}
}

func TestErrorPageWiresItsFourActions(t *testing.T) {
	for _, want := range []string{
		`id="retry"`, `id="reveal"`, `id="quit"`, `id="vcredist"`,
		"window.desktop.retry()",
		"window.desktop.revealLog()",
		"window.desktop.quit()",
		"window.desktop.openVCRedistDownload()",
		"window.desktop.onError",
		"__dshShellPage = 'error'",
	} {
		if !strings.Contains(errorPage, want) {
			t.Errorf("errorPage has no %q", want)
		}
	}
}

func TestInstallHostHooksWritesThemInImportOrder(t *testing.T) {
	dir := t.TempDir()
	paths, err := installHostHooks(dir)
	if err != nil {
		t.Fatalf("installHostHooks err = %v", err)
	}
	want := []string{"host-symbol-normalizer.mjs", "host-exit-tracer.mjs", "host-orphan-guard.mjs"}
	if len(paths) != len(want) {
		t.Fatalf("paths = %v, want %v", paths, want)
	}
	for i, name := range want {
		if filepath.Base(paths[i]) != name {
			t.Errorf("path[%d] = %q, want %q", i, paths[i], name)
		}
		info, err := os.Stat(paths[i])
		if err != nil {
			t.Fatalf("Stat(%q) err = %v", paths[i], err)
		}
		if info.Size() == 0 {
			t.Errorf("%q is empty", paths[i])
		}
	}
	// The guard imports the tracer's prefix beside it, and both are gated on
	// the shell pid the launcher sets: the hooks describe one host lifetime.
	guard, err := os.ReadFile(paths[2])
	if err != nil {
		t.Fatalf("ReadFile err = %v", err)
	}
	if !strings.Contains(string(guard), "./host-exit-tracer.mjs") {
		t.Error("the orphan guard no longer imports the exit tracer's prefix")
	}
	if !strings.Contains(string(guard), "DSH_DESKTOP_SHELL_PID") {
		t.Error("the orphan guard no longer watches DSH_DESKTOP_SHELL_PID")
	}
	tracer, err := os.ReadFile(paths[1])
	if err != nil {
		t.Fatalf("ReadFile err = %v", err)
	}
	if !strings.Contains(string(tracer), "[host-lifecycle]") {
		t.Error("the exit tracer lost its lifecycle prefix")
	}
}
