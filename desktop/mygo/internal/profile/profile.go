// Package profile seeds the trading-web profile of a DSH home from the
// profile the desktop payload carries.
//
// The payload is the only source of the profile's plugins on a machine without
// the repository: profile-trading/ holds the generated manifest, the packed
// workspace tarballs and the installed node_modules. desktop/src/runtime.cjs
// owns the same rules for the Electron shell, and this package keeps them
// identical so both shells seed one home the same way: a missing profile is
// seeded, a profile this app seeded before is reseeded when the payload's
// identity moved, and a profile the user (or the dsh CLI) maintains is left
// alone.
package profile

import (
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// SeedMarker is the file a profile this app seeded carries. A profile without
// one is user-managed, whatever it holds.
const SeedMarker = ".dsh-desktop-seed.json"

// PatchLayer is the profile's user patch layer. A reseed replaces the manifests
// and the installed tree but keeps this file: it holds the user's own rows.
const PatchLayer = "cordis.patch.yml"

// seedTimeFormat is the ISO-8601 form desktop/src/runtime.cjs writes (Date's
// toISOString), so a marker reads the same whichever shell seeded the profile.
const seedTimeFormat = "2006-01-02T15:04:05.000Z"

// reseedDrops are the entries a reseed replaces wholesale: the payload's
// manifest, the workspace and lockfile describing it, and the installed tree.
var reseedDrops = []string{"node_modules", "package.json", "pnpm-workspace.yaml", "pnpm-lock.yaml"}

// Stamp is the identity a payload gives its profile seed: the runtime payload's
// VERSION.json.
type Stamp struct {
	Node string `json:"node"`
	Host string `json:"host"`
	// ProfileHash hashes the staged seed's contents, so a rebuild with
	// different plugin code changes the identity even when node and host did
	// not move.
	ProfileHash string `json:"profileHash"`
	// WebAll is the field payloads built before ProfileHash hashed into.
	WebAll string `json:"webAll"`
}

// ReadStamp reads a payload's VERSION.json. A missing or unreadable file is no
// stamp at all (nil) rather than an error: a payload built before the field
// existed still seeds, and its profiles are upgraded by the next payload that
// carries one (desktop/src/runtime.cjs:readStampFile).
func ReadStamp(path string) *Stamp {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var stamp Stamp
	if err := json.Unmarshal(data, &stamp); err != nil {
		return nil
	}
	return &stamp
}

// StampText renders a stamp the way a seed marker records it: "unknown" without
// one, otherwise node / host / profile content. The three parts stay apart so a
// rebuilt plugin payload reseeds the profile even when the host did not move
// (desktop/src/runtime.cjs:runtimeSeedStamp).
func StampText(stamp *Stamp) string {
	if stamp == nil {
		return "unknown"
	}
	content := stamp.ProfileHash
	if content == "" {
		content = stamp.WebAll
	}
	return strings.Join([]string{stamp.Node, stamp.Host, content}, " / ")
}

// Action is what a boot does with the live profile.
type Action string

const (
	// Seed installs the payload's profile: the home has none.
	Seed Action = "seed"
	// Reseed replaces the payload-owned part of a profile this app seeded
	// earlier, keeping the user's patch layer.
	Reseed Action = "reseed"
	// Leave keeps the profile as it is: it is user-managed, or already current.
	Leave Action = "leave"
)

// Marker is the .dsh-desktop-seed.json of a seeded profile.
type Marker struct {
	// Stamp is the payload identity the profile was seeded from, which is what
	// makes a stale seed recognizable.
	Stamp string `json:"stamp"`
	// SeededAt is when this app last wrote the profile, ISO-8601 UTC.
	SeededAt string `json:"seededAt"`
	// AppVersion is the app that seeded it.
	AppVersion string `json:"appVersion,omitempty"`
}

// ReadMarker reads a seed marker. A missing or unreadable marker is nil, which
// Decide reads as a user-managed profile.
func ReadMarker(path string) *Marker {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var marker Marker
	if err := json.Unmarshal(data, &marker); err != nil {
		return nil
	}
	return &marker
}

// Decide reports how the live profile relates to the payload's seed.
func Decide(profileDir, stamp string) Action {
	if _, err := os.Stat(filepath.Join(profileDir, "package.json")); err != nil {
		return Seed
	}
	marker := ReadMarker(filepath.Join(profileDir, SeedMarker))
	if marker == nil {
		return Leave
	}
	if marker.Stamp == stamp {
		return Leave
	}
	return Reseed
}

// Apply seeds profileDir from seedDir and records the seed marker. A Leave
// action writes nothing.
//
// On reseed the two halves are separated: everything the payload owns
// (package.json, pnpm-workspace.yaml, pnpm-lock.yaml, node_modules, vendor) is
// replaced, while the profile's own root patch layer and its backups stay as
// the user left them.
func Apply(seedDir, profileDir string, action Action, stamp, appVersion string) error {
	if action == Leave {
		return nil
	}
	manifest := filepath.Join(seedDir, "package.json")
	if info, err := os.Stat(manifest); err != nil || info.IsDir() {
		return fmt.Errorf("bundled profile seed is missing: %s", manifest)
	}
	if action == Reseed {
		for _, name := range reseedDrops {
			if err := os.RemoveAll(filepath.Join(profileDir, name)); err != nil {
				return fmt.Errorf("clearing %s of the seeded profile: %w", name, err)
			}
		}
	}
	if err := os.MkdirAll(profileDir, 0o755); err != nil {
		return err
	}
	if err := copySeed(seedDir, profileDir, action == Reseed); err != nil {
		return err
	}
	return writeMarker(filepath.Join(profileDir, SeedMarker), Marker{
		Stamp:      stamp,
		SeededAt:   time.Now().UTC().Format(seedTimeFormat),
		AppVersion: appVersion,
	})
}

// copySeed copies the seed tree into the profile. On reseed the profile's own
// patch layer is left in place; the patch layers of the packages inside
// node_modules are payload content and are copied like everything else.
func copySeed(seedDir, profileDir string, keepPatchLayer bool) error {
	return filepath.WalkDir(seedDir, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		relative, err := filepath.Rel(seedDir, path)
		if err != nil {
			return err
		}
		if relative == "." {
			return nil
		}
		if keepPatchLayer && isPatchLayer(relative) {
			if entry.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		target := filepath.Join(profileDir, relative)
		switch {
		case entry.IsDir():
			return os.MkdirAll(target, 0o755)
		case entry.Type()&os.ModeSymlink != 0:
			// The staged seed is symlink-free on purpose (its pnpm layout is
			// real files); following one here would copy a file from outside
			// the payload into the user's home.
			return fmt.Errorf("profile seed contains a symlink: %s", relative)
		case !entry.Type().IsRegular():
			return fmt.Errorf("profile seed contains an unsupported entry: %s", relative)
		}
		return copyFile(path, target)
	})
}

// isPatchLayer reports whether relative is the profile's own patch layer, or one
// of its backups: it looks at the profile root only, so the patch layers of the
// packages under node_modules are not confused with it.
func isPatchLayer(relative string) bool {
	return strings.HasPrefix(relative, PatchLayer)
}

// copyFile copies one seed file, keeping its mode.
func copyFile(source, target string) error {
	info, err := os.Stat(source)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return err
	}
	in, err := os.Open(source)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, info.Mode().Perm())
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		_ = out.Close()
		return err
	}
	return out.Close()
}

// writeMarker writes the seed marker, which is what tells a later boot that this
// profile is the app's to update.
func writeMarker(path string, marker Marker) error {
	data, err := json.MarshalIndent(marker, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(data, '\n'), 0o644)
}
