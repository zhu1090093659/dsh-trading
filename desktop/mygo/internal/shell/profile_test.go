package shell

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/dshtrading/desktop-mygo/internal/cohort"
	"github.com/dshtrading/desktop-mygo/internal/launch"
	"github.com/dshtrading/desktop-mygo/internal/profile"
)

// writeFiles writes a fixture tree, creating the directories it needs.
func writeFiles(t *testing.T, files map[string]string) {
	t.Helper()
	for name, content := range files {
		if err := os.MkdirAll(filepath.Dir(name), 0o755); err != nil {
			t.Fatalf("MkdirAll(%s) err = %v", filepath.Dir(name), err)
		}
		if err := os.WriteFile(name, []byte(content), 0o644); err != nil {
			t.Fatalf("writing %s err = %v", name, err)
		}
	}
}

// payload builds a runtime payload fixture under resources: the profile seed
// with one bundled core package copy, the host closure's copy of that package,
// and the VERSION.json that names the seed's identity.
func payload(t *testing.T, resources, profileHash string) launch.RuntimePaths {
	t.Helper()
	paths := launch.ResolveRuntimePaths(resources)
	core := filepath.Join(paths.ProfileSeed, "node_modules", cohort.Scope, "dsh-tools", "package.json")
	writeFiles(t, map[string]string{
		filepath.Join(paths.ProfileSeed, "package.json"):                    `{"name":"dsh-profile-trading-web"}`,
		filepath.Join(paths.ProfileSeed, "cordis.patch.yml"):                "# payload patch layer",
		filepath.Join(paths.ProfileSeed, "node_modules", "pkg", "index.js"): "v1",
		core: `{}`,
		filepath.Join(paths.HostModules, cohort.Scope, "dsh-tools", "package.json"): `{}`,
		paths.StampFile: `{"node":"node@24","host":"dsh@0.2.1","profileHash":"` + profileHash + `"}`,
	})
	return paths
}

// newShell is a shell whose log goes to a file the test can read, so the boot
// lines are asserted instead of filling the test output.
func newShell(t *testing.T) (*Shell, func() string) {
	t.Helper()
	log, err := os.Create(filepath.Join(t.TempDir(), "dsh-host.log"))
	if err != nil {
		t.Fatalf("creating the log err = %v", err)
	}
	t.Cleanup(func() { _ = log.Close() })
	return &Shell{logFile: log}, func() string {
		data, err := os.ReadFile(log.Name())
		if err != nil {
			t.Fatalf("reading the log err = %v", err)
		}
		return string(data)
	}
}

