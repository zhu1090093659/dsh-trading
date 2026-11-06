package launch

import (
	"net/url"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
)

// The host this shell starts serves the trading profile on a loopback port the
// shell picked, so the tokenized URL it prints is the only way into the GUI.
const (
	profileName     = "trading-web"
	hostBindAddress = "127.0.0.1"
)

// Environment the shell hands the host: the home it owns, and the shell pid the
// orphan guard watches (desktop/src/host-orphan-guard.mjs).
const (
	HomeEnv     = "DSH_HOME"
	ShellPIDEnv = "DSH_DESKTOP_SHELL_PID"
)

// HostSpec is everything the shell knows about the host it is about to start.
type HostSpec struct {
	Paths RuntimePaths
	// Hooks are absolute paths of the --import hooks, in order.
	Hooks []string
	// Port is the loopback port the GUI is served on.
	Port int
	// Home is the DSH home the host runs against.
	Home string
	// ShellPID is this process, which the orphan guard watches.
	ShellPID int
	// ParentEnv is os.Environ().
	ParentEnv []string
	// PrimaryRuntime is the dependency payload the shell resolved, "" when the
	// capability stays absent (see ResolvePrimaryRuntime).
	PrimaryRuntime string
}

// Args are the host's arguments, mirroring desktop/src/main.cjs startHost: the
// header budget, the hooks, then the bundled host on the trading profile with
// the GUI on our port and no browser of its own.
func (s HostSpec) Args() []string {
	args := []string{"--max-http-header-size=" + strconv.Itoa(MaxHTTPHeaderBytes)}
	for _, hook := range s.Hooks {
		args = append(args, "--import", FileURL(hook))
	}
	return append(args,
		s.Paths.HostBin, "--profile", profileName, "--no-open",
		"--host", hostBindAddress, "--port", strconv.Itoa(s.Port),
	)
}

// Env is the host's environment: the parent environment with the home and shell
// pid set, the bundled node distribution first on PATH (so anything the host
// shells out to resolves against it) and Electron's runner switch removed.
//
// DSH_PRIMARY_RUNTIME is set only when the shell resolved a payload: without
// one the host's two capability rows stay disabled, which is why nothing here
// guesses at a path (see internal/launch/primary.go).
func (s HostSpec) Env() []string { return s.envFor(runtime.GOOS) }

// envFor is Env for one target platform, which is what lets both PATH shapes be
// tested on either build host.
func (s HostSpec) envFor(goos string) []string {
	env := setEnv(s.ParentEnv, HomeEnv, s.Home)
	env = setEnv(env, ShellPIDEnv, strconv.Itoa(s.ShellPID))
	if s.PrimaryRuntime != "" {
		env = setEnv(env, PrimaryRuntimeEnv, s.PrimaryRuntime)
	}
	env = s.withBundledNodePath(env, goos)
	return unsetEnv(env, "ELECTRON_RUN_AS_NODE")
}

// withBundledNodePath puts the bundled node distribution first on PATH, so
// anything the host shells out to (npm, corepack, a plugin's tool) resolves
// against the bundled runtime rather than the system one.
//
// Windows environment blocks spell the variable in either case, so the value
// goes into both spellings there: a child that reads Path must not fall back to
// the system node (desktop/src/main.cjs childEnv sets both for the same reason).
func (s HostSpec) withBundledNodePath(env []string, goos string) []string {
	key, current := lookupPath(env, goos)
	value := nodeBinDir(goos, s.Paths.NodeHome) + pathListSeparator(goos) + current
	env = setEnv(env, key, value)
	if goos == "windows" {
		for _, name := range []string{"PATH", "Path"} {
			env = setEnv(env, name, value)
		}
	}
	return env
}

// lookupPath reads PATH from an environ slice in whichever spelling it carries:
// Windows names the same variable in either case, and taking the one the parent
// actually used is what keeps the inherited entries.
func lookupPath(env []string, goos string) (string, string) {
	for i := len(env) - 1; i >= 0; i-- {
		name, value, ok := strings.Cut(env[i], "=")
		if !ok {
			continue
		}
		if name == "PATH" || (goos == "windows" && strings.EqualFold(name, "PATH")) {
			return name, value
		}
	}
	return "PATH", ""
}

// Dir is the host's working directory: its own home, as the Electron shell
// spawns it.
func (s HostSpec) Dir() string { return s.Home }

// FileURL is the `--import` specifier of a hook file: node takes a file URL,
// and a plain path would be resolved as a bare module name.
func FileURL(path string) string {
	abs, err := filepath.Abs(path)
	if err != nil {
		abs = path
	}
	return (&url.URL{Scheme: "file", Path: abs}).String()
}

// setEnv replaces key in an environ slice, or appends it when it is not there.
func setEnv(env []string, key, value string) []string {
	prefix := key + "="
	for i, entry := range env {
		if strings.HasPrefix(entry, prefix) {
			out := make([]string, len(env))
			copy(out, env)
			out[i] = prefix + value
			return out
		}
	}
	out := make([]string, len(env), len(env)+1)
	copy(out, env)
	return append(out, prefix+value)
}

// unsetEnv removes key from an environ slice.
func unsetEnv(env []string, key string) []string {
	prefix := key + "="
	out := make([]string, 0, len(env))
	for _, entry := range env {
		if strings.HasPrefix(entry, prefix) {
			continue
		}
		out = append(out, entry)
	}
	return out
}

// lookupEnv reads key from an environ slice.
func lookupEnv(env []string, key string) (string, bool) {
	prefix := key + "="
	for i := len(env) - 1; i >= 0; i-- {
		if value, ok := strings.CutPrefix(env[i], prefix); ok {
			return value, true
		}
	}
	return "", false
}
