package main

// The mygo automation plugin is the shell's agent channel: it listens on the
// Unix socket MYGO_AUTOMATION names and answers windows, tree, eval, capture and
// idle (see internal/automation for the client and cmd/agentctl for the command).
//
// The import is unconditional, so the switch that decides whether the channel
// exists is the build's: mygo build -debug and MYGO_INSPECTOR=1 mygo build keep
// the inspector and with it the plugin, while a plain release build passes
// -tags mygo_noinspector and the plugin's own off.go says the channel is not
// there instead of leaving a client waiting.
import (
	_ "github.com/egoist/mygo/plugins/automation"
)
