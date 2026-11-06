package shell

import (
	"github.com/egoist/mygo"

	"github.com/dshtrading/desktop-mygo/internal/renderer"
)

// The page-side contract this shell rebuilds is desktop/src/preload.cjs: seven
// window.desktop members, which the client plugins probe with
// `'desktop' in window` before using them. The names, their arguments and their
// return behaviour are the ones the Electron preload exposes; only the
// transport changes (mygo's bound methods and events instead of ipcRenderer).
var (
	// statusEvent carries the splash status line.
	statusEvent = mygo.NewEvent[string]("desktop:status")
	// errorEvent carries the startup-problem payload.
	errorEvent = mygo.NewEvent[ErrorPayload]("desktop:error")
)

// vcRedistDownloadURL is the download the error page offers on Windows.
const vcRedistDownloadURL = "https://aka.ms/vs/17/release/vc_redist.x64.exe"

// ErrorPayload is what the error page renders, field for field what
// desktop/src/main.cjs sends to desktop:error.
type ErrorPayload struct {
	Message           string `json:"message"`
	Log               string `json:"log"`
	LogFile           string `json:"logFile"`
	IsMissingVCRedist bool   `json:"isMissingVCRedist"`
}

// desktopService is the Go side of window.desktop. Its methods run on their own
// goroutines, one per call, and each records the call so the shell log (and a
// drill run) can show that the page really reached it.
type desktopService struct{ shell *Shell }

// Retry boots the host again, as desktop/src/main.cjs's desktop:retry does: an
// explicit retry is a human decision, so it also hands back the automatic
// restart budget the host burned.
func (d desktopService) Retry() string {
	d.shell.recordBridgeCall("retry")
	d.shell.budget.Reset()
	go d.shell.boot()
	return "ok"
}

// RevealLog reveals the host log in the file manager.
func (d desktopService) RevealLog() string {
	d.shell.recordBridgeCall("revealLog")
	mygo.Shell.ShowItemInFolder(d.shell.logPath())
	return "ok"
}

// OpenVCRedistDownload opens the VC++ redistributable download.
func (d desktopService) OpenVCRedistDownload() string {
	d.shell.recordBridgeCall("openVCRedistDownload")
	if err := mygo.Shell.OpenExternal(vcRedistDownloadURL); err != nil {
		d.shell.logf("[desktop] opening %s failed: %v", vcRedistDownloadURL, err)
	}
	return "ok"
}

// Quit quits the app; the quit sequence stops the host.
func (d desktopService) Quit() string {
	d.shell.recordBridgeCall("quit")
	mygo.App.Quit()
	return "ok"
}

// Relaunch relaunches the app, which is how a freshly updated profile gets
// loaded by a new host; the quit half stops the host this process started.
func (d desktopService) Relaunch() string {
	d.shell.recordBridgeCall("relaunch")
	mygo.App.Relaunch()
	return "ok"
}

// RendererLog records one message the page's own scripts reported: the two
// levels the host log carries plus the page's uncaught errors. The mygo backend
// has no console-message hook and no preload-error event, so the preload agent
// in bridgeShim is what feeds this.
func (d desktopService) RendererLog(level, message, source string, line int) string {
	d.shell.rendererLog(renderer.Entry{Level: level, Message: message, Source: source, Line: line})
	return "ok"
}

// bridgeShim installs window.desktop in every page of the window before the
// page's own scripts, backed by the bound Desktop service and the two events.
// It also carries the renderer log agent: desktop/src/main.cjs listens to
// webContents' console-message, preload-error and render-process-gone, and mygo
// exposes none of the three, so the page side reports the console levels the log
// wants, the uncaught errors, and its own preload failure.
//
// It is the analogue of desktop/src/preload.cjs and has to stay harmless on
// pages that are not the shell's own: a page without the mygo bridge gets no
// window.desktop instead of a broken one.
const bridgeShim = `(function () {
  var reporting = false;
  function report(level, message, source, line) {
    if (reporting) return;
    reporting = true;
    try {
      if (typeof window.mygo === 'undefined' || typeof window.mygo.call !== 'function') return;
      var pending = window.mygo.call('Desktop.RendererLog', String(level), String(message).slice(0, 2000), String(source === undefined || source === null ? '' : source).slice(0, 400), Number(line) || 0);
      if (pending && typeof pending.catch === 'function') pending.catch(function () {});
    } catch (ignored) {
      // A page that cannot reach Go is not a reason to break the page.
    } finally {
      reporting = false;
    }
  }
  function describe(value) {
    try {
      if (value instanceof Error) return String(value.message || value);
      if (value === undefined) return 'undefined';
      return String(value);
    } catch (ignored) {
      return 'unprintable value';
    }
  }
  function stringify(value) {
    try {
      if (typeof value === 'string') return value;
      if (value instanceof Error) return String(value.message || value);
      if (typeof value === 'object' && value !== null) {
        var json = JSON.stringify(value);
        return json === undefined ? String(value) : json;
      }
      return String(value);
    } catch (ignored) {
      return describe(value);
    }
  }
  function format(args) {
    var parts = [];
    for (var i = 0; i < args.length; i++) parts.push(stringify(args[i]));
    return parts.join(' ');
  }
  function caller() {
    try {
      var frames = String(new Error().stack || '').split('\n');
      for (var i = 1; i < frames.length; i++) {
        var match = /(https?:\/\/[^\s)]+|file:\/\/[^\s)]+):(\d+):(\d+)/.exec(frames[i]);
        if (match !== null) return { source: match[1], line: Number(match[2]) };
      }
    } catch (ignored) {
      // Fall through to the document.
    }
    return { source: String(window.location.href), line: 0 };
  }
  function install() {
    if (typeof window.mygo === 'undefined' || typeof window.mygo.call !== 'function') return;
    if (!window.desktop) {
      function call(method) {
        return function () {
          return window.mygo.call('Desktop.' + method);
        };
      }
      function listen(name) {
        return function (callback) {
          if (typeof callback !== 'function') return;
          window.mygo.on(name, function (payload) { callback(payload); });
        };
      }
      window.desktop = {
        onStatus: listen('desktop:status'),
        onError: listen('desktop:error'),
        retry: call('Retry'),
        revealLog: call('RevealLog'),
        openVCRedistDownload: call('OpenVCRedistDownload'),
        quit: call('Quit'),
        relaunch: call('Relaunch')
      };
    }
    // Only warning and error reach the host log; the GUI logs at info for
    // everything it does and those lines would bury the host's own output.
    var originalError = console.error;
    var originalWarn = console.warn;
    console.error = function () {
      try { var errorAt = caller(); report('error', format(arguments), errorAt.source, errorAt.line); } catch (ignored) {}
      return originalError.apply(console, arguments);
    };
    console.warn = function () {
      try { var warnAt = caller(); report('warning', format(arguments), warnAt.source, warnAt.line); } catch (ignored) {}
      return originalWarn.apply(console, arguments);
    };
    window.addEventListener('error', function (event) {
      try {
        var reason = event && event.error !== undefined && event.error !== null ? event.error : (event && event.message);
        report('error', describe(reason), String((event && event.filename) || window.location.href), Number((event && event.lineno) || 0));
      } catch (ignored) {}
    });
    window.addEventListener('unhandledrejection', function (event) {
      try {
        report('error', 'unhandled rejection: ' + describe(event && event.reason), String(window.location.href), 0);
      } catch (ignored) {}
    });
  }
  try {
    install();
  } catch (error) {
    // The equivalent of webContents' preload-error: the agent itself failed.
    report('error', 'preload error: ' + describe(error), 'preload', 0);
  }
})();
`
