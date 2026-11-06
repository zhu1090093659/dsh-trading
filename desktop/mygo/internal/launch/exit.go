package launch

import (
	"strconv"
	"strings"
	"time"
)

// ExitDiagnostic is what the error page tells the user about a host that left.
type ExitDiagnostic struct {
	Message string
	// MissingVCRedist marks the Windows STATUS_DLL_NOT_FOUND exit, the one
	// failure the error page offers a download for.
	MissingVCRedist bool
}

// ExitDiagnosticFor explains one host exit, mirroring
// desktop/src/runtime.cjs:formatHostExitDiagnostic. code is nil when the
// process ended on a signal, signal is empty when it exited on its own.
func ExitDiagnosticFor(code *int, signal string, goos string) ExitDiagnostic {
	// 0xC0000135 = 3221225781 unsigned, or -1073741515 signed 32-bit int:
	// Windows NTSTATUS STATUS_DLL_NOT_FOUND, the VC++ runtime missing.
	if goos == "win32" && code != nil && (*code == 3221225781 || *code == -1073741515) {
		return ExitDiagnostic{
			Message:         "后台服务进程启动失败（错误代码 0xC0000135: STATUS_DLL_NOT_FOUND），缺少 Microsoft Visual C++ 2015-2022 运行库（x64）。",
			MissingVCRedist: true,
		}
	}
	if signal != "" {
		return ExitDiagnostic{Message: "后台服务进程被系统信号终止: " + signal}
	}
	if code != nil && *code != 0 {
		return ExitDiagnostic{Message: "后台服务进程异常退出，退出码: " + strconv.Itoa(*code)}
	}
	return ExitDiagnostic{Message: "后台服务进程意外停止。"}
}

// FormatExitLine is one `host exited` log line: the code and signal pair cannot
// say who ended the host (the profile boot turns SIGTERM into a graceful
// shutdown reporting the same code=0 signal=null as an ordinary quit), so the
// initiating side and the host's age ride the same line.
func FormatExitLine(code *int, signal string, shellInitiated bool, elapsed time.Duration, message string) string {
	parts := []string{
		"[desktop] host exited: code=" + formatCode(code),
		"signal=" + formatSignal(signal),
		"initiatedBy=" + map[bool]string{true: "shell", false: "host"}[shellInitiated],
	}
	if elapsed >= 0 {
		parts = append(parts, "after="+strconv.FormatInt(elapsed.Milliseconds(), 10)+"ms")
	}
	return strings.Join(parts, " ") + " (" + message + ")"
}

// formatCode renders an exit code the way the Electron shell logs it, with
// null for a process that never exited on its own.
func formatCode(code *int) string {
	if code == nil {
		return "null"
	}
	return strconv.Itoa(*code)
}

// formatSignal renders a signal name, with null for none.
func formatSignal(signal string) string {
	if signal == "" {
		return "null"
	}
	return signal
}
