// Package cohort normalizes the live profile's core @deepseek-ai packages onto
// this app's bundled runtime.
//
// The profile is also maintained by the dsh CLI, whose plugin installs link core
// packages against a globally installed npm tree. This shell instead spawns its
// own bundled runtime, and every core package resolved from the profile shadows
// the runtime's copy with a second module instance. Two instances split
// module-level state: a preset then keeps its tools while its prompt sections
// and event listeners miss the agent — no persona, no workspace AGENTS.md, no
// skill catalog (2026-09-08). The bundled symbol normalizer cannot repair this,
// because the state is a WeakMap, not a symbol.
//
// desktop/src/runtime.cjs:normalizeProfileCohort owns the same rule for the
// Electron shell: relink every core package the runtime also ships onto it, keep
// a package the runtime does not know, and never rewrite a package tree that
// belongs to another install.
package cohort

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Scope is the npm scope every dsh core package lives under.
const Scope = "@deepseek-ai"

// walkDepth caps the nested node_modules walk that finds shadow copies.
const walkDepth = 6

// Result is what one normalization did.
type Result struct {
	// Relinked are the profile copies now pointing at the bundled runtime.
	Relinked []string
	// Failed are the profile copies the relink could not touch.
	Failed []string
}

// entry is one core package copy found in the profile.
type entry struct {
	pkg  string
	path string
}

// Normalize relinks the profile's core packages onto the bundled runtime's
// node_modules and reports what it changed. Failures are logged through log (when
// set) and never block a boot: a profile the shell cannot repair is still a
// profile the host may run.
func Normalize(profileDir, hostModulesDir string, log func(string)) Result {
	result := Result{Relinked: []string{}, Failed: []string{}}
	root := filepath.Join(profileDir, "node_modules")
	scopeDir := filepath.Join(hostModulesDir, Scope)
	if !isDir(root) || !isDir(scopeDir) {
		return result
	}
	for _, found := range collectCorePackages(root, 0) {
		bundled := filepath.Join(scopeDir, found.pkg)
		if !isFile(filepath.Join(bundled, "package.json")) {
			continue
		}
		if sameResolved(found.path, bundled) {
			continue
		}
		if err := relink(bundled, found.path); err != nil {
			result.Failed = append(result.Failed, found.path)
			if log != nil {
				log(fmt.Sprintf("[desktop] core package relink failed: %s (%v)", found.path, err))
			}
			continue
		}
		result.Relinked = append(result.Relinked, found.path)
	}
	return result
}

// collectCorePackages collects every node_modules/@deepseek-ai/<pkg> entry under
// root, nested shadow copies included. Symlinked package trees are not descended
// into: their own node_modules belongs to another install (a repo checkout, a
// pnpm store) and must not be rewritten from here.
func collectCorePackages(nodeModulesRoot string, depth int) []entry {
	var found []entry
	if depth > walkDepth {
		return found
	}
	entries, err := os.ReadDir(nodeModulesRoot)
	if err != nil {
		return found
	}
	for _, child := range entries {
		path := filepath.Join(nodeModulesRoot, child.Name())
		link := child.Type()&os.ModeSymlink != 0
		if child.Name() == Scope {
			packages, err := os.ReadDir(path)
			if err != nil {
				continue
			}
			for _, pkg := range packages {
				if pkg.IsDir() || pkg.Type()&os.ModeSymlink != 0 {
					found = append(found, entry{pkg: pkg.Name(), path: filepath.Join(path, pkg.Name())})
				}
			}
			continue
		}
		if link || !child.IsDir() {
			continue
		}
		// A scoped directory holds packages one level down; an unscoped one is
		// a package itself. Both may carry their own nested node_modules.
		if strings.HasPrefix(child.Name(), "@") {
			scoped, err := os.ReadDir(path)
			if err != nil {
				continue
			}
			for _, pkg := range scoped {
				if pkg.Type()&os.ModeSymlink != 0 || !pkg.IsDir() {
					continue
				}
				found = append(found, collectCorePackages(filepath.Join(path, pkg.Name(), "node_modules"), depth+1)...)
			}
			continue
		}
		found = append(found, collectCorePackages(filepath.Join(path, "node_modules"), depth+1)...)
	}
	return found
}

// relink replaces one profile copy with a symlink to the bundled package.
func relink(bundled, path string) error {
	if err := os.RemoveAll(path); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return os.Symlink(bundled, path)
}

// sameResolved reports whether two paths already resolve to the same directory,
// which is what makes a relink unnecessary.
func sameResolved(a, b string) bool {
	resolvedA, err := filepath.EvalSymlinks(a)
	if err != nil {
		return false
	}
	resolvedB, err := filepath.EvalSymlinks(b)
	if err != nil {
		return false
	}
	return resolvedA == resolvedB
}

// isDir is the probe the walk needs, without following a symlink into another
// install.
func isDir(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.IsDir()
}

// isFile reports whether path is a regular file, an existing one.
func isFile(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir()
}
