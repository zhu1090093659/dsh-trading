package preflight

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// putRuntime makes dir a runtime this process can load and returns it: the
// browser process and the client library of this process's architecture, as
// the installer leaves them.
func putRuntime(t *testing.T, dir string) string {
	t.Helper()
	for _, path := range []string{
		filepath.Join(dir, browserExe),
		filepath.Join(dir, clientDir, archDir(), clientDLL),
	} {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatalf("making %s: %v", filepath.Dir(path), err)
		}
		if err := os.WriteFile(path, nil, 0o644); err != nil {
			t.Fatalf("writing %s: %v", path, err)
		}
	}
	return dir
}

// install puts one version of the runtime under an install root and returns
// its directory.
func install(t *testing.T, root, version string) string {
	t.Helper()
	return putRuntime(t, filepath.Join(root, version))
}

// getenvOf returns a getenv that knows the variables it was given.
func getenvOf(vars map[string]string) func(string) string {
	return func(name string) string { return vars[name] }
}

func TestLocatePrefersTheRuntimeTheEnvironmentNames(t *testing.T) {
	fixed := putRuntime(t, filepath.Join(t.TempDir(), "fixed"))
	machine := t.TempDir()
	install(t, machine, "131.0.2903.112")

	dir, ok := Locate(Roots{Fixed: fixed, Machine: machine})
	if !ok {
		t.Fatalf("Locate = false, want the runtime at %s", fixed)
	}
	if dir != fixed {
		t.Errorf("Locate = %q, want %q: WEBVIEW2_BROWSER_EXECUTABLE_FOLDER wins", dir, fixed)
	}
}

func TestLocateFindsTheRuntimeUnderProgramFiles(t *testing.T) {
	machine := t.TempDir()
	want := install(t, machine, "131.0.2903.112")

	dir, ok := Locate(Roots{Machine: machine, User: t.TempDir()})
	if !ok {
		t.Fatalf("Locate = false, want the runtime at %s", want)
	}
	if dir != want {
		t.Errorf("Locate = %q, want %q", dir, want)
	}
}

func TestLocateFindsTheRuntimeUnderLocalAppData(t *testing.T) {
	user := t.TempDir()
	want := install(t, user, "131.0.2903.112")

	dir, ok := Locate(Roots{Machine: t.TempDir(), User: user})
	if !ok {
		t.Fatalf("Locate = false, want the runtime at %s", want)
	}
	if dir != want {
		t.Errorf("Locate = %q, want %q", dir, want)
	}
}

func TestLocateSearchesTheMachinesInstallBeforeTheUsers(t *testing.T) {
	machine, user := t.TempDir(), t.TempDir()
	want := install(t, machine, "120.0.2210.91")
	install(t, user, "131.0.2903.112")

	dir, ok := Locate(Roots{Machine: machine, User: user})
	if !ok {
		t.Fatalf("Locate = false, want the runtime at %s", want)
	}
	if dir != want {
		t.Errorf("Locate = %q, want %q: the machine's install is searched first", dir, want)
	}
}

func TestLocateTakesTheNewestVersionOfAnInstall(t *testing.T) {
	machine := t.TempDir()
	for _, version := range []string{"120.0.2210.91", "131.0.2903.112", "110.0.1587.69", "131.0.2903.9"} {
		install(t, machine, version)
	}
	want := filepath.Join(machine, "131.0.2903.112")

	dir, ok := Locate(Roots{Machine: machine})
	if !ok {
		t.Fatalf("Locate = false, want the runtime at %s", want)
	}
	if dir != want {
		t.Errorf("Locate = %q, want %q", dir, want)
	}
}

func TestLocateIgnoresWhatHoldsNoRuntime(t *testing.T) {
	machine := t.TempDir()
	want := install(t, machine, "120.0.2210.91")
	// A version directory without a client library starts no page, and a file
	// where a version directory goes is none either.
	if err := os.MkdirAll(filepath.Join(machine, "999.0.0.1"), 0o755); err != nil {
		t.Fatalf("making the empty version directory: %v", err)
	}
	if err := os.WriteFile(filepath.Join(machine, "998.0.0.1"), nil, 0o644); err != nil {
		t.Fatalf("writing a file into the install root: %v", err)
	}

	dir, ok := Locate(Roots{Machine: machine})
	if !ok {
		t.Fatalf("Locate = false, want the runtime at %s", want)
	}
	if dir != want {
		t.Errorf("Locate = %q, want %q", dir, want)
	}
}

