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
		Hooks:    hooks,
		Port:     51999,
		Home:     filepath.Join(t.TempDir(), "mygo-home-trading"),
		ShellPID: 4242,
		ParentEnv: []string{
			"PATH=/usr/bin:/bin",
			"HOME=" + filepath.Join(t.TempDir(), "user"),
			"DSH_HOME=" + filepath.Join(t.TempDir(), "host-home"),
			"ELECTRON_RUN_AS_NODE=1",
		},
	}
}

func TestArgsCarryTheProfileThePortAndTheHooks(t *testing.T) {
	hooks := []string{
		filepath.Join(t.TempDir(), "host-symbol-normalizer.mjs"),
		filepath.Join(t.TempDir(), "host-orphan-guard.mjs"),
	}
	host := spec(t, hooks)
	want := []string{
		"--max-http-header-size=65536",
		"--import", FileURL(hooks[0]),
		"--import", FileURL(hooks[1]),
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
		HomeEnv:     host.Home,
		ShellPIDEnv: "4242",
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
	parentHome, _ := lookupEnv(host.ParentEnv, "HOME")
	if got, _ := lookupEnv(env, "HOME"); got != parentHome {
		t.Errorf("env dropped the parent HOME: %q", got)
	}
}

func TestEnvAppendsADshHomeThatTheParentDidNotSet(t *testing.T) {
	host := spec(t, nil)
	host.ParentEnv = []string{"PATH=/usr/bin"}
	env := host.Env()
	if got, _ := lookupEnv(env, HomeEnv); got != host.Home {
		t.Errorf("env %s = %q, want the resolved home", HomeEnv, got)
	}
}

func TestFileURLUsesTheTargetPlatformsShape(t *testing.T) {
	// A file URL keeps forward slashes on every platform, and a Windows drive
	// path needs the leading slash that makes C:/… the URL path.
	cases := []struct{ goos, path, want string }{
		{"darwin", "/tmp/my hooks/a b.mjs", "file:///tmp/my%20hooks/a%20b.mjs"},
		{"windows", `C:\tmp\my hooks\a b.mjs`, "file:///C:/tmp/my%20hooks/a%20b.mjs"},
	}
	for _, c := range cases {
		if got := fileURLFor(c.goos, c.path); got != c.want {
			t.Errorf("fileURLFor(%q, %q) = %q, want %q", c.goos, c.path, got, c.want)
		}
	}
}

func TestDirIsTheHostsHome(t *testing.T) {
	host := spec(t, nil)
	if got := host.Dir(); got != host.Home {
		t.Errorf("Dir = %q, want the host home %q", got, host.Home)
	}
}

func TestEnvForWindowsPutsTheBundledNodeFirstInBothPathSpellings(t *testing.T) {
	host := spec(t, nil)
	// A Windows environment block spells the variable in either case; the parent
	// used Path, and the inherited entries must survive the prefix.
	host.ParentEnv = []string{"Path=C:\\Windows\\system32", "HOME=C:\\Users\\zcl"}
	env := host.envFor("windows")
	want := nodeBinDir("windows", host.Paths.NodeHome) + ";" + "C:\\Windows\\system32"
	for _, name := range []string{"PATH", "Path"} {
		got, ok := lookupEnv(env, name)
		if !ok {
			t.Fatalf("env has no %s: %v", name, env)
		}
		if got != want {
			t.Errorf("env %s = %q, want %q", name, got, want)
		}
	}
	// The same decision on a unix host: node/bin, colon separated, one spelling.
	host.ParentEnv = []string{"PATH=/usr/bin:/bin"}
	unix := host.envFor("darwin")
	wantUnix := nodeBinDir("darwin", host.Paths.NodeHome) + ":/usr/bin:/bin"
	if got, ok := lookupEnv(unix, "PATH"); !ok || got != wantUnix {
		t.Errorf("env PATH = %q (present %v), want %q", got, ok, wantUnix)
	}
	if _, ok := lookupEnv(unix, "Path"); ok {
		t.Errorf("env has a Path entry on a unix host: %v", unix)
	}
}

func TestEnvForWindowsKeepsTheHomeAndTheShellPID(t *testing.T) {
	host := spec(t, nil)
	env := host.envFor("windows")
	want := map[string]string{
		HomeEnv:     host.Home,
		ShellPIDEnv: "4242",
		"PATH":      nodeBinDir("windows", host.Paths.NodeHome) + ";" + "/usr/bin:/bin",
		"Path":      nodeBinDir("windows", host.Paths.NodeHome) + ";" + "/usr/bin:/bin",
	}
	for key, value := range want {
		if got, ok := lookupEnv(env, key); !ok || got != value {
			t.Errorf("env %s = %q (present %v), want %q", key, got, ok, value)
		}
	}
}
