/**
 * Exit-attribution hook injected into the bundled dsh host via `--import` (see
 * startHost in main.cjs). The shell cannot tell *why* its host left:
 * `@deepseek-ai/dsh` profile-boot installs a SIGTERM handler that turns the
 * signal into a graceful shutdown, and that shutdown reports the same
 * `code=0 signal=null` the shell's own teardown reports. Measured 2026-10-15: a
 * user-facing "后台服务进程意外停止" report carried a log tail that is byte-for-byte
 * what an ordinary quit writes, so neither the shell nor the reader could tell a
 * signalled host from an exited one. A plugin-tree failure is a different shape
 * entirely — fail-loud (`@deepseek-ai/dsh-app-boot`) writes one stderr
 * diagnostic and exits 1 — so this hook only has to separate the two quiet
 * shapes: an explicit `process.exit(code)` and an event loop that drained.
 *
 * The instrumentation is deliberately observation-only. It wraps `process.exit`
 * to capture its caller's stack and listens for `beforeExit` (which fires only
 * on a natural drain, never for an explicit exit), and it adds no signal
 * listener: a listener would replace Node's default terminate action for that
 * signal and so change the lifetime behavior this hook exists to describe. The
 * signal shapes therefore read as: SIGTERM → an `exit(0)` request whose stack
 * carries profile-boot's shutdown controller; SIGKILL/SIGHUP → a raw signal,
 * which the shell already records on its own `host exited: signal=…` line.
 *
 * Lines go to fd 2 with HOST_LIFECYCLE_PREFIX, which the shell captures into
 * dsh-host.log beside normal host output; `grep '\[host-lifecycle\]'` reads the
 * whole host lifetime back. Remove this file together with the injection in
 * main.cjs once the host reports its own exit reason.
 */
import fs from 'node:fs';

/** Marks every line this hook and its sibling guard write. */
export const HOST_LIFECYCLE_PREFIX = '[host-lifecycle]';

/**
 * Write one lifecycle line straight to fd 2.
 *
 * `fs.writeSync` rather than `process.stderr.write`: the exit handler runs with
 * the loop already unwinding, where a buffered async write can be dropped.
 * @param {string} line
 */
function writeLine(line) {
  try {
    fs.writeSync(2, `${HOST_LIFECYCLE_PREFIX} ${line}\n`);
  } catch {
    // stderr is gone (parent already reaped us); a lifecycle note is not worth
    // failing the exit path over.
  }
}

/**
 * Stack of the code that asked for the exit, without the `Error` header line.
 * @returns {string}
 */
function exitStack() {
  return (new Error('exit requested').stack ?? '').split('\n').slice(1).join('\n');
}

/**
 * Wrap one process object with exit attribution.
 * @param {{ on: Function, exit: Function, pid: number, ppid: number }} proc - the process slice to observe.
 * @param {{ write?: (line: string) => void, stack?: () => string }} [options] - test seams.
 * @returns {{ exit: Function }} the installed wrapper, for assertions.
 */
export function installExitTracer(proc, options = {}) {
  const write = options.write ?? writeLine;
  const stack = options.stack ?? exitStack;
  proc.on('beforeExit', (code) => {
    write(`event loop drained without an exit request (beforeExit code=${String(code)})`);
  });
  proc.on('exit', (code) => {
    write(`process exiting code=${String(code)}`);
  });
  const delegate = proc.exit.bind(proc);
  const exit = (code) => {
    write(`exit(${String(code)}) requested\n${stack()}`);
    return delegate(code);
  };
  proc.exit = exit;
  write(`tracer attached pid=${String(proc.pid)} ppid=${String(proc.ppid)}`);
  return { exit };
}

/**
 * Arm the tracer for a host this shell spawned.
 *
 * Gated on DSH_DESKTOP_SHELL_PID (set by `childEnv` in main.cjs, and also what
 * host-orphan-guard.mjs watches): a process that imports this module but was not
 * spawned by the shell — the desktop test runner, a hand-started host — gets no
 * wrapper and no listeners, so the hook is inert outside the case it describes.
 * @param {NodeJS.Process} proc
 * @returns {boolean} whether the tracer was installed.
 */
export function armExitTracerForShellChild(proc = process) {
  if (typeof proc.env?.DSH_DESKTOP_SHELL_PID !== 'string') return false;
  installExitTracer(proc);
  return true;
}

armExitTracerForShellChild(process);