func TestLocateNeedsTheClientLibraryToo(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "131.0.2903.112")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("making the version directory: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, browserExe), nil, 0o644); err != nil {
		t.Fatalf("writing %s: %v", browserExe, err)
	}

	found, ok := Locate(Roots{Fixed: dir})
	if ok {
		t.Errorf("Locate = %q, want no runtime: %s is missing from it", found, clientDLL)
	}
}

func TestLocateReportsNoRuntime(t *testing.T) {
	dir, ok := Locate(Roots{Machine: t.TempDir(), User: t.TempDir()})
	if ok {
		t.Errorf("Locate = %q, want no runtime in empty install roots", dir)
	}
	if dir != "" {
		t.Errorf("Locate = %q, want an empty directory", dir)
	}
	if dir, ok := Locate(Roots{}); ok {
		t.Errorf("Locate = %q, want no runtime from an environment naming none", dir)
	}
}

func TestLocateEndsTheSearchAtAFixedRuntimeThatIsNotThere(t *testing.T) {
	machine := t.TempDir()
	install(t, machine, "131.0.2903.112")

	dir, ok := Locate(Roots{Fixed: filepath.Join(t.TempDir(), "gone"), Machine: machine})
	if ok {
		t.Errorf("Locate = %q, want no runtime: the environment names one that is not there", dir)
	}
	if dir != "" {
		t.Errorf("Locate = %q, want an empty directory", dir)
	}
}

func TestRootsForReadsTheInstallersEnvironment(t *testing.T) {
	base := t.TempDir()
	programFiles := filepath.Join(base, "Program Files (x86)")
	localAppData := filepath.Join(base, "Local")
	fixed := filepath.Join(base, "fixed")

	roots := RootsFor(getenvOf(map[string]string{
		"WEBVIEW2_BROWSER_EXECUTABLE_FOLDER": fixed,
		"ProgramFiles(x86)":                  programFiles,
		"LOCALAPPDATA":                       localAppData,
	}))
	installed := filepath.Join("Microsoft", "EdgeWebView", "Application")
	if roots.Fixed != fixed {
		t.Errorf("Fixed = %q, want %q", roots.Fixed, fixed)
	}
	if want := filepath.Join(programFiles, installed); roots.Machine != want {
		t.Errorf("Machine = %q, want %q", roots.Machine, want)
	}
	if want := filepath.Join(localAppData, installed); roots.User != want {
		t.Errorf("User = %q, want %q", roots.User, want)
	}
}

func TestRootsForLeavesOutWhatTheEnvironmentDoesNotName(t *testing.T) {
	if roots := RootsFor(getenvOf(nil)); roots != (Roots{}) {
		t.Errorf("RootsFor = %+v, want no roots from an empty environment", roots)
	}
}

func TestMissingIsFalseWhereWebView2PlaysNoPart(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("the Windows probe reads this machine's own environment")
	}
	if Missing() {
		t.Error("Missing = true away from Windows, want false: every other platform starts the shell as it always has")
	}
}

func TestMissingLineNamesWhatWasSearchedAndWhereToGetIt(t *testing.T) {
	roots := Roots{
		Fixed:   filepath.Join("fixed"),
		Machine: filepath.Join("machine", "Application"),
		User:    filepath.Join("user", "Application"),
	}
	line := MissingLine(roots)
	if strings.ContainsAny(line, "\r\n") {
		t.Errorf("MissingLine = %q, want one line", line)
	}
	for _, want := range []string{browserExe, clientDLL, roots.Fixed, roots.Machine, roots.User, Download} {
		if !strings.Contains(line, want) {
			t.Errorf("MissingLine = %q, want it to name %q", line, want)
		}
	}
}

func TestMissingLineWithoutAnyInstallLocation(t *testing.T) {
	line := MissingLine(Roots{})
	if strings.Contains(line, " under ") {
		t.Errorf("MissingLine = %q, want no list of places where the environment names none", line)
	}
	if !strings.Contains(line, Download) {
		t.Errorf("MissingLine = %q, want the download address %q", line, Download)
	}
}

func TestCompareVersionsOrdersTheRuntimeVersions(t *testing.T) {
	cases := []struct {
		a, b string
		want int
	}{
		{"131.0.2903.112", "120.0.2210.91", 1},
		{"120.0.2210.91", "131.0.2903.112", -1},
		{"131.0.2903.112", "131.0.2903.112", 0},
		{"131.0.2903.112", "131.0.2903.9", 1},
		{"1.2", "1.2.1", -1},
		{"131.0.2903.112", "release", 1},
	}
	for _, c := range cases {
		if got := compareVersions(parseVersion(c.a), parseVersion(c.b)); got != c.want {
			t.Errorf("compareVersions(%q, %q) = %d, want %d", c.a, c.b, got, c.want)
		}
	}
}
