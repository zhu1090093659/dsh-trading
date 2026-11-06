// Package shell is the mygo desktop shell for the dsh trading GUI. It owns one
// dsh host child process: it picks a loopback port, spawns the bundled node
// runtime on the bundled host with the trading profile, waits for the tokenized
// GUI URL the host prints, loads it in a window that trusts only that origin,
// prunes the browser-session cookies earlier launches left behind, and ends the
// host's process group when the app quits.
//
// The behaviour is the Electron shell's (desktop/src/main.cjs, runtime.cjs,
// attach-mode.cjs, preload.cjs), card by card: window and launcher, lifecycle
// (single instance, attach handoff, relaunch, host hooks), cookie pruning, and
// the window.desktop bridge. The Electron shell stays untouched while both
// coexist.
package shell

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/egoist/mygo"

	"github.com/dshtrading/desktop-mygo/internal/attach"
	"github.com/dshtrading/desktop-mygo/internal/cookies"
	"github.com/dshtrading/desktop-mygo/internal/hostwait"
	"github.com/dshtrading/desktop-mygo/internal/instance"
	"github.com/dshtrading/desktop-mygo/internal/launch"
	"github.com/dshtrading/desktop-mygo/internal/policy"
	"github.com/dshtrading/desktop-mygo/internal/recovery"
	"github.com/dshtrading/desktop-mygo/internal/renderer"
)

// Timing of one boot, and of the shutdown that ends it.
const (
	// readyTimeout bounds the wait for the host's tokenized GUI URL: the whole
	// boot is allowed to take this long (Electron's READY_TIMEOUT_MS).
	readyTimeout = 180 * time.Second
	// guiLoadTimeout bounds the wait for the GUI page itself once its URL is
	// known.
	guiLoadTimeout = 60 * time.Second
	// stopGrace is how long the host gets after SIGTERM before SIGKILL, as the
	// Electron shell's 5s force timer.
	stopGrace = 5 * time.Second
	// killWait bounds the wait for a process group to disappear after SIGKILL.
	killWait = 4 * time.Second
	// logTailLines is how much host output the error page carries.
	logTailLines = 200
	// windowTitle is the shell's own brand; the GUI's document title is the
	// host's.
	windowTitle = "DSH Trading"
	// localPageTimeout bounds the wait for one of the shell's own pages.
	localPageTimeout = 5 * time.Second
)

// The markers the shell's own pages carry, so the shell can tell which document
// the window is showing.
const (
	splashMarker = "splash"
	errorMarker  = "error"
)

// Options configure the shell. The zero value runs the product shell.
type Options struct {
	// Name is the application name; the user data and log directories derive
	// from it, so it also separates a drill's data from the product's.
	Name string
	// OnLoaded, when set, runs after every GUI load on a goroutine of its own.
	// The bridge drill uses it to drive the page-side assertions of the
	// window.desktop contract.
	OnLoaded func(*Shell)
}

// Metrics is what one run observed. It is the shell's own record: a drill
// writes it out, the product shell only logs it.
type Metrics struct {
	// Home is the DSH home the host runs against.
	Home string `json:"home"`
	// Port is the loopback port the GUI is served on.
	Port int `json:"port"`
	// HostCmd is the host command line, without the token.
	HostCmd string `json:"hostCmd"`
	// Boots is how many hosts this process started.
	Boots int `json:"boots"`
	// TokenWaitMs is how long the newest host took to print its GUI URL.
	TokenWaitMs int64 `json:"tokenWaitMs"`
	// CookiesBefore, CookiesPruned and CookiesAfter are the prune's counts.
	CookiesBefore int `json:"authCookiesBefore"`
	CookiesPruned int `json:"authCookiesPruned"`
	CookiesAfter  int `json:"authCookiesAfter"`
	// KillMs is how long ending the host's process group took.
	KillMs int64 `json:"killMs"`
	// ProcessGroupGone reports whether no process of that group outlived it.
	ProcessGroupGone bool `json:"processGroupGone"`
	// HostExit is how the host ended: reaped, already exited or not reaped.
	HostExit string `json:"hostExit"`
	// BridgeCalls counts the window.desktop calls the page made.
	BridgeCalls map[string]int `json:"bridgeCalls"`
	// UnexpectedExits is how many hosts left without the shell asking.
	UnexpectedExits int `json:"unexpectedExits"`
	// Recoveries is how many of those the shell restarted through.
	Recoveries int `json:"recoveries"`
	// RestartAttempt is the newest unexpected exit's place in the restart
	// budget, 0 when none has happened.
	RestartAttempt int `json:"restartAttempt"`
	// RestartBudgetSpent reports that the shell stopped restarting and parked
	// on the startown-problem page.
	RestartBudgetSpent bool `json:"restartBudgetSpent"`
	// Error is the failure the run ended on, if any.
	Error string `json:"error,omitempty"`
}

