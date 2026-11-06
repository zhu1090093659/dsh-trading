// Command mygo-drill drives acceptance runs of the mygo shell on a machine with
// a GUI session, and writes what it observed as JSON.
//
// It is the evidence harness of the migration cards, not part of the shipped
// shell: it composes internal/shell unchanged and adds the page-side assertions
// of the window.desktop contract (selfcheck.js) plus the seven calls the bridge
// has to answer. The product shell (desktop/mygo/main.go) never needs it.
//
// Environment (GUI phases):
//
//	DRILL_OUT   directory for the reports and phase markers (required)
//	DRILL_MODE  cookies (default) or bridge
//
// bridge runs the app twice: the first launch drives six of the seven
// window.desktop members and ends by calling relaunch(), and the instance it
// starts drives the seventh (quit) and writes the report carrying all seven.
//
// The proctree command is the exception: it starts no GUI of its own, runs the
// shell as its own child and writes the process-tree evidence (proctree.go,
// proctree -h for the flags).
package main

import (
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"time"

	"github.com/egoist/mygo"

	"github.com/dshtrading/desktop-mygo/internal/shell"
)

//go:embed selfcheck.js
var selfcheckJS string

// drillName keeps the drill's user data directory (and so its cookie jar) away
// from the product shell's.
const drillName = "DSH Mygo Drill"

const (
	// watchdog bounds one phase; the report then says what it never saw.
	watchdog = 8 * time.Minute
	// phaseWait bounds one page-side step.
	phaseWait = 120 * time.Second
	// exitWait is how long a quit or a relaunch gets before it counts as failed.
	exitWait = 20 * time.Second
	// statusText and errorText are what the drill sends through the two events.
	statusText = "drill: status bridge"
	errorText  = "drill: startup problem page"
)

// The page-side steps of the bridge drill.
const (
	// subscribeJS installs the two event subscriptions of the GUI document.
	subscribeJS = `(function () {
  if (window.__drill) return 'already';
  window.__drill = { status: null, error: null };
  window.desktop.onStatus(function (text) { window.__drill.status = String(text); });
  window.desktop.onError(function (payload) { window.__drill.error = String(payload && payload.message); });
  return 'subscribed';
})()`
	// receiptsJS reads back what the two subscriptions received.
	receiptsJS = `(function () {
  var state = window.__drill || {};
  return {
    status: state.status === null || state.status === undefined ? '' : String(state.status),
    error: state.error === null || state.error === undefined ? '' : String(state.error)
  };
})()`
	// errorStateJS reads what the error page rendered from its desktop:error, and
	// which shell page the document is.
	errorStateJS = `(function () {
  var message = document.getElementById('message');
  var log = document.getElementById('log');
  var vcredist = document.getElementById('vcredist');
  return {
    page: String(window.__dshShellPage || ''),
    message: message ? message.textContent : '',
    logLength: log ? log.textContent.length : -1,
    vcredistVisible: vcredist ? vcredist.style.display !== 'none' : false,
    readyState: String(document.readyState)
  };
})()`
	// clickRetryJS clicks the error page's own Retry button, and refuses to click
	// anything at all unless the document is the error page: the GUI's own
	// Retry buttons must never be mistaken for the shell's.
	clickRetryJS = `(function () {
  if (window.__dshShellPage !== 'error') return 'not-the-error-page:' + String(window.__dshShellPage || 'none');
  var button = document.getElementById('retry');
  if (!button) return 'no-retry-button';
  button.click();
  return 'clicked';
})()`
	// callRevealLogJS and callVCRedistJS are the two shell actions the error page
	// offers, driven from the page exactly as its buttons drive them.
	callRevealLogJS = `window.desktop.revealLog()`
	callVCRedistJS  = `window.desktop.openVCRedistDownload()`
	// scheduleRelaunchJS and scheduleQuitJS let the call land before the app
	// leaves, so its reply reaches the page and the drill can read it.
	scheduleRelaunchJS = `(function () {
  setTimeout(function () { window.desktop.relaunch(); }, 0);
  return 'scheduled';
})()`
	scheduleQuitJS = `(function () {
  setTimeout(function () { window.desktop.quit(); }, 0);
  return 'scheduled';
})()`
)

