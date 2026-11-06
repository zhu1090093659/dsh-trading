package launch

import (
	"testing"
	"time"
)

// intPtr is a pointer to v, for the exit code of a process that exited.
func intPtr(v int) *int { return &v }

func TestExitDiagnosticForNamesTheCause(t *testing.T) {
	cases := []struct {
		name   string
		code   *int
		signal string
		goos   string
		want   string
		vc     bool
	}{
		{name: "clean exit", code: intPtr(0), goos: "darwin", want: "后台服务进程意外停止。"},
		{name: "exit code", code: intPtr(1), goos: "darwin", want: "后台服务进程异常退出，退出码: 1"},
		{name: "signal", signal: "killed", goos: "darwin", want: "后台服务进程被系统信号终止: killed"},
		{
			name: "windows dll not found",
			code: intPtr(3221225781),
			goos: "win32",
			want: "后台服务进程启动失败（错误代码 0xC0000135: STATUS_DLL_NOT_FOUND），缺少 Microsoft Visual C++ 2015-2022 运行库（x64）。",
			vc:   true,
		},
		{
			name: "signed dll code",
			code: intPtr(-1073741515),
			goos: "win32",
			want: "后台服务进程启动失败（错误代码 0xC0000135: STATUS_DLL_NOT_FOUND），缺少 Microsoft Visual C++ 2015-2022 运行库（x64）。",
			vc:   true,
		},
		{
			name: "the same code elsewhere is not the VC++ case",
			code: intPtr(3221225781),
			goos: "darwin",
			want: "后台服务进程异常退出，退出码: 3221225781",
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := ExitDiagnosticFor(c.code, c.signal, c.goos)
			if got.Message != c.want {
				t.Errorf("Message = %q, want %q", got.Message, c.want)
			}
			if got.MissingVCRedist != c.vc {
				t.Errorf("MissingVCRedist = %v, want %v", got.MissingVCRedist, c.vc)
			}
		})
	}
}

func TestFormatExitLineCarriesWhoEndedTheHost(t *testing.T) {
	line := FormatExitLine(intPtr(0), "", true, 1234*time.Millisecond, "shell-initiated stop")
	want := "[desktop] host exited: code=0 signal=null initiatedBy=shell after=1234ms (shell-initiated stop)"
	if line != want {
		t.Errorf("FormatExitLine = %q, want %q", line, want)
	}
}

func TestFormatExitLineNamesASignalAndTheHostSide(t *testing.T) {
	line := FormatExitLine(nil, "terminated", false, 50*time.Millisecond, "host side")
	want := "[desktop] host exited: code=null signal=terminated initiatedBy=host after=50ms (host side)"
	if line != want {
		t.Errorf("FormatExitLine = %q, want %q", line, want)
	}
}