// Shell is one running desktop shell.
type Shell struct {
	opts Options

	mu      sync.Mutex
	metrics Metrics
	logTail []string
	logFile *os.File
	logName string
	win     *mygo.Window
	host    *hostProcess
	booting bool
	port    int
	origin  string
	lock    *instance.Lock
	// tokens is the tokenized URL of the host that is booting now; every boot
	// starts from none of it.
	tokens *hostwait.URLWaiter
	// budget counts the unexpected exits the shell restarted through.
	budget *recovery.Budget

	teardownOnce sync.Once
}

// New prepares the shell. It binds the window.desktop service, so it must run
// before App.Run.
func New(opts Options) *Shell {
	shell := &Shell{
		opts:    opts,
		metrics: Metrics{BridgeCalls: map[string]int{}},
		tokens:  &hostwait.URLWaiter{},
		budget:  recovery.NewBudget(),
	}
	mygo.BindAs("Desktop", desktopService{shell: shell})
	return shell
}

// Run runs the shell until the app quits. A second launch returns nil without
// starting anything: it has already asked the first instance to show its
// window.
func (s *Shell) Run() error {
	if s.opts.Name != "" {
		mygo.App.SetName(s.opts.Name)
	}
	lock, err := instance.Acquire(s.lockPath(), s.focusWindow)
	if err != nil {
		if errors.Is(err, instance.ErrRunning) {
			return nil
		}
		return err
	}
	s.lock = lock
	mygo.App.OnBeforeQuit(func(*mygo.QuitEvent) { s.teardown() })

	decision := attach.Decide(os.Getenv, func(url string) bool { return attach.ProbeHTTP(url, attach.ProbeTimeout) })
	s.logf("[desktop] %s", decision.Reason)
	if decision.Attach {
		mygo.App.WhenReady(func() {
			if err := mygo.Shell.OpenExternal(decision.URL); err != nil {
				s.logf("[desktop] opening the system browser failed: %v", err)
			}
			mygo.App.Quit()
		})
		if err := mygo.App.Run(); err != nil {
			return err
		}
		s.teardown()
		return nil
	}

	mygo.App.WhenReady(func() {
		s.openLog()
		if err := s.resolveOrigin(); err != nil {
			s.fail(err.Error())
			return
		}
		go s.boot()
	})
	err = mygo.App.Run()
	s.teardown()
	return err
}

// Metrics is a snapshot of what the run observed.
func (s *Shell) Metrics() Metrics {
	s.mu.Lock()
	defer s.mu.Unlock()
	metrics := s.metrics
	metrics.BridgeCalls = make(map[string]int, len(s.metrics.BridgeCalls))
	for name, count := range s.metrics.BridgeCalls {
		metrics.BridgeCalls[name] = count
	}
	return metrics
}

// Window is the shell's window, or nil while there is none.
func (s *Shell) Window() *mygo.Window { return s.window() }

// LogPath is the host log the shell appends to.
func (s *Shell) LogPath() string { return s.logPath() }

// Origin is the loopback origin the window trusts.
func (s *Shell) Origin() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.origin
}