// desktopMembers are the seven window.desktop members the contract names.
var desktopMembers = []string{"onStatus", "onError", "retry", "revealLog", "openVCRedistDownload", "quit", "relaunch"}

// usage is the drill's own help: the GUI phases read their environment, and the
// proctree command is the one that needs no GUI of its own.
const usage = `mygo-drill drives acceptance runs of the mygo shell.

  mygo-drill             run one GUI drill phase (environment below)
  mygo-drill proctree    process-tree evidence, no GUI of its own
                         (mygo-drill proctree -h for the flags and the report)

Environment of the GUI phases:
  DRILL_OUT   directory for the reports and phase markers (required)
  DRILL_MODE  cookies (default), bridge, recovery or policy
`

func main() {
	// The process-tree evidence observes the shell instead of being one, so it
	// must not create a window of its own first.
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "proctree":
			os.Exit(runProctree(os.Args[2:], os.Stderr))
		case "help", "-h", "-help", "--help":
			fmt.Fprint(os.Stderr, usage)
			return
		}
	}
	out := os.Getenv("DRILL_OUT")
	mode := os.Getenv("DRILL_MODE")
	if out == "" {
		fmt.Fprintln(os.Stderr, "drill: DRILL_OUT is required")
		os.Exit(2)
	}
	if mode == "" {
		mode = "cookies"
	}
	if mode != "cookies" && mode != "bridge" && mode != "recovery" && mode != "policy" {
		fmt.Fprintf(os.Stderr, "drill: unknown DRILL_MODE %q\n", mode)
		os.Exit(2)
	}
	run := &drill{
		out:     out,
		mode:    mode,
		phase:   mode,
		started: time.Now(),
		methods: map[string]*method{},
		checks:  map[string]bool{},
	}
	for _, name := range desktopMembers {
		run.methods[name] = &method{}
	}
	mygo.App.OnQuit(run.writeReport)
	time.AfterFunc(watchdog, func() { run.abort("the drill timed out") })
	if err := shell.New(shell.Options{Name: drillName, OnLoaded: run.onLoaded}).Run(); err != nil {
		run.abort("the shell exited with an error: " + err.Error())
	}
}

// pageState is what selfcheck.js reports about the loaded page.
type pageState struct {
	Origin         string   `json:"origin"`
	Href           string   `json:"href"`
	Title          string   `json:"title"`
	ReadyState     string   `json:"readyState"`
	TextLen        int      `json:"textLen"`
	PluginStyles   int      `json:"pluginStyles"`
	Present        []string `json:"present"`
	Missing        []string `json:"missing"`
	DesktopPresent bool     `json:"desktopPresent"`
}

// has reports whether the page had that member.
func (p pageState) has(name string) bool {
	for _, got := range p.Present {
		if got == name {
			return true
		}
	}
	return false
}

// method is what one window.desktop member did when the page used it.
type method struct {
	Present  bool   `json:"present"`
	Invoked  bool   `json:"invoked"`
	Observed string `json:"observed"`
}

// statusReceipts is what the two event subscriptions received.
type statusReceipts struct {
	Status string `json:"status"`
	Error  string `json:"error"`
}

// errorState is what the error page rendered.
type errorState struct {
	Page            string `json:"page"`
	Message         string `json:"message"`
	LogLength       int    `json:"logLength"`
	VCRedistVisible bool   `json:"vcredistVisible"`
	ReadyState      string `json:"readyState"`
}

// report is one drill run's evidence.
type report struct {
	Mode       string             `json:"mode"`
	Phase      string             `json:"phase"`
	PID        int                `json:"pid"`
	StartedAt  string             `json:"startedAt"`
	FinishedAt string             `json:"finishedAt"`
	OK         bool               `json:"ok"`
	Error      string             `json:"error,omitempty"`
	Checks     map[string]bool    `json:"checks"`
	Metrics    shell.Metrics      `json:"metrics"`
	Page       pageState          `json:"page"`
	Methods    map[string]*method `json:"desktopMethods"`
	Steps      []step             `json:"steps,omitempty"`
	Log        logEvidence        `json:"log,omitempty"`
}

