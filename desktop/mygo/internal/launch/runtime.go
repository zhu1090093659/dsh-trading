package launch

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
)

// Locations inside the app's resources directory of the payload the Electron
// shell ships and this one reads in place: desktop/src/runtime.cjs
// resolveRuntimePaths describes the same layout.
const (
	// MaxHTTPHeaderBytes is the host's request-header budget. The GUI requests
	// its client plugin batch as one combo URL (measured 2.8 KiB), which Node's
	// 16 KiB default leaves little room for beside the cookie jar.
	MaxHTTPHeaderBytes = 65536
	hostBinRelative    = "@deepseek-ai/dsh/lib/bin.js"
	profileSeedDir     = "profile-trading"
	runtimeStampFile   = "VERSION.json"
	hostModulesDir     = "node_modules"
)

// RuntimePaths are the on-disk locations of the bundled node runtime, dsh host
// and trading profile seed. Nothing is copied: the payload is read from the
// app's resources.
type RuntimePaths struct {
	// Root is <resources>/runtime.
	Root string
	// NodeHome is the bundled node distribution (the child's PATH prefix).
	NodeHome string
	// NodeBin is the bundled node executable that runs the host.
	NodeBin string
	// HostBin is the dsh entry point the bundled node runs.
	HostBin string
	// HostModules is the bundled host's package tree, the copy of
	// @deepseek-ai/* the live profile's core packages are relinked onto (see
	// internal/cohort).
	HostModules string
	// ProfileSeed is the preinstalled trading profile the shell copies into
	// the DSH home it manages.
	ProfileSeed string
	// StampFile is the payload's VERSION.json, whose node/host/profileHash
	// give a seeded profile its identity.
	StampFile string
}

// nodeExecutableName is the file name of the bundled node runtime: the Windows
// payload keeps it beside npm at the distribution root, the unices under bin/.
func nodeExecutableName(goos string) string {
	if goos == "windows" {
		return "node.exe"
	}
	return "node"
}

// nodeBinDir is the directory the bundled node executable lives in, which is
// also what goes first on the host's PATH: a node zip on Windows unpacks
// node.exe into runtime/node itself, while a node distribution on the unices
// keeps it in runtime/node/bin. desktop/src/runtime.cjs resolves the same two
// shapes, and the packaging side (desktop/scripts) builds the payload to match.
func nodeBinDir(goos, nodeHome string) string {
	if goos == "windows" {
		return nodeHome
	}
	return filepath.Join(nodeHome, "bin")
}

// pathListSeparator is the separator between PATH entries on goos; the host's
// PATH prefix has to use the target platform's, not the build host's.
func pathListSeparator(goos string) string {
	if goos == "windows" {
		return ";"
	}
	return ":"
}

// ResolveRuntimePaths maps the app's resources directory to the payload inside
// it.
func ResolveRuntimePaths(resourcesRoot string) RuntimePaths {
	return resolveRuntimePathsFor(runtime.GOOS, resourcesRoot)
}

// resolveRuntimePathsFor is ResolveRuntimePaths for one target platform, which
// is what lets both payload layouts be tested on either build host.
func resolveRuntimePathsFor(goos, resourcesRoot string) RuntimePaths {
	root := filepath.Join(resourcesRoot, "runtime")
	nodeHome := filepath.Join(root, "node")
	hostRoot := filepath.Join(root, "host")
	return RuntimePaths{
		Root:        root,
		NodeHome:    nodeHome,
		NodeBin:     filepath.Join(nodeBinDir(goos, nodeHome), nodeExecutableName(goos)),
		HostBin:     filepath.Join(hostRoot, hostModulesDir, filepath.FromSlash(hostBinRelative)),
		HostModules: filepath.Join(hostRoot, hostModulesDir),
		ProfileSeed: filepath.Join(root, profileSeedDir),
		StampFile:   filepath.Join(root, runtimeStampFile),
	}
}

// ProfileDir is the live profile the GUI runs inside a DSH home.
func ProfileDir(home string) string {
	return filepath.Join(home, "profiles", profileName)
}

// Validate reports the first payload file that is missing. A shell without the
// payload cannot start a host, and saying which file is gone is the whole
// diagnosis the user gets on a broken installation.
func (p RuntimePaths) Validate() error {
	for _, path := range []string{p.NodeBin, p.HostBin} {
		info, err := os.Stat(path)
		if err != nil {
			return fmt.Errorf("bundled runtime is missing: %s", path)
		}
		if info.IsDir() {
			return fmt.Errorf("bundled runtime is not a file: %s", path)
		}
	}
	return nil
}
