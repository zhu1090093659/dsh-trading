package shell

import (
	_ "embed"
	"os"
	"path/filepath"
)

// The host load hooks. They are the equivalents of desktop/src/host-*.mjs,
// which stay the source of truth while both shells coexist: the host is an
// external node process, so anything that has to happen *inside* it (symbol
// normalization, exit attribution, the orphan guard) has to be a module it
// imports.
//
//go:embed hooks/host-symbol-normalizer.mjs
var symbolNormalizerHook string

//go:embed hooks/host-exit-tracer.mjs
var exitTracerHook string

//go:embed hooks/host-orphan-guard.mjs
var orphanGuardHook string

// hostHooks are written to disk and imported in this order: the tracer declares
// the lifecycle prefix the guard's lines carry, and the symbol normalizer has
// to be registered before the host's own modules load.
var hostHooks = []struct {
	name   string
	source string
}{
	{"host-symbol-normalizer.mjs", symbolNormalizerHook},
	{"host-exit-tracer.mjs", exitTracerHook},
	{"host-orphan-guard.mjs", orphanGuardHook},
}

// installHostHooks writes the hooks into dir and returns their paths, in import
// order.
func installHostHooks(dir string) ([]string, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	paths := make([]string, 0, len(hostHooks))
	for _, hook := range hostHooks {
		path := filepath.Join(dir, hook.name)
		if err := os.WriteFile(path, []byte(hook.source), 0o644); err != nil {
			return nil, err
		}
		paths = append(paths, path)
	}
	return paths, nil
}
