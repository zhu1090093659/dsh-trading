package cohort

import (
	"os"
	"path/filepath"
	"testing"
)

// writePackage makes a directory a package, the one thing the walk reads.
func writePackage(t *testing.T, dir string) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("MkdirAll(%s) err = %v", dir, err)
	}
	if err := os.WriteFile(filepath.Join(dir, "package.json"), []byte("{}"), 0o644); err != nil {
		t.Fatalf("writing %s/package.json err = %v", dir, err)
	}
}

// realPath resolves a link chain for assertions.
func realPath(t *testing.T, path string) string {
	t.Helper()
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		t.Fatalf("EvalSymlinks(%s) err = %v", path, err)
	}
	return resolved
}

func TestNormalizeRelinksCorePackagesOntoTheBundledRuntime(t *testing.T) {
	dir := t.TempDir()
	bundled := filepath.Join(dir, "runtime", "node_modules")
	foreign := filepath.Join(dir, "foreign")
	profile := filepath.Join(dir, "profiles", "trading-web")
	core := filepath.Join(profile, "node_modules", Scope)
	for _, name := range []string{"dsh-scope", "dsh-tools", "dsh-agent-presets"} {
		writePackage(t, filepath.Join(bundled, Scope, name))
	}
	writePackage(t, filepath.Join(foreign, "dsh-scope"))

	if err := os.MkdirAll(core, 0o755); err != nil {
		t.Fatalf("MkdirAll(%s) err = %v", core, err)
	}
	// Already single-instance: stays untouched.
	if err := os.Symlink(filepath.Join(bundled, Scope, "dsh-scope"), filepath.Join(core, "dsh-scope")); err != nil {
		t.Fatalf("symlink err = %v", err)
	}
	// A foreign install's link and a materialized copy: both relinked.
	if err := os.Symlink(filepath.Join(foreign, "dsh-scope"), filepath.Join(core, "dsh-tools")); err != nil {
		t.Fatalf("symlink err = %v", err)
	}
	writePackage(t, filepath.Join(core, "dsh-agent-presets"))
	// A package the bundled runtime does not ship: survives.
	writePackage(t, filepath.Join(core, "dsh-future"))
	// A nested shadow copy under a real package tree: relinked too.
	writePackage(t, filepath.Join(profile, "node_modules", "@dshtrading", "knowledge", "node_modules", Scope, "dsh-tools"))
	// A symlinked package tree belongs to another install: never rewritten.
	linkedTree := filepath.Join(dir, "linked-package")
	writePackage(t, filepath.Join(linkedTree, "node_modules", Scope, "dsh-tools"))
	if err := os.Symlink(linkedTree, filepath.Join(profile, "node_modules", "@dshtrading", "linked")); err != nil {
		t.Fatalf("symlink err = %v", err)
	}

	var logged []string
	result := Normalize(profile, bundled, func(line string) { logged = append(logged, line) })

	if len(result.Failed) != 0 {
		t.Fatalf("Failed = %v, want none", result.Failed)
	}
	if len(result.Relinked) != 3 {
		t.Errorf("Relinked = %v, want the three shadowed copies", result.Relinked)
	}
	if len(logged) != 0 {
		t.Errorf("logged %v, want nothing on a clean normalization", logged)
	}
	for _, name := range []string{"dsh-scope", "dsh-tools", "dsh-agent-presets"} {
		want := realPath(t, filepath.Join(bundled, Scope, name))
		if got := realPath(t, filepath.Join(core, name)); got != want {
			t.Errorf("%s resolves to %s, want the bundled %s", name, got, want)
		}
	}
	if _, err := os.Stat(filepath.Join(core, "dsh-future", "package.json")); err != nil {
		t.Errorf("dsh-future stat err = %v, want a package the runtime does not ship kept", err)
	}
	nested := filepath.Join(profile, "node_modules", "@dshtrading", "knowledge", "node_modules", Scope, "dsh-tools")
	if got, want := realPath(t, nested), realPath(t, filepath.Join(bundled, Scope, "dsh-tools")); got != want {
		t.Errorf("nested shadow copy resolves to %s, want the bundled %s", got, want)
	}
	linkedShadow := filepath.Join(linkedTree, "node_modules", Scope, "dsh-tools")
	if info, err := os.Lstat(linkedShadow); err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		t.Errorf("a symlinked package tree was rewritten: lstat = %v, %v", info, err)
	}
	if second := Normalize(profile, bundled, nil); len(second.Relinked) != 0 {
		t.Errorf("second pass relinked %v, want a no-op", second.Relinked)
	}
}

func TestNormalizeWithoutAProfileOrARuntimeChangesNothing(t *testing.T) {
	dir := t.TempDir()
	bundled := filepath.Join(dir, "runtime", "node_modules")
	writePackage(t, filepath.Join(bundled, Scope, "dsh-tools"))
	if result := Normalize(filepath.Join(dir, "absent"), bundled, nil); len(result.Relinked) != 0 || len(result.Failed) != 0 {
		t.Errorf("Normalize without a profile = %+v, want nothing done", result)
	}
	profile := filepath.Join(dir, "profiles", "trading-web")
	writePackage(t, filepath.Join(profile, "node_modules", Scope, "dsh-tools"))
	if result := Normalize(profile, filepath.Join(dir, "no-runtime"), nil); len(result.Relinked) != 0 || len(result.Failed) != 0 {
		t.Errorf("Normalize without a bundled runtime = %+v, want nothing done", result)
	}
}
