package launch

import (
	"path/filepath"
	"strings"
	"testing"
)

// spec returns a host spec for a fixed payload, port and home.
func spec(t *testing.T, hooks []string) HostSpec {
	t.Helper()
	root := t.TempDir()
	return HostSpec{
		Paths: RuntimePaths{
			Root:     filepath.Join(root, "runtime"),
			NodeHome: filepath.Join(root, "runtime", "node"),
			NodeBin:  filepath.Join(root, "runtime", "node", "bin", "node"),
			HostBin:  filepath.Join(root, "runtime", "host", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"),
		},
		Hooks:     hooks,
		Port:      51999,
		Home:      "/tmp/mygo-home-trading",
		ShellPID:  4242,
		ParentEnv: []string{"PATH=/usr/bin:/bin", "HOME=/Users/zcl", "DSH_HOME=/Users/zcl/.dsh", "ELECTRON_RUN_AS_NODE=1"},
	}
}

func TestArgsCarryTheProfileThePortAndTheHooks(t *testing.T) {
	host := spec(t, []string{"/tmp/hooks/host-symbol-normalizer.mjs", "/tmp/hooks/host-orphan-guard.mjs"})
	want := []string{
		"--max-http-header-size=65536",
		"--import", "file:///tmp/hooks/host-symbol-normalizer.mjs",
		"--import", "file:///tmp/hooks/host-orphan-guard.mjs",
		host.Paths.HostBin,
		"--profile", "trading-web",
		"--no-open",
		"--host", "127.0.0.1",
		"--port", "51999",
	}
	got := host.Args()
	if len(got) != len(want) {
		t.Fatalf("Args() = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("Args()[%d] = %q, want %q", i, got[i], want[i])
		}
	}
}

func TestArgsWithoutHooksSkipTheImports(t *testing.T) {
	got := spec(t, nil).Args()
	for _, arg := range got {
		if arg == "--import" {
			t.Fatalf("Args() = %v, want no --import", got)
		}
	}
	if got[0] != "--max-http-header-size=65536" {
		t.Errorf("Args()[0] = %q, want the header budget first", got[0])
	}
}

func TestEnvSetsTheShellOwnedHomeAndTheGuardedShellPID(t *testing.T) {
	host := spec(t, nil)
	env := host.Env()
	want := map[string]string{
		HomeEnv:     "/tmp/mygo-home-trading",
		ShellPIDEnv: "4242",
		"PATH":      filepath.Join(host.Paths.NodeHome, "bin") + ":/usr/bin:/bin",
	}
	for key, value := range want {
		got, ok := lookupEnv(env, key)
		if !ok {
			t.Fatalf("env has no %s: %v", key, env)
		}
		if got != value {
			t.Errorf("env %s = %q, want %q", key, got, value)
		}
	}
	if _, ok := lookupEnv(env, "ELECTRON_RUN_AS_NODE"); ok {
		t.Error("env still carries ELECTRON_RUN_AS_NODE")
	}
	if count := strings.Count(strings.Join(env, "\n"), HomeEnv+"="); count != 1 {
		t.Errorf("env carries %d %s entries, want 1", count, HomeEnv)
	}
	if got, _ := lookupEnv(env, "HOME"); got != "/Users/zcl" {
		t.Errorf("env dropped the parent HOME: %q", got)
	}
}

func TestEnvAppendsADshHomeThatTheParentDidNotSet(t *testing.T) {
	host := spec(t, nil)
	host.ParentEnv = []string{"PATH=/usr/bin"}
	env := host.Env()
	if got, _ := lookupEnv(env, HomeEnv); got != "/tmp/mygo-home-trading" {
		t.Errorf("env %s = %q, want the resolved home", HomeEnv, got)
	}
}

func TestFileURLEscapesThePath(t *testing.T) {
	got := FileURL("/tmp/my hooks/a b.mjs")
	if got != "file:///tmp/my%20hooks/a%20b.mjs" {
		t.Errorf("FileURL = %q, want an escaped file URL", got)
	}
}

func TestDirIsTheHostsHome(t *testing.T) {
	if got := spec(t, nil).Dir(); got != "/tmp/mygo-home-trading" {
		t.Errorf("Dir = %q, want the host home", got)
	}
}
