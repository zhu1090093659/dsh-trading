/**
 * Host exit-attribution hook, equivalent to desktop/src/host-exit-tracer.mjs.
 * The shell cannot tell *why* its host left: profile-boot turns SIGTERM into a
 * graceful shutdown reporting the same code=0 signal=null the shell's own
 * teardown reports. This hook separates the two quiet shapes — an explicit
 * process.exit(code) and an event loop that drained — and adds no signal
 * listener, so it never changes the lifetime behavior it describes.
 *
 * Lines go to fd 2 with HOST_LIFECYCLE_PREFIX, which the shell captures into
 * its log beside normal host output: grep '[host-lifecycle]' reads the whole
 * host lifetime back.
 */
import fs from 'node:fs';

/** Marks every line this hook and its sibling guard write. */
export const HOST_LIFECYCLE_PREFIX = '[host-lifecycle]';

/**
 * Write one lifecycle line straight to fd 2. fs.writeSync rather than
 * process.stderr.write: the exit handler runs with the loop already unwinding,
 * where a buffered async write can be dropped.
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
 * Stack of the code that asked for the exit, without the Error header line.
 * @returns {string}
 */
function exitStack() {
  return (new Error('exit requested').stack ?? '').split('\n').slice(1).join('\n');
}

/**
 * Wrap one process object with exit attribution.
 * @param {{ on: Function, exit: Function, pid: number, ppid: number }} proc
 * @param {{ write?: (line: string) => void, stack?: () => string }} [options]
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
 * Arm the tracer for a host this shell spawned. Gated on DSH_DESKTOP_SHELL_PID
 * (set by the shell for exactly this reason): a process that imports this
 * module but was not spawned by the shell gets no wrapper and no listeners.
 * @param {NodeJS.Process} proc
 * @returns {boolean} whether the tracer was installed.
 */
export function armExitTracerForShellChild(proc = process) {
  if (typeof proc.env?.DSH_DESKTOP_SHELL_PID !== 'string') return false;
  installExitTracer(proc);
  return true;
}

armExitTracerForShellChild(process);