// step is one observable the drill drove and what it saw.
type step struct {
	Name     string `json:"step"`
	OK       bool   `json:"ok"`
	Observed string `json:"observed"`
}

// logEvidence is what the drill read back from the host log the shell wrote:
// the lines that say a recovery happened, that the budget ran out, and that a
// page message reached the log.
type logEvidence struct {
	Path          string   `json:"path"`
	RestartLines  []string `json:"restartLines,omitempty"`
	BudgetLines   []string `json:"budgetSpentLines,omitempty"`
	RendererLines []string `json:"rendererLines,omitempty"`
	BlockedLines  []string `json:"blockedLines,omitempty"`
}

// drill is one running drill.
type drill struct {
	out   string
	mode  string
	phase string

	mu        sync.Mutex
	sh        *shell.Shell
	runOnce   sync.Once
	lastPage  pageState
	methods   map[string]*method
	checks    map[string]bool
	failure   string
	started   time.Time
	written   bool
	steps     []step
	logOffset int64
}

// onLoaded runs after every GUI load of the shell.
func (d *drill) onLoaded(s *shell.Shell) {
	d.mu.Lock()
	d.sh = s
	d.mu.Unlock()
	d.runOnce.Do(func() { go d.run() })
}

// run drives the phase this process is for.
func (d *drill) run() {
	d.phase = d.currentPhase()
	d.captureLogOffset()
	d.logf("drill: phase %s", d.phase)
	var err error
	switch {
	case d.mode == "bridge" && d.phase == "bridge-2":
		err = d.runBridgeSecond()
	case d.mode == "bridge":
		err = d.runBridgeFirst()
	case d.mode == "recovery":
		err = d.runRecovery()
	case d.mode == "policy":
		err = d.runPolicy()
	default:
		err = d.runCookies()
	}
	if err != nil {
		d.abort(err.Error())
	}
}

// currentPhase names the phase from the markers the previous launch left.
func (d *drill) currentPhase() string {
	if d.mode != "bridge" {
		return d.mode
	}
	if fileExists(filepath.Join(d.out, "bridge-phase-1.done")) {
		return "bridge-2"
	}
	return "bridge-1"
}

// runCookies is one plain launch: boot, load the GUI, count the jar, quit.
func (d *drill) runCookies() error {
	state, err := d.waitRendered()
	if err != nil {
		return err
	}
	d.recordPage(state)
	d.check("guiRendered", state.ReadyState == "complete" && state.TextLen > 0)
	d.check("desktopBridgePresent", len(state.Missing) == 0)
	d.check("tokenFromHostLine", d.metrics().TokenWaitMs > 0)
	d.check("authCookiesAfterLoad", d.metrics().CookiesAfter >= 1)
	d.recordPresence(state, "present but not driven in cookies mode")
	mygo.App.Quit()
	<-time.After(exitWait)
	return errors.New("the app did not quit within " + exitWait.String())
}