func TestPrepareProfileSeedsTheHomeAndRelinksTheCohort(t *testing.T) {
	resources := t.TempDir()
	home := filepath.Join(t.TempDir(), "probe-trading")
	paths := payload(t, resources, "hash-1")
	shell, logged := newShell(t)

	primary, err := shell.prepareProfile(paths, home, "0.2.1")
	if err != nil {
		t.Fatalf("prepareProfile err = %v", err)
	}
	if primary.Enabled() {
		t.Errorf("primary runtime = %q, want none: the payload carries no primary-runtime", primary.Path)
	}

	profileDir := launch.ProfileDir(home)
	marker := profile.ReadMarker(filepath.Join(profileDir, profile.SeedMarker))
	if marker == nil {
		t.Fatal("the seeded profile carries no .dsh-desktop-seed.json")
	}
	if want := "node@24 / dsh@0.2.1 / hash-1"; marker.Stamp != want {
		t.Errorf("marker stamp = %q, want %q", marker.Stamp, want)
	}
	if marker.AppVersion != "0.2.1" {
		t.Errorf("marker appVersion = %q, want the app version", marker.AppVersion)
	}
	if _, err := os.Stat(filepath.Join(profileDir, "node_modules", "pkg", "index.js")); err != nil {
		t.Errorf("the seeded profile is missing its package: %v", err)
	}
	// The profile's own copy of a core package is relinked onto the bundled one.
	bundled, err := filepath.EvalSymlinks(filepath.Join(paths.HostModules, cohort.Scope, "dsh-tools"))
	if err != nil {
		t.Fatalf("EvalSymlinks(bundled) err = %v", err)
	}
	linked, err := filepath.EvalSymlinks(filepath.Join(profileDir, "node_modules", cohort.Scope, "dsh-tools"))
	if err != nil {
		t.Fatalf("the profile's core package is not a link to the runtime: %v", err)
	}
	if linked != bundled {
		t.Errorf("profile core package resolves to %s, want the bundled %s", linked, bundled)
	}

	metrics := shell.Metrics()
	if metrics.ProfileAction != string(profile.Seed) {
		t.Errorf("ProfileAction = %q, want %q", metrics.ProfileAction, profile.Seed)
	}
	if metrics.PrimaryRuntime != "" {
		t.Errorf("PrimaryRuntime = %q, want empty", metrics.PrimaryRuntime)
	}
	log := logged()
	for _, want := range []string{
		"[desktop] profile action: seed (node@24 / dsh@0.2.1 / hash-1)",
		"[desktop] primary runtime: " + launch.AbsentPrimaryRuntime,
	} {
		if !strings.Contains(log, want) {
			t.Errorf("the boot log does not carry %q:\n%s", want, log)
		}
	}

	// The user edits the patch layer; a new payload reseeds the profile and
	// keeps it.
	userPatch := "- insert: []"
	if err := os.WriteFile(filepath.Join(profileDir, profile.PatchLayer), []byte(userPatch), 0o644); err != nil {
		t.Fatalf("writing the user patch err = %v", err)
	}
	updated := payload(t, resources, "hash-2")
	if _, err := shell.prepareProfile(updated, home, "0.2.2"); err != nil {
		t.Fatalf("prepareProfile(updated) err = %v", err)
	}
	if got := shell.Metrics().ProfileAction; got != string(profile.Reseed) {
		t.Errorf("ProfileAction after the payload moved = %q, want %q", got, profile.Reseed)
	}
	data, err := os.ReadFile(filepath.Join(profileDir, profile.PatchLayer))
	if err != nil || string(data) != userPatch {
		t.Errorf("user patch = %q (err %v), want it kept", data, err)
	}
	if marker := profile.ReadMarker(filepath.Join(profileDir, profile.SeedMarker)); marker == nil || marker.Stamp != "node@24 / dsh@0.2.1 / hash-2" {
		t.Errorf("marker after the reseed = %+v, want the new identity", marker)
	}

	// A third boot on the same payload changes nothing.
	if _, err := shell.prepareProfile(updated, home, "0.2.2"); err != nil {
		t.Fatalf("prepareProfile(again) err = %v", err)
	}
	if got := shell.Metrics().ProfileAction; got != string(profile.Leave) {
		t.Errorf("ProfileAction on a current profile = %q, want %q", got, profile.Leave)
	}
}

func TestPrepareProfileAnnouncesAStagedPrimaryRuntime(t *testing.T) {
	resources := t.TempDir()
	home := filepath.Join(t.TempDir(), "probe-trading")
	paths := payload(t, resources, "hash-1")
	staged := filepath.Join(paths.Root, "primary-runtime")
	writeFiles(t, map[string]string{filepath.Join(staged, "runtime.json"): `{}`})
	shell, logged := newShell(t)

	primary, err := shell.prepareProfile(paths, home, "0.2.1")
	if err != nil {
		t.Fatalf("prepareProfile err = %v", err)
	}
	if primary.Path != staged {
		t.Errorf("primary runtime = %q, want the staged payload %q", primary.Path, staged)
	}
	if got := shell.Metrics().PrimaryRuntime; got != staged {
		t.Errorf("metrics PrimaryRuntime = %q, want %q", got, staged)
	}
	if log := logged(); !strings.Contains(log, "[desktop] primary runtime: "+staged) {
		t.Errorf("the boot log does not name the payload:\n%s", log)
	}
}
