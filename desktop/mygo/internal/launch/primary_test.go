package launch

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// payload makes dir a primary-runtime payload: a directory holding runtime.json.
func payload(t *testing.T, dir string) string {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("MkdirAll(%s) err = %v", dir, err)
	}
	if err := os.WriteFile(filepath.Join(dir, primaryRuntimeManifest), []byte("{}"), 0o644); err != nil {
		t.Fatalf("writing %s err = %v", filepath.Join(dir, primaryRuntimeManifest), err)
	}
	return dir
}

func TestResolvePrimaryRuntimeUsesTheStagedPayloadFirst(t *testing.T) {
	root := t.TempDir()
	runtimeRoot := filepath.Join(root, "runtime")
	staged := payload(t, filepath.Join(runtimeRoot, "primary-runtime"))
	// A payload in the home must lose against the staged one.
	payload(t, filepath.Join(root, "home", "dsh-runtimes", "dsh-primary-runtime"))

	resolved := ResolvePrimaryRuntime(runtimeRoot, filepath.Join(root, "home"))
	if resolved.Path != staged {
		t.Errorf("ResolvePrimaryRuntime = %q, want the staged %q", resolved.Path, staged)
	}
	if !resolved.Enabled() {
		t.Error("Enabled() = false, want the resolved payload enabled")
	}
}

func TestResolvePrimaryRuntimeFallsBackToTheTradingHome(t *testing.T) {
	root := t.TempDir()
	home := filepath.Join(root, "home", ".dsh-trading")
	homePayload := payload(t, filepath.Join(home, "dsh-runtimes", "dsh-primary-runtime"))

	resolved := ResolvePrimaryRuntime(filepath.Join(root, "runtime"), home)
	if resolved.Path != homePayload {
		t.Errorf("ResolvePrimaryRuntime = %q, want the home payload %q", resolved.Path, homePayload)
	}
}

func TestResolvePrimaryRuntimeKeepsTheCapabilityAbsent(t *testing.T) {
	root := t.TempDir()
	// A directory named like a payload but holding no runtime.json is not one.
	empty := filepath.Join(root, "runtime", "primary-runtime")
	if err := os.MkdirAll(empty, 0o755); err != nil {
		t.Fatalf("MkdirAll err = %v", err)
	}
	if err := os.WriteFile(filepath.Join(empty, "not-runtime.json"), []byte("{}"), 0o644); err != nil {
		t.Fatalf("writing the decoy err = %v", err)
	}

	resolved := ResolvePrimaryRuntime(filepath.Join(root, "runtime"), filepath.Join(root, "home"))
	if resolved.Enabled() {
		t.Errorf("ResolvePrimaryRuntime.Path = %q, want no payload", resolved.Path)
	}
	if got := resolved.LogValue(); got != AbsentPrimaryRuntime {
		t.Errorf("LogValue() = %q, want the explicit absence %q", got, AbsentPrimaryRuntime)
	}
}

func TestResolvePrimaryRuntimeNeverReachesAcrossHomes(t *testing.T) {
	root := t.TempDir()
	home := filepath.Join(root, "home", ".dsh-trading")
	// The host instance's own home carries a payload; the trading home does not.
	payload(t, filepath.Join(root, "home", ".dsh", "dsh-runtimes", "dsh-primary-runtime"))

	resolved := ResolvePrimaryRuntime(filepath.Join(root, "runtime"), home)
	if resolved.Enabled() {
		t.Errorf("ResolvePrimaryRuntime.Path = %q, want the host ~/.dsh payload left alone", resolved.Path)
	}
}

func TestLogValueSaysWhatHappensToAnInheritedVariable(t *testing.T) {
	inherited := ResolvePrimaryRuntime("/nonexistent/runtime", "/nonexistent/home").WithInherited(" /opt/dsh-primary-runtime ")
	if got := inherited.Path; got != "" {
		t.Errorf("Path = %q, want none", got)
	}
	logged := inherited.LogValue()
	if !strings.Contains(logged, "absent") || !strings.Contains(logged, PrimaryRuntimeEnv+"=/opt/dsh-primary-runtime") {
		t.Errorf("LogValue() = %q, want the absence and the inherited value", logged)
	}
	if strings.TrimSpace(inherited.Inherited) != "/opt/dsh-primary-runtime" {
		t.Errorf("Inherited = %q, want the value trimmed", inherited.Inherited)
	}
	resolved := payload(t, filepath.Join(t.TempDir(), "primary-runtime"))
	host := ResolvePrimaryRuntime(filepath.Dir(resolved), filepath.Join(t.TempDir(), "home"))
	if got := host.LogValue(); got != resolved {
		t.Errorf("LogValue() = %q, want the payload path %q", got, resolved)
	}
}

func TestEnvAnnouncesTheResolvedPayloadOnly(t *testing.T) {
	host := spec(t, nil)
	resolved := payload(t, filepath.Join(host.Paths.Root, "primary-runtime"))
	host.PrimaryRuntime = resolved
	if got, ok := lookupEnv(host.Env(), PrimaryRuntimeEnv); !ok || got != resolved {
		t.Errorf("env %s = %q (present %v), want %q", PrimaryRuntimeEnv, got, ok, resolved)
	}
}

func TestEnvLeavesTheCapabilityAbsentWithoutAPayload(t *testing.T) {
	host := spec(t, nil)
	host.PrimaryRuntime = ""
	env := host.Env()
	for _, key := range []string{PrimaryRuntimeEnv, "DSH_BUNDLED_PRIMARY_RUNTIME"} {
		if value, ok := lookupEnv(env, key); ok {
			t.Errorf("env carries %s=%q, want the capability explicitly absent instead of a fallback", key, value)
		}
	}
}

func TestEnvPassesAnInheritedPayloadThrough(t *testing.T) {
	host := spec(t, nil)
	host.ParentEnv = append(host.ParentEnv, PrimaryRuntimeEnv+"=/opt/dsh-primary-runtime")
	// The shell resolved none of its own, so it does not overwrite what the user
	// exported: the document says exporting the variable enables the rows.
	if got, _ := lookupEnv(host.Env(), PrimaryRuntimeEnv); got != "/opt/dsh-primary-runtime" {
		t.Errorf("env %s = %q, want the inherited value kept", PrimaryRuntimeEnv, got)
	}
}