// runBridgeFirst drives six members and hands the app over to the relaunched
// instance, which drives the seventh.
func (d *drill) runBridgeFirst() error {
	state, err := d.waitRendered()
	if err != nil {
		return err
	}
	d.recordPage(state)
	d.check("guiRendered", state.ReadyState == "complete" && state.TextLen > 0)
	d.check("tokenFromHostLine", d.metrics().TokenWaitMs > 0)

	// onStatus: the GUI page subscribes, the shell emits, the callback fires.
	if _, err := d.eval(subscribeJS); err != nil {
		return err
	}
	d.shellInstance().SetStatus(statusText)
	receipt, err := d.waitStatusReceipt()
	if err != nil {
		return err
	}
	d.record("onStatus", state.has("onStatus"), "the page callback received "+quote(receipt))
	d.logf("drill: onStatus observed: %s", quote(receipt))

	// onError: the startup-problem page subscribes to the same event and renders
	// the payload the shell sends it.
	d.shellInstance().ShowError(errorText, false)
	rendered, err := d.waitErrorPage()
	if err != nil {
		return err
	}
	d.record("onError", state.has("onError"), "the error page rendered "+quote(rendered.Message))
	d.logf("drill: onError observed: message=%s logLength=%d vcredistVisible=%v", quote(rendered.Message), rendered.LogLength, rendered.VCRedistVisible)

	// retry: the error page's own button, and a second host answering.
	boots := d.metrics().Boots
	clicked, err := d.eval(clickRetryJS)
	if err != nil {
		return err
	}
	if clicked != "clicked" {
		return errors.New("the error page's Retry button did not answer: " + clicked)
	}
	d.logf("drill: retry button: %s", clicked)
	if err := d.waitGui(boots + 1); err != nil {
		return err
	}
	metrics := d.metrics()
	d.record("retry", state.has("retry"), fmt.Sprintf("boot #%d printed its GUI URL in %dms", metrics.Boots, metrics.TokenWaitMs))
	d.logf("drill: retry observed: boot #%d after %dms", metrics.Boots, metrics.TokenWaitMs)

	// revealLog and openVCRedistDownload: both answer the page and act.
	revealed, err := d.eval(callRevealLogJS)
	if err != nil {
		return err
	}
	d.record("revealLog", state.has("revealLog"), "the shell revealed "+quote(d.shellInstance().LogPath())+", reply "+quote(revealed))
	d.logf("drill: revealLog observed: %s", quote(revealed))
	opened, err := d.eval(callVCRedistJS)
	if err != nil {
		return err
	}
	d.record("openVCRedistDownload", state.has("openVCRedistDownload"), "the shell opened the VC++ download, reply "+quote(opened))
	d.logf("drill: openVCRedistDownload observed: %s", quote(opened))

	// relaunch: this process leaves, and the instance it starts is phase two.
	if _, err := d.eval(scheduleRelaunchJS); err != nil {
		return err
	}
	d.record("relaunch", state.has("relaunch"), "scheduled through window.desktop.relaunch(); the relaunched instance is phase two")
	d.persistMethods()
	d.writeMarker("bridge-phase-1.done")
	<-time.After(exitWait)
	return errors.New("the app did not relaunch within " + exitWait.String())
}

// runBridgeSecond drives quit, the seventh member, and lets the quit sequence
// write the report that carries all seven.
func (d *drill) runBridgeSecond() error {
	d.loadMethods()
	state, err := d.waitRendered()
	if err != nil {
		return err
	}
	d.recordPage(state)
	d.check("guiRendered", state.ReadyState == "complete" && state.TextLen > 0)
	d.check("tokenFromHostLine", d.metrics().TokenWaitMs > 0)
	d.record("relaunch", state.has("relaunch"), "this launch is the instance window.desktop.relaunch() started")
	if _, err := d.eval(scheduleQuitJS); err != nil {
		return err
	}
	d.record("quit", state.has("quit"), "scheduled through window.desktop.quit(); the shell quits and stops the host")
	d.writeMarker("bridge-phase-2.done")
	<-time.After(exitWait)
	return errors.New("the app did not quit within " + exitWait.String())
}

// waitRendered probes the page until its document painted something: the GUI
// is a single-page app that reports complete before it draws.
func (d *drill) waitRendered() (pageState, error) {
	deadline := time.Now().Add(30 * time.Second)
	var last pageState
	var lastErr error
	for {
		state, err := d.probe()
		last, lastErr = state, err
		if err == nil && state.ReadyState == "complete" && state.TextLen > 0 {
			return state, nil
		}
		if time.Now().After(deadline) {
			return last, lastErr
		}
		time.Sleep(100 * time.Millisecond)
	}
}

// probe reads the page's own view of itself.
func (d *drill) probe() (pageState, error) {
	page := d.page()
	if page == nil {
		return pageState{}, errors.New("the shell has no page")
	}
	return mygo.EvalAs[pageState](page, selfcheckJS)
}

// eval runs one expression in the page and returns its string value.
func (d *drill) eval(code string) (string, error) {
	page := d.page()
	if page == nil {
		return "", errors.New("the shell has no page")
	}
	return mygo.EvalAs[string](page, code)
}