// boot runs one boot attempt on the calling goroutine and puts a failure on the
// error page. A request that arrives while a boot is in flight is ignored: the
// Retry button and the page can both ask for one, and two hosts on one home is
// the one outcome the shell must never produce.
func (s *Shell) boot() {
	s.mu.Lock()
	if s.booting {
		s.mu.Unlock()
		s.logf("[desktop] a boot is already in progress; ignoring this request")
		return
	}
	s.booting = true
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		s.booting = false
		s.mu.Unlock()
	}()
	if err := s.bootOnce(); err != nil {
		s.logf("[desktop] boot failed: %v", err)
		s.setMetrics(func(m *Metrics) { m.Error = err.Error() })
		s.fail(err.Error())
	}
}

// bootOnce is one complete boot: prune, show the splash, spawn, wait for the
// tokenized URL, load it, count the jar.
func (s *Shell) bootOnce() error {
	resources, err := mygo.App.Path(mygo.PathResources)
	if err != nil {
		return err
	}
	paths := launch.ResolveRuntimePaths(resources)
	if err := paths.Validate(); err != nil {
		return err
	}
	selection := launch.SelectDshHome(os.Getenv, homeDir())
	if selection.Ignored != "" {
		s.logf("[desktop] ignored inherited DSH_HOME=%s (not a trading home); using %s", selection.Ignored, selection.Home)
	}
	s.mu.Lock()
	s.metrics.Home = selection.Home
	port, origin := s.port, s.origin
	s.mu.Unlock()
	if port == 0 || origin == "" {
		return errors.New("the shell has no loopback origin")
	}
	s.logf("[desktop] dsh home: %s", selection.Home)

	// The stale jar goes before the window exists, so the page that loads never
	// replays a cookie header grown past the host's request-header budget. A
	// prune that fails is logged and the boot goes on: the header budget above
	// still covers a grown jar.
	result := cookies.Prune(mygoCookieStore{}, origin+"/")
	s.setMetrics(func(m *Metrics) {
		m.CookiesBefore = result.Before
		m.CookiesPruned = result.Pruned
	})
	if result.Err != nil {
		s.logf("[desktop] auth cookie prune failed: %v", result.Err)
	} else if result.Pruned > 0 {
		s.logf("[desktop] pruned %d stale dsh auth cookie(s)", result.Pruned)
	}

	win, err := s.ensureWindow(origin)
	if err != nil {
		return err
	}
	// A retry replaces the host it is recovering from: never two on one home.
	if previous := s.takeHost(); previous != nil {
		s.stopHost(previous)
	}

	hooks, err := installHostHooks(filepath.Join(s.userDataDir(), "host-hooks"))
	if err != nil {
		return err
	}
	spec := launch.HostSpec{
		Paths:     paths,
		Hooks:     hooks,
		Port:      port,
		Home:      selection.Home,
		ShellPID:  os.Getpid(),
		ParentEnv: os.Environ(),
	}
	// The URL of the host that is gone belongs to a port nobody serves, so a
	// recovery starts from none at all (the Electron shell's 2026-10-15
	// ERR_CONNECTION_REFUSED on the dead host's port).
	s.tokens.Reset()
	s.SetStatus("Starting the dsh host…")
	s.logf("[desktop] spawning host on 127.0.0.1:%d", port)
	host, err := startHost(spec, func(line string) {
		s.tokens.Observe(line)
		s.logf("%s", line)
	}, s.onHostExit)
	if err != nil {
		return fmt.Errorf("the dsh host could not be started: %w", err)
	}
	s.setHost(host)
	s.setMetrics(func(m *Metrics) {
		m.Port = port
		m.HostCmd = spec.Paths.NodeBin + " " + strings.Join(spec.Args(), " ")
	})

	start := time.Now()
	target, err := s.tokens.Wait(host.exited, readyTimeout)
	if err != nil {
		return err
	}
	elapsed := time.Since(start)
	s.setMetrics(func(m *Metrics) {
		m.Boots++
		m.TokenWaitMs = elapsed.Milliseconds()
	})
	s.logf("[desktop] GUI ready after %dms, loading the tokenized URL", elapsed.Milliseconds())
	if err := win.Page().LoadURL(target); err != nil {
		return err
	}
	if err := s.waitGUILoaded(win, origin); err != nil {
		return err
	}
	if count, err := cookies.Count(mygoCookieStore{}, origin+"/"); err == nil {
		s.setMetrics(func(m *Metrics) { m.CookiesAfter = count })
	} else {
		s.logf("[desktop] counting the cookie jar failed: %v", err)
	}
	s.logf("[desktop] GUI loaded on %s", origin)
	if s.opts.OnLoaded != nil {
		go s.opts.OnLoaded(s)
	}
	return nil
}

