package launch

import (
	"os"
	"path/filepath"
	"testing"
)

func TestResolveRuntimePathsFollowsThePackagedLayout(t *testing.T) {
	paths := ResolveRuntimePaths("/Applications/DSH Trading.app/Contents/Resources")
	root := filepath.Join("/Applications/DSH Trading.app/Contents/Resources", "runtime")
	if paths.Root != root {
		t.Errorf("Root = %q, want %q", paths.Root, root)
	}
	if want := filepath.Join(root, "node", "bin", "node"); paths.NodeBin != want {
		t.Errorf("NodeBin = %q, want %q", paths.NodeBin, want)
	}
	if want := filepath.Join(root, "node"); paths.NodeHome != want {
		t.Errorf("NodeHome = %q, want %q", paths.NodeHome, want)
	}
	want := filepath.Join(root, "host", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js")
	if paths.HostBin != want {
		t.Errorf("HostBin = %q, want %q", paths.HostBin, want)
	}
}

func TestValidateReportsTheMissingPayloadFile(t *testing.T) {
	paths := ResolveRuntimePaths(t.TempDir())
	if err := paths.Validate(); err == nil {
		t.Fatal("Validate err = nil, want the missing node binary reported")
	}
	if err := os.MkdirAll(filepath.Dir(paths.NodeBin), 0o755); err != nil {
		t.Fatalf("MkdirAll err = %v", err)
	}
	if err := os.WriteFile(paths.NodeBin, []byte("#!/bin/sh"), 0o755); err != nil {
		t.Fatalf("writing node err = %v", err)
	}
	if err := os.WriteFile(paths.HostBin, nil, 0o644); err != nil {
		_ = os.MkdirAll(filepath.Dir(paths.HostBin), 0o755)
		if err := os.WriteFile(paths.HostBin, nil, 0o644); err != nil {
			t.Fatalf("writing the host bin err = %v", err)
		}
	}
	if err := paths.Validate(); err != nil {
		t.Fatalf("Validate err = %v, want nil", err)
	}
	if err := os.Remove(paths.HostBin); err != nil {
		t.Fatalf("Remove err = %v", err)
	}
	if err := paths.Validate(); err == nil {
		t.Fatal("Validate err = nil, want the missing host reported")
	}
}