// waitStatusReceipt waits until the GUI page's onStatus callback fired.
func (d *drill) waitStatusReceipt() (string, error) {
	deadline := time.Now().Add(phaseWait)
	for {
		receipts, err := mygo.EvalAs[statusReceipts](d.page(), receiptsJS)
		if err == nil && receipts.Status != "" {
			return receipts.Status, nil
		}
		if time.Now().After(deadline) {
			return "", errors.New("the GUI page's onStatus callback never fired")
		}
		time.Sleep(200 * time.Millisecond)
	}
}

// waitErrorPage waits until the error page rendered the payload it was sent.
func (d *drill) waitErrorPage() (errorState, error) {
	deadline := time.Now().Add(phaseWait)
	for i := 0; ; i++ {
		state, err := mygo.EvalAs[errorState](d.page(), errorStateJS)
		if err == nil && state.Page == "error" && state.Message != "" {
			return state, nil
		}
		if i%25 == 0 {
			d.logf("drill: waiting for the error page: err=%v page=%s message=%s readyState=%s", err, quote(state.Page), quote(state.Message), quote(state.ReadyState))
		}
		if time.Now().After(deadline) {
			return errorState{}, errors.New("the error page never rendered a desktop:error payload")
		}
		time.Sleep(200 * time.Millisecond)
	}
}

// waitGui waits for the boot to reach want hosts and for that host's GUI to be
// on screen.
func (d *drill) waitGui(want int) error {
	origin := d.shellInstance().Origin()
	deadline := time.Now().Add(phaseWait)
	for {
		if d.metrics().Boots >= want {
			state, err := d.probe()
			if err == nil && state.Origin == origin && state.ReadyState == "complete" && len(state.Missing) == 0 {
				d.recordPage(state)
				return nil
			}
		}
		if time.Now().After(deadline) {
			return errors.New("the GUI did not come back within " + phaseWait.String())
		}
		time.Sleep(200 * time.Millisecond)
	}
}

// recordPage remembers the newest page state.
func (d *drill) recordPage(state pageState) {
	d.mu.Lock()
	d.lastPage = state
	d.mu.Unlock()
}

// recordPresence notes which of the seven members the page had, without
// claiming any of them were driven; a member the Go service recorded still
// shows up as invoked, from the bridge call receipts.
func (d *drill) recordPresence(state pageState, note string) {
	d.mu.Lock()
	defer d.mu.Unlock()
	for _, name := range desktopMembers {
		entry := d.methods[name]
		if entry == nil {
			entry = &method{}
			d.methods[name] = entry
		}
		entry.Present = state.has(name)
		entry.Observed = note
	}
}

// record stores what one member did.
func (d *drill) record(name string, present bool, observed string) {
	d.mu.Lock()
	entry := d.methods[name]
	if entry == nil {
		entry = &method{}
		d.methods[name] = entry
	}
	entry.Present = present
	entry.Invoked = true
	entry.Observed = observed
	d.mu.Unlock()
}

// check records one acceptance check.
func (d *drill) check(name string, ok bool) {
	d.mu.Lock()
	d.checks[name] = ok
	d.mu.Unlock()
}

// shellInstance is the running shell.
func (d *drill) shellInstance() *shell.Shell {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.sh
}

// metrics is the shell's current run record.
func (d *drill) metrics() shell.Metrics {
	if s := d.shellInstance(); s != nil {
		return s.Metrics()
	}
	return shell.Metrics{}
}

// page is the shell's page, nil while there is no window.
func (d *drill) page() *mygo.Page {
	s := d.shellInstance()
	if s == nil {
		return nil
	}
	win := s.Window()
	if win == nil {
		return nil
	}
	return win.Page()
}

// abort records a failure and quits: the quit sequence stops the host and
// writes the report, so a failed drill never leaves a host behind.
func (d *drill) abort(reason string) {
	d.mu.Lock()
	if d.failure == "" {
		d.failure = reason
	}
	d.mu.Unlock()
	d.logf("drill: FAILED: %s", reason)
	mygo.App.Quit()
}