// waitGUILoaded waits until the window shows the GUI of the current host, not
// the splash and not the page of a host that has gone.
func (s *Shell) waitGUILoaded(win *mygo.Window, origin string) error {
	deadline := time.Now().Add(guiLoadTimeout)
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	for {
		if s.guiReady(win, origin) {
			return nil
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("the GUI did not finish loading within %s", guiLoadTimeout)
		}
		select {
		case <-ticker.C:
		case <-s.hostExited():
			return errors.New("the dsh host exited before the GUI loaded")
		}
	}
}

// guiReady reports whether the window is on the GUI origin and its document has
// finished loading.
func (s *Shell) guiReady(win *mygo.Window, origin string) bool {
	href, err := mygo.EvalAs[string](win.Page(), "location.href")
	if err != nil || !strings.HasPrefix(href, origin) {
		return false
	}
	state, err := mygo.EvalAs[string](win.Page(), "document.readyState")
	return err == nil && state == "complete"
}

// showLocalPage loads one of the shell's own pages and waits until it is the
// document the window shows. Everything the shell sends a page afterwards (the
// splash status, the startup-problem payload) is delivered to the document that
// is loaded at that moment, so a page it replaced would take the message with it
// and the new one would stay empty.
func (s *Shell) showLocalPage(win *mygo.Window, html, marker string) {
	win.Page().LoadHTML(html, "")
	deadline := time.Now().Add(localPageTimeout)
	for {
		loaded, err := mygo.EvalAs[string](win.Page(), "String(window.__dshShellPage || '')")
		if err == nil && loaded == marker {
			return
		}
		if time.Now().After(deadline) {
			s.logf("[desktop] the %s page did not load within %s", marker, localPageTimeout)
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// ensureWindow creates the window, or reloads the splash of the one that is
// there. The window trusts the GUI's origin only, which is why the origin is
// resolved once per process, before any host starts.
func (s *Shell) ensureWindow(origin string) (*mygo.Window, error) {
	if win := s.window(); win != nil {
		s.showLocalPage(win, splashPage, splashMarker)
		return win, nil
	}
	win := mygo.NewWindow(mygo.WindowOptions{
		Title:           windowTitle,
		Width:           1440,
		Height:          900,
		MinWidth:        960,
		MinHeight:       600,
		BackgroundColor: "#0b1220",
		Page: mygo.PageOptions{
			PreloadScript:  bridgeShim,
			TrustedOrigins: []string{origin},
		},
	})
	if win == nil {
		return nil, errors.New("mygo created no window")
	}
	s.mu.Lock()
	s.win = win
	s.mu.Unlock()
	s.applyPagePolicy(win)
	s.applyPageDiagnostics(win)
	s.showLocalPage(win, splashPage, splashMarker)
	return win, nil
}

// applyPagePolicy installs the window rules desktop/src/main.cjs createWindow
// carries: the shell's brand survives the page's <title>, navigation stays on
// the GUI's own loopback origin, a window.open() never gets a window, and the
// page is granted no permission at all.
func (s *Shell) applyPagePolicy(win *mygo.Window) {
	page := win.Page()
	// The bundled web frontend keeps the host's own brand in document.title;
	// the shell window is branded DSH Trading and must not inherit it.
	page.OnPageTitleUpdated(func(e *mygo.TitleEvent) { e.PreventDefault() })
	page.OnWillNavigate(func(e *mygo.NavigateEvent) {
		decision := policy.Navigation(e.URL)
		if decision.Allow {
			return
		}
		e.PreventDefault()
		s.logf("[desktop] blocked a navigation to %s", launch.MaskText(e.URL))
		if decision.External != "" {
			s.openExternal(decision.External)
		}
	})
	page.SetWindowOpenHandler(func(req mygo.WindowOpenRequest) *mygo.WindowOptions {
		decision := policy.WindowOpen(req.URL)
		s.logf("[desktop] denied a window.open() for %s", launch.MaskText(req.URL))
		if decision.External != "" {
			s.openExternal(decision.External)
		}
		return nil
	})
	// mygo grants the pages of trusted origins whatever they ask for (see
	// SetPermissionHandler), the GUI's own origin included; the Electron window
	// is sandboxed and this shell needs none of it.
	page.SetPermissionHandler(func(req mygo.PermissionRequest) bool {
		requested := permissionNames(req.Permissions)
		if policy.PermissionAllowed(requested) {
			return true
		}
		s.logf("[desktop] denied a page permission request (%s) from %s", strings.Join(requested, ","), launch.MaskText(req.Origin))
		return false
	})
}

// applyPageDiagnostics writes the renderer failures mygo reports itself. The
// other two Electron channels, console-message and preload-error, have no mygo
// hook at all: the preload agent in bridgeShim carries those (see RendererLog).
func (s *Shell) applyPageDiagnostics(win *mygo.Window) {
	win.Page().OnRenderProcessGone(func(reason string) {
		s.logf("%s", renderer.ProcessGoneLine(reason))
	})
}

// permissionNames renders a permission request the way mygo states it, which is
// the list policy.PermissionAllowed answers.
func permissionNames(permissions []mygo.Permission) []string {
	names := make([]string, 0, len(permissions))
	for _, permission := range permissions {
		names = append(names, string(permission))
	}
	return names
}

// rendererLog writes one message the page reported. The mygo backend has no
// console-message hook, so the preload carries the levels the host log wants
// (see bridgeShim) and this writes them in the [renderer] line shape.
func (s *Shell) rendererLog(entry renderer.Entry) {
	if line := renderer.Line(entry); line != "" {
		s.logf("%s", line)
	}
}

// openExternal hands a URL to the system browser, and says so: the handoff is
// otherwise invisible next to a plain deny in the log.
func (s *Shell) openExternal(rawURL string) {
	s.logf("[desktop] opening %s in the system browser", launch.MaskText(rawURL))
	if err := mygo.Shell.OpenExternal(rawURL); err != nil {
		s.logf("[desktop] opening %s in the system browser failed: %v", launch.MaskText(rawURL), err)
	}
}

// resolveOrigin picks the loopback port this process serves the GUI on. It runs
// once, before the window exists: the window trusts that origin and cannot be
// given another one later.
func (s *Shell) resolveOrigin() error {
	port, err := launch.FindFreePort()
	if err != nil {
		return fmt.Errorf("no free loopback port: %w", err)
	}
	origin := fmt.Sprintf("http://127.0.0.1:%d", port)
	s.mu.Lock()
	s.port, s.origin = port, origin
	s.mu.Unlock()
	return nil
}

// teardown ends the host's process group and gives up the single-instance lock.
// It runs in the quit sequence, before mygo relaunches a new instance, so the
// lock is free by the time that instance starts.
func (s *Shell) teardown() {
	s.teardownOnce.Do(func() {
		if host := s.takeHost(); host != nil {
			s.stopHost(host)
		}
		s.mu.Lock()
		lock := s.lock
		s.lock = nil
		file := s.logFile
		s.logFile = nil
		s.mu.Unlock()
		if lock != nil {
			lock.Release()
		}
		if file != nil {
			_ = file.Close()
		}
	})
}

// stopHost ends one host and records how it went.
func (s *Shell) stopHost(host *hostProcess) {
	start := time.Now()
	exit := host.stop(stopGrace, killWait)
	elapsed := time.Since(start)
	gone := host.groupGone()
	code, signal := host.exitState()
	s.setMetrics(func(m *Metrics) {
		m.KillMs = elapsed.Milliseconds()
		m.ProcessGroupGone = gone
		m.HostExit = exit
	})
	diagnostic := launch.ExitDiagnosticFor(code, signal, platformName())
	s.logf("%s", launch.FormatExitLine(code, signal, true, time.Since(host.startedAt), diagnostic.Message))
}

// onHostExit answers a host the shell did not stop, with the restart budget
// desktop/src/main.cjs keeps: up to recovery.Max restarts inside
// recovery.Window, then the startup-problem page until a human Retry hands the
// budget back. A boot in flight reports its own failure and owns the window, so
// this only restarts the host under it.
func (s *Shell) onHostExit(code *int, signal string, expected bool) {
	if expected {
		return
	}
	diagnostic := launch.ExitDiagnosticFor(code, signal, platformName())
	s.logf("%s", launch.FormatExitLine(code, signal, false, 0, diagnostic.Message))
	plan := s.budget.Record(time.Now())
	s.mu.Lock()
	booting := s.booting
	s.mu.Unlock()
	s.setMetrics(func(m *Metrics) {
		m.UnexpectedExits++
		m.RestartAttempt = plan.Attempt
		m.RestartBudgetSpent = !plan.Recover
		if plan.Recover {
			m.Recoveries++
		}
	})
	if !plan.Recover {
		s.logf("[desktop] host restart budget spent; leaving the startup-problem page up (Retry resets it)")
		if !booting {
			s.showHostExitFailure(code, signal)
		}
		return
	}
	s.logf("[desktop] the shell did not ask for this exit; restarting the host (attempt %d/%d within %s)", plan.Attempt, plan.Max, plan.WindowShort())
	if !booting {
		s.ShowError(fmt.Sprintf("后台服务进程意外停止，正在自动重启（第 %d 次，最多 %d 次）…", plan.Attempt, plan.Max), false)
	}
	go s.boot()
}

// focusWindow brings the window of the running instance to the front, which is
// what a second launch asks for.
func (s *Shell) focusWindow() {
	s.logf("[desktop] a second launch asked for the window")
	win := s.window()
	if win == nil {
		return
	}
	win.Show()
	win.Restore()
	win.Focus()
}

// fail puts a startup failure on the error page, and quits when there is no
// window to put it on.
func (s *Shell) fail(message string) {
	s.ShowError(message, false)
}

// ShowError puts a startup problem on the error page: the page itself, then the
// desktop:error payload its script renders (message, host log tail, log path and
// whether the page offers the VC++ download).
func (s *Shell) ShowError(message string, missingVCRedist bool) {
	s.logf("[desktop] startup problem: %s", message)
	win := s.window()
	if win == nil {
		mygo.App.Quit()
		return
	}
	s.showLocalPage(win, errorPage, errorMarker)
	if err := errorEvent.Emit(win, s.errorPayload(message, missingVCRedist)); err != nil {
		s.logf("[desktop] showing the startup problem failed: %v", err)
	}
}

// showHostExitFailure reports a host that left on its own.
func (s *Shell) showHostExitFailure(code *int, signal string) {
	diagnostic := launch.ExitDiagnosticFor(code, signal, platformName())
	s.ShowError(diagnostic.Message, diagnostic.MissingVCRedist)
}

// errorPayload is what the error page renders.
func (s *Shell) errorPayload(message string, missingVCRedist bool) ErrorPayload {
	s.mu.Lock()
	tail := strings.Join(s.logTail, "\n")
	s.mu.Unlock()
	return ErrorPayload{
		Message:           message,
		Log:               tail,
		LogFile:           s.logPath(),
		IsMissingVCRedist: missingVCRedist,
	}
}

// SetStatus tells the pages what the shell is doing, on desktop:status. The
// splash page renders it, and the bridge drill uses it to observe a live
// onStatus subscription of the GUI page.
func (s *Shell) SetStatus(text string) {
	s.logf("[desktop] status: %s", text)
	if win := s.window(); win != nil {
		if err := statusEvent.Emit(win, text); err != nil {
			s.logf("[desktop] status event failed: %v", err)
		}
	}
}

// recordBridgeCall notes one window.desktop call the page made.
func (s *Shell) recordBridgeCall(name string) {
	s.mu.Lock()
	s.metrics.BridgeCalls[name]++
	s.mu.Unlock()
	s.logf("[desktop] window.desktop.%s called", name)
}

// window is the shell's window, nil while there is none and after it closed.
func (s *Shell) window() *mygo.Window {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.win == nil || s.win.IsDestroyed() {
		return nil
	}
	return s.win
}

// setHost makes host the current one.
func (s *Shell) setHost(host *hostProcess) {
	s.mu.Lock()
	s.host = host
	s.mu.Unlock()
}

// takeHost hands out the current host and forgets it.
func (s *Shell) takeHost() *hostProcess {
	s.mu.Lock()
	defer s.mu.Unlock()
	host := s.host
	s.host = nil
	return host
}

// hostExited is closed when the current host is gone, or nil when there is no
// host.
func (s *Shell) hostExited() <-chan struct{} {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.host == nil {
		return nil
	}
	return s.host.exited
}

// setMetrics updates the run record.
func (s *Shell) setMetrics(update func(*Metrics)) {
	s.mu.Lock()
	update(&s.metrics)
	s.mu.Unlock()
}

// logf writes one line to the shell log, masking the launch token on the way.
func (s *Shell) logf(format string, args ...any) {
	line := launch.MaskText(fmt.Sprintf(format, args...))
	s.mu.Lock()
	s.logTail = append(s.logTail, line)
	if len(s.logTail) > logTailLines {
		s.logTail = s.logTail[len(s.logTail)-logTailLines:]
	}
	file := s.logFile
	s.mu.Unlock()
	fmt.Fprintln(os.Stderr, line)
	if file != nil {
		if _, err := fmt.Fprintln(file, line); err != nil {
			return
		}
	}
}

// openLog opens the host log the error page links to, beside the Electron
// shell's dsh-host.log in the app's log directory.
func (s *Shell) openLog() {
	path := s.logPath()
	if path == "" {
		return
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		s.logf("[desktop] creating the log directory failed: %v", err)
		return
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		s.logf("[desktop] opening the log file failed: %v", err)
		return
	}
	s.mu.Lock()
	s.logFile = file
	s.mu.Unlock()
}

// logPath is the host log's path.
func (s *Shell) logPath() string {
	s.mu.Lock()
	cached := s.logName
	s.mu.Unlock()
	if cached != "" {
		return cached
	}
	dir, err := mygo.App.Path(mygo.PathLogs)
	if err != nil {
		return ""
	}
	path := filepath.Join(dir, "dsh-host.log")
	s.mu.Lock()
	s.logName = path
	s.mu.Unlock()
	return path
}

// userDataDir is where the shell keeps its own files: the instance lock and the
// host hooks it writes for the host process to import.
func (s *Shell) userDataDir() string {
	dir, err := mygo.App.Path(mygo.PathUserData)
	if err != nil {
		return filepath.Join(os.TempDir(), "dsh-mygo")
	}
	return dir
}

// lockPath is the single-instance lock file.
func (s *Shell) lockPath() string {
	return filepath.Join(s.userDataDir(), "instance.lock")
}

// mygoCookieStore is the app's own webview cookie jar.
type mygoCookieStore struct{}

// List reads the cookies a request to url would send.
func (mygoCookieStore) List(url string) ([]cookies.Cookie, error) {
	jar, err := mygo.Cookies.List(mygo.CookieFilter{URL: url})
	if err != nil {
		return nil, err
	}
	list := make([]cookies.Cookie, 0, len(jar))
	for _, cookie := range jar {
		list = append(list, cookies.Cookie{Name: cookie.Name, Domain: cookie.Domain, Path: cookie.Path})
	}
	return list, nil
}

// Delete removes one cookie.
func (mygoCookieStore) Delete(cookie cookies.Cookie) error {
	return mygo.Cookies.Delete(mygo.Cookie{Name: cookie.Name, Domain: cookie.Domain, Path: cookie.Path})
}

// homeDir is the user's home directory.
func homeDir() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return home
}

// platformName names the platform the way the Electron helpers do.
func platformName() string {
	if runtime.GOOS == "windows" {
		return "win32"
	}
	return runtime.GOOS
}
