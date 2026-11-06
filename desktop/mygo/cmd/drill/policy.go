package main

import (
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/egoist/mygo"
)

// runPolicy drives the window rules desktop/src/main.cjs createWindow carries:
// the renderer log agent, a navigation off the GUI's origin, and window.open().
func (d *drill) runPolicy() error {
	state, err := d.waitRendered()
	if err != nil {
		return err
	}
	d.recordPage(state)
	d.recordPresence(state, "present but not driven in policy mode")
	d.check("guiRendered", state.ReadyState == "complete" && state.TextLen > 0)
	d.check("desktopBridgePresent", len(state.Missing) == 0)
	if _, err := d.eval("(function () { window.__drillPolicy = 'alive'; return 'marked'; })()"); err != nil {
		return err
	}
	origin := d.shellInstance().Origin()

	// The renderer log agent: a page console.error must reach the host log as a
	// [renderer] line, since mygo has no console-message hook.
	const rendererProbe = "drill: renderer log probe"
	if _, err := d.eval("(function () { console.error('" + rendererProbe + "'); return 'logged'; })()"); err != nil {
		return err
	}
	rendererLine, err := d.waitLogLine(rendererProbe, 20*time.Second)
	if err != nil {
		return err
	}
	ok := strings.Contains(rendererLine, "[renderer] error")
	d.step("renderer log", ok, "the host log carries: "+quote(rendererLine))
	if !ok {
		return errors.New("the renderer log agent never reached the host log")
	}

	// A navigation off the GUI's origin is cancelled and handed to the browser.
	const navProbe = "https://example.com/drill-navigation-probe"
	before, err := d.eval("String(location.href)")
	if err != nil {
		return err
	}
	if _, err := d.eval("(function () { location.href = '" + navProbe + "'; return 'navigating'; })()"); err != nil {
		return err
	}
	blockedLine, err := d.waitLogLine("blocked a navigation to "+navProbe, 20*time.Second)
	if err != nil {
		return err
	}
	handoffLine, err := d.waitLogLine("opening "+navProbe+" in the system browser", 20*time.Second)
	if err != nil {
		return err
	}
	time.Sleep(500 * time.Millisecond)
	after, err := d.eval("String(location.href)")
	if err != nil {
		return err
	}
	blocked := blockedLine != "" && handoffLine != "" && after == before
	d.step("navigation off the origin", blocked, fmt.Sprintf("log: %s / %s; the page is still at %s", quote(blockedLine), quote(handoffLine), quote(after)))
	if !blocked {
		return errors.New("the navigation off the GUI's origin was not blocked and handed off")
	}

	// window.open() never gets a window of its own, on the origin or off it.
	const openProbe = "https://example.com/drill-window-open-probe"
	if _, err := d.eval("(function () { window.open('" + openProbe + "'); return 'opened'; })()"); err != nil {
		return err
	}
	openLine, err := d.waitLogLine("denied a window.open() for "+openProbe, 20*time.Second)
	if err != nil {
		return err
	}
	openHandoff, err := d.waitLogLine("opening "+openProbe+" in the system browser", 20*time.Second)
	if err != nil {
		return err
	}
	openDenied := openLine != "" && openHandoff != ""
	d.step("window.open off the origin", openDenied, fmt.Sprintf("log: %s / %s", quote(openLine), quote(openHandoff)))
	if !openDenied {
		return errors.New("window.open() off the origin was not denied and handed off")
	}

	// The same call on the GUI's own origin is denied and stays inside: nothing
	// to hand to the browser.
	loopbackProbe := origin + "/drill-window-open-probe"
	if _, err := d.eval("(function () { window.open('" + loopbackProbe + "'); return 'opened'; })()"); err != nil {
		return err
	}
	loopbackLine, err := d.waitLogLine("denied a window.open() for "+loopbackProbe, 20*time.Second)
	if err != nil {
		return err
	}
	stayInside := waitUntil(func() bool {
		return len(d.logLines("opening "+loopbackProbe+" in the system browser")) > 0
	}, 2*time.Second)
	loopbackOK := loopbackLine != "" && !stayInside
	d.step("window.open on the origin", loopbackOK, fmt.Sprintf("log: %s; handed to the browser: %v", quote(loopbackLine), stayInside))
	if !loopbackOK {
		return errors.New("a loopback window.open() left for the system browser")
	}

	// The window is still the shell's one page, on the GUI's origin.
	alive, err := d.eval("String(window.__drillPolicy || '')")
	if err != nil {
		return err
	}
	still := alive == "alive"
	d.step("the page survived", still, "window.__drillPolicy is "+quote(alive)+" after the probes")
	if !still {
		return errors.New("the shell's page did not survive the policy probes")
	}
	d.check("pagePolicy", still)

	mygo.App.Quit()
	<-time.After(exitWait)
	return errors.New("the app did not quit within " + exitWait.String())
}
