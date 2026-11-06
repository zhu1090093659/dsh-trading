package launch

import (
	"os"
	"path/filepath"
	"strings"
)

// PrimaryRuntimeEnv gates the official Office skills (skill-office) and the
// load_workspace_dependencies tool: the host's profile rows disable themselves
// unless it names a payload directory holding runtime.json. The shell sets it
// only for a payload that exists on disk, so an installation carrying none
// keeps those two rows explicitly disabled — never a system Python or PATH
// fallback.
const PrimaryRuntimeEnv = "DSH_PRIMARY_RUNTIME"

// primaryRuntimeDir is the payload's name inside the app's runtime resources.
const primaryRuntimeDir = "primary-runtime"

// primaryRuntimeManifest is the file that makes a directory a payload.
const primaryRuntimeManifest = "runtime.json"

// AbsentPrimaryRuntime is what the shell logs when no payload exists, so the
// log says the capability is off instead of leaving its silence to chance.
const AbsentPrimaryRuntime = "absent (Office skills and load_workspace_dependencies stay disabled)"

// PrimaryRuntime is the shell's decision about the dependency payload the
// Office and workspace-dependency rows consume.
type PrimaryRuntime struct {
	// Path is the payload the shell announces to the host, "" when there is
	// none.
	Path string
	// Inherited is the DSH_PRIMARY_RUNTIME the shell was itself started with.
	// The host child inherits it unchanged, as desktop/src/main.cjs childEnv
	// passes it on: exporting it is the documented way to enable the rows by
	// hand.
	Inherited string
}

// ResolvePrimaryRuntime resolves the payload from the two candidate locations
// desktop/src/runtime.cjs:resolvePrimaryRuntime uses, in that order: one staged
// inside this app's runtime resources, then the conventional per-home location
// of the official desktop.
//
// The host ~/.dsh instance is deliberately not a candidate: this shell runs the
// dedicated trading home, and reaching across homes is the user's decision, not
// the shell's default.
func ResolvePrimaryRuntime(runtimeRoot, home string) PrimaryRuntime {
	for _, candidate := range []string{
		filepath.Join(runtimeRoot, primaryRuntimeDir),
		filepath.Join(home, "dsh-runtimes", "dsh-primary-runtime"),
	} {
		info, err := os.Stat(filepath.Join(candidate, primaryRuntimeManifest))
		if err != nil || info.IsDir() {
			continue
		}
		return PrimaryRuntime{Path: candidate}
	}
	return PrimaryRuntime{}
}

// WithInherited records the DSH_PRIMARY_RUNTIME the shell was started with.
func (p PrimaryRuntime) WithInherited(value string) PrimaryRuntime {
	p.Inherited = strings.TrimSpace(value)
	return p
}

// Enabled reports whether the shell resolved a payload of its own.
func (p PrimaryRuntime) Enabled() bool { return p.Path != "" }

// LogValue is what one boot says about the payload: the directory when there is
// one, otherwise the explicit absence plus what happens to an inherited
// variable.
func (p PrimaryRuntime) LogValue() string {
	if p.Enabled() {
		return p.Path
	}
	if p.Inherited != "" {
		return "absent from the app payload and the trading home; the inherited " +
			PrimaryRuntimeEnv + "=" + p.Inherited + " passes through to the host"
	}
	return AbsentPrimaryRuntime
}
