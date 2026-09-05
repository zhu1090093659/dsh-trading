'use strict';

/**
 * DeepSeek Harness desktop — Electron main process.
 *
 * The app owns one dsh host child process: it seeds $DSH_HOME/profiles/
 * trading-web from the bundled profile when needed, spawns the bundled Node
 * runtime on a free loopback port, waits for the GUI, and loads the tokenized
 * URL the host prints. The app always starts its own host: a probe cannot
 * tell which profile an already-running GUI serves, so attaching to one would
 * hand off to an unrelated instance (this bug shipped once — the probe hit a
 * plain web GUI on port 3080 and the app opened the user's own DSH Web).
 */

const { app, BrowserWindow, ipcMain, shell } = require('electron');
const { spawn, execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  resolveRuntimePaths,
  resolveDshHome,
  readStampFile,
  profileAction,
  applyProfileSeed,
  findFreePort,
  waitForGui,
  parseTokenUrlLine,
  formatHostExitDiagnostic,
} = require('./runtime.cjs');

const READY_TIMEOUT_MS = 180000;
const LOG_TAIL_LINES = 200;
/** The host prints its tokenized GUI URL on this stdout line. */

/** @type {BrowserWindow | null} */
let mainWindow = null;
/** @type {import('node:child_process').ChildProcess | null} */
let hostChild = null;
let quitting = false;
let logStream = null;
/** URL printed by the host (with the per-process token), set once seen. */
let tokenUrl = null;
/** Ring buffer of recent host output for the error page. */
const logTail = [];

function resourcesRoot() {
  return app.isPackaged ? process.resourcesPath : path.join(__dirname, '..', 'resources');
}

function logFilePath() {
  return path.join(app.getPath('logs'), 'dsh-host.log');
}

function pushLogLine(line) {
  logTail.push(line);
  if (logTail.length > LOG_TAIL_LINES) logTail.shift();
  if (logStream !== null) logStream.write(line + '\n');
  const url = parseTokenUrlLine(line);
  if (url !== undefined) tokenUrl = url;
}

function setStatus(text) {
  if (mainWindow !== null && !mainWindow.isDestroyed()) mainWindow.webContents.send('desktop:status', text);
}

function childEnv(home, nodeHome) {
  const env = { ...process.env, DSH_HOME: home };
  // The bundled Node distribution comes first so anything the host shells out
  // to (npm, corepack) resolves against the bundled runtime, never the system.
  const nodeBinDir = process.platform === 'win32' ? nodeHome : path.join(nodeHome, 'bin');
  const currentPath = env.PATH || env.Path || '';
  env.PATH = nodeBinDir + path.delimiter + currentPath;
  if (process.platform === 'win32') {
    env.Path = env.PATH;
  }
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

/** Load hook shared with the host: see src/host-symbol-normalizer.mjs. */
const HOST_SYMBOL_NORMALIZER = 'host-symbol-normalizer.mjs';

/**
 * On-disk path of the symbol-normalizing load hook, or undefined when the
 * packaging layout does not provide it. electron-builder packs src/ into
 * app.asar, but this hook is imported by the external bundled Node runtime,
 * which cannot read inside the archive — asarUnpack places it next to the
 * archive as app.asar.unpacked/, and development runs resolve unchanged.
 */
function hostSymbolNormalizerPath() {
  const localPath = path.join(__dirname, HOST_SYMBOL_NORMALIZER);
  const unpackedPath = localPath.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
  return fs.existsSync(unpackedPath) ? unpackedPath : undefined;
}

function startHost(runtime, home, port) {
  const symbolNormalizer = hostSymbolNormalizerPath();
  if (symbolNormalizer === undefined) {
    pushLogLine('[desktop] symbol normalizer missing, spawning host without it');
  } else {
    pushLogLine('[desktop] injecting dsh scope symbol normalizer: ' + symbolNormalizer);
  }
  const args = [
    ...(symbolNormalizer === undefined ? [] : ['--import', symbolNormalizer]),
    runtime.hostBin, '--profile', 'trading-web', '--no-open', '--host', '127.0.0.1', '--port', String(port),
  ];
  const child = spawn(runtime.nodeBin, args, {
    cwd: home,
    env: childEnv(home, runtime.nodeHome),
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  const onData = (chunk) => {
    for (const line of String(chunk).split(/\r?\n/)) {
      if (line !== '') pushLogLine(line);
    }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.on('error', (err) => {
    const errText = err && err.message ? err.message : String(err);
    pushLogLine('[desktop] host process error: ' + errText);
    if (!quitting) {
      void showError('后台服务进程派生失败: ' + errText);
    }
  });
  return child;
}

function stopHost(child) {
  return new Promise((resolvePromise) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolvePromise();
      return;
    }
    const force = setTimeout(() => {
      if (process.platform === 'win32') {
        execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => resolvePromise());
      } else {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          try { child.kill('SIGKILL'); } catch { /* already gone */ }
        }
        resolvePromise();
      }
    }, 5000);
    child.once('exit', () => {
      clearTimeout(force);
      resolvePromise();
    });
    if (process.platform === 'win32') {
      execFile('taskkill', ['/pid', String(child.pid), '/T'], () => { /* graceful attempt only */ });
    } else {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        child.kill('SIGTERM');
      }
    }
  });
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: 'DSH Trading',
    backgroundColor: '#0b1220',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  // The bundled web frontend keeps the host's own brand in document.title;
  // the shell window is branded DSH Trading and must not inherit it.
  window.on('page-title-updated', (event) => event.preventDefault());
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url) && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(url)) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(url) && !url.startsWith('file://')) {
      event.preventDefault();
      if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    }
  });
  return window;
}