// writeReport writes this run's evidence. It runs in the quit sequence, after
// the host is gone, so the kill numbers are part of it.
func (d *drill) writeReport() {
	d.mu.Lock()
	if d.written {
		d.mu.Unlock()
		return
	}
	d.written = true
	methods := make(map[string]*method, len(d.methods))
	for name, entry := range d.methods {
		copied := *entry
		methods[name] = &copied
	}
	checks := make(map[string]bool, len(d.checks))
	for name, ok := range d.checks {
		checks[name] = ok
	}
	page, failure, phase := d.lastPage, d.failure, d.phase
	started := d.started
	steps := append([]step(nil), d.steps...)
	d.mu.Unlock()

	metrics := d.metrics()
	// A member the Go service recorded was invoked, whether or not the page
	// waited for its reply.
	for name, entry := range methods {
		if metrics.BridgeCalls[name] > 0 {
			entry.Invoked = true
		}
	}
	switch phase {
	case "bridge-1":
		// The seventh member, quit, belongs to the instance the relaunch
		// starts; this report answers for the other six.
		driven := true
		for _, name := range desktopMembers {
			if name == "quit" {
				continue
			}
			if entry := methods[name]; entry == nil || !entry.Present || !entry.Invoked {
				driven = false
			}
		}
		checks["bridgeSixOfSeven"] = driven
	case "bridge-2":
		all := true
		for _, name := range desktopMembers {
			if entry := methods[name]; entry == nil || !entry.Present || !entry.Invoked {
				all = false
			}
		}
		checks["bridgeCallOK"] = all
	}
	ok := failure == ""
	for _, passed := range checks {
		if !passed {
			ok = false
		}
	}

	result := report{
		Mode:       d.mode,
		Phase:      phase,
		PID:        os.Getpid(),
		StartedAt:  started.UTC().Format(time.RFC3339Nano),
		FinishedAt: time.Now().UTC().Format(time.RFC3339Nano),
		OK:         ok,
		Error:      failure,
		Checks:     checks,
		Metrics:    metrics,
		Page:       page,
		Methods:    methods,
		Steps:      steps,
	}
	if d.mode == "recovery" || d.mode == "policy" {
		result.Log = d.logEvidence()
	}
	blob, err := json.MarshalIndent(result, "", "  ")
	if err != nil {
		d.logf("drill: encoding the report failed: %v", err)
		return
	}
	path := filepath.Join(d.out, fmt.Sprintf("report-%s-%d.json", phase, os.Getpid()))
	if err := os.WriteFile(path, append(blob, '\n'), 0o644); err != nil {
		d.logf("drill: writing %s failed: %v", path, err)
		return
	}
	d.logf("drill: wrote %s", path)
}

// persistMethods hands this phase's evidence to the relaunched instance.
func (d *drill) persistMethods() {
	d.mu.Lock()
	blob, err := json.Marshal(d.methods)
	d.mu.Unlock()
	if err != nil {
		d.logf("drill: encoding the method evidence failed: %v", err)
		return
	}
	if err := os.WriteFile(filepath.Join(d.out, "bridge-methods.json"), blob, 0o644); err != nil {
		d.logf("drill: writing the method evidence failed: %v", err)
	}
}

// loadMethods reads what the previous phase observed.
func (d *drill) loadMethods() {
	blob, err := os.ReadFile(filepath.Join(d.out, "bridge-methods.json"))
	if err != nil {
		d.logf("drill: reading the method evidence failed: %v", err)
		return
	}
	var methods map[string]*method
	if err := json.Unmarshal(blob, &methods); err != nil {
		d.logf("drill: decoding the method evidence failed: %v", err)
		return
	}
	d.mu.Lock()
	for name, entry := range methods {
		if entry != nil {
			d.methods[name] = entry
		}
	}
	d.mu.Unlock()
}

// writeMarker records that this phase finished.
func (d *drill) writeMarker(name string) {
	if err := os.WriteFile(filepath.Join(d.out, name), []byte(time.Now().UTC().Format(time.RFC3339Nano)+"\n"), 0o644); err != nil {
		d.logf("drill: writing %s failed: %v", name, err)
	}
}

// logf writes one line of drill output to stderr.
func (d *drill) logf(format string, args ...any) {
	fmt.Fprintf(os.Stderr, format+"\n", args...)
}

// quote renders a string for the report.
func quote(text string) string { return strconv.Quote(text) }

// fileExists reports whether path exists.
func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}
