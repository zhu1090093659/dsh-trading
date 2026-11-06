package profile

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// seed builds a payload profile seed: a manifest, the user patch layer and one
// installed package with a patch layer of its own.
func seed(t *testing.T, dir, index string) {
	t.Helper()
	files := map[string]string{
		"package.json":        "{\"name\":\"dsh-profile-trading-web\"}\n",
		PatchLayer:            "# shipped patch layer\n",
		"pnpm-workspace.yaml": "packages:\n  - .\n",
		filepath.Join("node_modules", "pkg", "index.js"): index,
		filepath.Join("node_modules", "pkg", PatchLayer): "- insert: [" + index + "]\n",
	}
	for name, content := range files {
		path := filepath.Join(dir, name)
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatalf("MkdirAll(%s) err = %v", name, err)
		}
		if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
			t.Fatalf("writing %s err = %v", name, err)
		}
	}
}

// read is a test's view of one file.
func read(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile(%s) err = %v", path, err)
	}
	return string(data)
}

func TestDecideSeedsMissingProfilesLeavesUserManagedAndReseedsStale(t *testing.T) {
	dir := t.TempDir()
	profile := filepath.Join(dir, "trading-web")
	if got := Decide(profile, "s1"); got != Seed {
		t.Errorf("Decide on a missing profile = %q, want %q", got, Seed)
	}

	if err := os.MkdirAll(profile, 0o755); err != nil {
		t.Fatalf("MkdirAll err = %v", err)
	}
	if err := os.WriteFile(filepath.Join(profile, "package.json"), []byte("{}"), 0o644); err != nil {
		t.Fatalf("writing the user manifest err = %v", err)
	}
	if got := Decide(profile, "s1"); got != Leave {
		t.Errorf("Decide without a seed marker = %q, want %q: a profile this app never seeded is the user's", got, Leave)
	}

	if err := os.WriteFile(filepath.Join(profile, SeedMarker), []byte("{\"stamp\":\"s1\"}"), 0o644); err != nil {
		t.Fatalf("writing the marker err = %v", err)
	}
	if got := Decide(profile, "s1"); got != Leave {
		t.Errorf("Decide with the current stamp = %q, want %q", got, Leave)
	}
	if got := Decide(profile, "s2"); got != Reseed {
		t.Errorf("Decide with a moved stamp = %q, want %q", got, Reseed)
	}
}

func TestDecideLeavesAProfileWhoseMarkerIsUnreadable(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "package.json"), []byte("{}"), 0o644); err != nil {
		t.Fatalf("writing the manifest err = %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, SeedMarker), []byte("not json"), 0o644); err != nil {
		t.Fatalf("writing the marker err = %v", err)
	}
	if got := Decide(dir, "s1"); got != Leave {
		t.Errorf("Decide with a corrupt marker = %q, want %q", got, Leave)
	}
}

func TestApplySeedsAndRecordsThePayloadIdentity(t *testing.T) {
	dir := t.TempDir()
	seedDir := filepath.Join(dir, "seed")
	profileDir := filepath.Join(dir, "profiles", "trading-web")
	seed(t, seedDir, "v1")

	if err := Apply(seedDir, profileDir, Seed, "node@24 / dsh@0.2.1 / hash-1", "0.2.1"); err != nil {
		t.Fatalf("Apply err = %v", err)
	}

	marker := ReadMarker(filepath.Join(profileDir, SeedMarker))
	if marker == nil {
		t.Fatal("Apply wrote no seed marker")
	}
	if marker.Stamp != "node@24 / dsh@0.2.1 / hash-1" {
		t.Errorf("marker stamp = %q, want the payload identity", marker.Stamp)
	}
	if marker.AppVersion != "0.2.1" {
		t.Errorf("marker appVersion = %q, want %q", marker.AppVersion, "0.2.1")
	}
	if _, err := time.Parse(seedTimeFormat, marker.SeededAt); err != nil {
		t.Errorf("marker seededAt = %q, want the ISO-8601 form of a Date: %v", marker.SeededAt, err)
	}
	if got := read(t, filepath.Join(profileDir, "node_modules", "pkg", "index.js")); got != "v1" {
		t.Errorf("seeded package index = %q, want %q", got, "v1")
	}
	if got := Decide(profileDir, marker.Stamp); got != Leave {
		t.Errorf("Decide right after seeding = %q, want %q", got, Leave)
	}
}