async function showError(message, extra = {}) {
  if (mainWindow === null || mainWindow.isDestroyed()) return;
  await mainWindow.loadFile(path.join(__dirname, 'error.html'));
  mainWindow.webContents.send('desktop:error', {
    message,
    log: logTail.join('\n'),
    logFile: logFilePath(),
    isMissingVCRedist: extra.isMissingVCRedist ?? false,
  });
}

async function boot() {
  const runtime = resolveRuntimePaths(resourcesRoot(), process.platform, process.arch, app.isPackaged);
  const home = resolveDshHome(process.env, os.homedir());
  pushLogLine('[desktop] dsh home: ' + home);

  if (!fs.existsSync(runtime.nodeBin)) throw new Error('bundled Node runtime is missing: ' + runtime.nodeBin);
  if (!fs.existsSync(runtime.hostBin)) throw new Error('bundled dsh host is missing: ' + runtime.hostBin);

  const stamp = readStampFile(runtime.stampFile);
  const stampText = stamp === undefined ? 'unknown' : [stamp.node, stamp.host, stamp.webAll].join(' / ');
  const profileDir = path.join(home, 'profiles', 'trading-web');
  const action = profileAction(profileDir, stampText);
  if (action !== 'leave') {
    setStatus(action === 'seed' ? 'Installing the bundled web profile…' : 'Updating the bundled web profile…');
    pushLogLine('[desktop] profile action: ' + action + ' (' + stampText + ')');
    applyProfileSeed(runtime.profileSeed, profileDir, action, stampText, { appVersion: app.getVersion() });
  }

  setStatus('Starting the dsh host…');
  const port = await findFreePort();
  pushLogLine('[desktop] spawning host on 127.0.0.1:' + port);
  hostChild = startHost(runtime, home, port);
  const child = hostChild;
  let exited = false;
  child.once('exit', (code, signal) => {
    exited = true;
    const diag = formatHostExitDiagnostic(code, signal, process.platform);
    pushLogLine('[desktop] host exited: code=' + String(code) + ' signal=' + String(signal) + ' (' + diag.message + ')');
    if (!quitting) {
      void showError(diag.message, { isMissingVCRedist: diag.isMissingVCRedist });
    }
  });
  await waitForGui(port, { deadlineMs: READY_TIMEOUT_MS, isAlive: () => !exited });
  // The token URL line can land a moment after the port answers; give it a
  // short grace period before falling back to the bare (401) URL.
  for (let waited = 0; tokenUrl === null && waited < 5000; waited += 250) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  const target = tokenUrl ?? ('http://127.0.0.1:' + port + '/');
  pushLogLine('[desktop] GUI ready, loading ' + (tokenUrl === null ? 'the bare URL (no token line seen)' : 'the tokenized URL'));
  await mainWindow.loadURL(target);
}

async function run() {
  mainWindow = createWindow();
  await mainWindow.loadFile(path.join(__dirname, 'splash.html'));
  try {
    await boot();
  } catch (error) {
    pushLogLine('[desktop] boot failed: ' + String(error && error.message ? error.message : error));
    await showError(String(error && error.message ? error.message : error));
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow !== null) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  app.whenReady().then(run).catch((error) => {
    console.error(error);
    app.quit();
  });
}

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', (event) => {
  if (quitting) return;
  quitting = true;
  if (hostChild !== null) {
    event.preventDefault();
    const child = hostChild;
    hostChild = null;
    void stopHost(child).then(() => app.quit());
  }
});

ipcMain.on('desktop:retry', () => {
  if (quitting) return;
  void run();
});

ipcMain.on('desktop:reveal-log', () => {
  shell.showItemInFolder(logFilePath());
});

ipcMain.on('desktop:open-vcredist-download', () => {
  void shell.openExternal('https://aka.ms/vs/17/release/vc_redist.x64.exe');
});

ipcMain.on('desktop:quit', () => {
  app.quit();
});

// Updater flow: relaunch + quit in one step (app.relaunch registers the new
// launch; the quit then goes through the normal before-quit host teardown).
ipcMain.on('desktop:relaunch', () => {
  app.relaunch();
  app.quit();
});

app.whenReady().then(() => {
  try {
    fs.mkdirSync(path.dirname(logFilePath()), { recursive: true });
    logStream = fs.createWriteStream(logFilePath(), { flags: 'a' });
  } catch {
    logStream = null;
  }
});