func TestApplyReseedKeepsTheUserPatchLayerAndItsBackups(t *testing.T) {
	dir := t.TempDir()
	seedDir := filepath.Join(dir, "seed")
	profileDir := filepath.Join(dir, "profiles", "trading-web")
	seed(t, seedDir, "v1")
	if err := Apply(seedDir, profileDir, Seed, "s1", "0.2.1"); err != nil {
		t.Fatalf("Apply(seed) err = %v", err)
	}

	userPatch := "- insert: []\n"
	if err := os.WriteFile(filepath.Join(profileDir, PatchLayer), []byte(userPatch), 0o644); err != nil {
		t.Fatalf("writing the user patch err = %v", err)
	}
	if err := os.WriteFile(filepath.Join(profileDir, PatchLayer+".bak"), []byte("backup\n"), 0o644); err != nil {
		t.Fatalf("writing the user patch backup err = %v", err)
	}

	seed(t, seedDir, "v2")
	if err := Apply(seedDir, profileDir, Reseed, "s2", "0.2.2"); err != nil {
		t.Fatalf("Apply(reseed) err = %v", err)
	}

	if got := read(t, filepath.Join(profileDir, PatchLayer)); got != userPatch {
		t.Errorf("user patch layer = %q, want it kept as %q", got, userPatch)
	}
	if got := read(t, filepath.Join(profileDir, PatchLayer+".bak")); got != "backup\n" {
		t.Errorf("user patch backup = %q, want it kept", got)
	}
	if got := read(t, filepath.Join(profileDir, "node_modules", "pkg", PatchLayer)); got != "- insert: [v2]\n" {
		t.Errorf("package patch layer = %q, want the payload's, copied on reseed", got)
	}
	if got := read(t, filepath.Join(profileDir, "node_modules", "pkg", "index.js")); got != "v2" {
		t.Errorf("reseeded package index = %q, want %q", got, "v2")
	}
	if marker := ReadMarker(filepath.Join(profileDir, SeedMarker)); marker == nil || marker.Stamp != "s2" {
		t.Errorf("marker after reseed = %+v, want the new identity", marker)
	}
	if got := Decide(profileDir, "s2"); got != Leave {
		t.Errorf("Decide after reseed = %q, want %q", got, Leave)
	}
}

func TestApplyLeaveTouchesNothing(t *testing.T) {
	dir := t.TempDir()
	seedDir := filepath.Join(dir, "seed")
	profileDir := filepath.Join(dir, "profiles", "trading-web")
	seed(t, seedDir, "v1")
	if err := os.MkdirAll(profileDir, 0o755); err != nil {
		t.Fatalf("MkdirAll err = %v", err)
	}
	if err := os.WriteFile(filepath.Join(profileDir, "package.json"), []byte("{\"name\":\"mine\"}"), 0o644); err != nil {
		t.Fatalf("writing the user manifest err = %v", err)
	}

	if err := Apply(seedDir, profileDir, Leave, "s1", "0.2.1"); err != nil {
		t.Fatalf("Apply(leave) err = %v", err)
	}

	if got := read(t, filepath.Join(profileDir, "package.json")); got != "{\"name\":\"mine\"}" {
		t.Errorf("user manifest = %q, want it untouched", got)
	}
	if _, err := os.Stat(filepath.Join(profileDir, SeedMarker)); !os.IsNotExist(err) {
		t.Errorf("Apply(leave) wrote a seed marker (stat err = %v)", err)
	}
}

func TestApplyReportsAMissingSeed(t *testing.T) {
	err := Apply(filepath.Join(t.TempDir(), "absent"), t.TempDir(), Seed, "s1", "0.2.1")
	if err == nil {
		t.Fatal("Apply on a missing seed err = nil, want the seed path reported")
	}
	if !strings.Contains(err.Error(), "bundled profile seed is missing") {
		t.Errorf("Apply err = %q, want it to name the missing seed", err)
	}
}

func TestStampTextKeepsThePayloadIdentity(t *testing.T) {
	if got := StampText(nil); got != "unknown" {
		t.Errorf("StampText(nil) = %q, want %q", got, "unknown")
	}
	legacy := &Stamp{Node: "n", Host: "h", WebAll: "legacy"}
	if got := StampText(legacy); got != "n / h / legacy" {
		t.Errorf("StampText(legacy) = %q, want the webAll field read", got)
	}
	current := &Stamp{Node: "n", Host: "h", ProfileHash: "content"}
	if got := StampText(current); got != "n / h / content" {
		t.Errorf("StampText(profileHash) = %q, want the profile content read", got)
	}
	if got := StampText(&Stamp{Node: "n", Host: "h"}); got != "n / h / " {
		t.Errorf("StampText(no content) = %q, want the empty third part kept", got)
	}
	if StampText(current) == StampText(legacy) {
		t.Error("a rebuild with new plugin content must not keep the legacy identity")
	}
}

func TestReadStampIgnoresUnreadablePayloadStamps(t *testing.T) {
	dir := t.TempDir()
	if got := ReadStamp(filepath.Join(dir, "VERSION.json")); got != nil {
		t.Errorf("ReadStamp(missing) = %+v, want nil", got)
	}
	if err := os.WriteFile(filepath.Join(dir, "VERSION.json"), []byte("not json"), 0o644); err != nil {
		t.Fatalf("writing the stamp err = %v", err)
	}
	if got := ReadStamp(filepath.Join(dir, "VERSION.json")); got != nil {
		t.Errorf("ReadStamp(corrupt) = %+v, want nil", got)
	}
	payload := "{\"node\":\"node@24\",\"host\":\"dsh@0.2.1\",\"profileHash\":\"h\",\"builtAt\":\"2026-11-06\"}"
	if err := os.WriteFile(filepath.Join(dir, "VERSION.json"), []byte(payload), 0o644); err != nil {
		t.Fatalf("writing the stamp err = %v", err)
	}
	stamp := ReadStamp(filepath.Join(dir, "VERSION.json"))
	if stamp == nil {
		t.Fatal("ReadStamp(valid) = nil, want the payload's stamp")
	}
	if stamp.Host != "dsh@0.2.1" || stamp.ProfileHash != "h" {
		t.Errorf("ReadStamp = %+v, want the payload fields read", stamp)
	}
}
