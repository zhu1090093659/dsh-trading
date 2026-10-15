/**
 * Parent-liveness guard injected into the bundled dsh host via `--import` (see
 * startHost in main.cjs). The shell stops its host from `before-quit`, which a
 * SIGTERM or SIGKILL aimed at the *application* never reaches, and the host is
 * spawned detached, so a shell that dies without that teardown leaves the host
 * running with no owner — measured 2026-10-15: two `pkill -f "DSH
 * Trading.app/Contents/MacOS"` runs left hosts reparented to launchd (ppid 1),
 * each still holding its loopback port and the trading-tasks ledger lock, and
 * the next launch then had to log `[dsh-trading/tasks] task ledger unavailable`
 * instead of owning the home.
 *
 * The guard watches the launcher pid the shell announces in
 * DSH_DESKTOP_SHELL_PID. Two independent readings say the launcher is gone, and
 * either one is enough: the pid no longer answers `kill(pid, 0)`, or the host
 * has been reparented to launchd (`process.ppid === 1`) — which also covers the
 * unreaped-zombie case the pid probe reports as alive. It then asks for the
 * shutdown a shell-initiated stop uses: SIGTERM to itself, which
 * `@deepseek-ai/dsh` profile-boot already handles, so ordinary cleanup runs.
 * A host spawned without that variable (development, tests) keeps its own
 * lifetime, and sampling rides an unref'd interval so the guard never extends
 * the lifetime it exists to end.
 */
import fs from 'node:fs';

import { HOST_LIFECYCLE_PREFIX } from './host-exit-tracer.mjs';

/** How often the launcher is checked; the host is already dead weight by now. */
export const ORPHAN_GUARD_INTERVAL_MS = 2000;
/**
 * Grace between the graceful SIGTERM and a forced exit. A host whose handler
 * never completes would otherwise stay orphaned, which is the failure this
 * guard removes.
 */
export const ORPHAN_GUARD_EXIT_GRACE_MS = 5000;

/**
 * Write one lifecycle line straight to fd 2; see host-exit-tracer.mjs.
 * @param {string} line
 */
function writeLine(line) {
  try {
    fs.writeSync(2, `${HOST_LIFECYCLE_PREFIX} ${line}\n`);
  } catch {
    // stderr is gone; the guard's action matters, not its note.
  }
}

/**
 * Whether a pid still answers signal 0.
 * EPERM means the process exists but belongs to someone else, which is alive.
 * @param {{ kill: Function }} proc
 * @param {number} pid
 * @returns {boolean}
 */
export function isProcessAlive(proc, pid) {
  try {
    proc.kill(pid, 0);
    return true;
  } catch (error) {
    return error !== null && typeof error === 'object' && error.code === 'EPERM';
  }
}

/**
 * Build the launcher-liveness decision, latched so a shutdown is requested once.
 * @param {{ shellPid: number, readAlive: (pid: number) => boolean, readPpid: () => number, shutdown: () => void }} options
 * @returns {{ tick: () => boolean }} true when this tick requested the shutdown.
 */
export function createOrphanGuard(options) {
  let done = false;
  return {
    tick() {
      if (done) return false;
      if (options.readAlive(options.shellPid) && options.readPpid() !== 1) return false;
      done = true;
      options.shutdown();
      return true;
    },
  };
}

/**
 * Install the guard on one process object.
 * @param {{ pid: number, ppid: number, kill: Function, exit: Function, listenerCount?: Function }} proc
 * @param {Record<string, string | undefined>} env - launcher environment.
 * @param {{ write?: Function, readAlive?: Function, kill?: Function, exit?: Function, schedule?: Function, cancel?: Function, wait?: Function }} [options] - test seams.
 * @returns {{ armed: boolean, stop: () => void }} whether the guard runs, and how to stop it.
 */
export function installOrphanGuard(proc, env, options = {}) {
  const shellPid = Number.parseInt(String(env?.DSH_DESKTOP_SHELL_PID ?? ''), 10);
  if (!Number.isInteger(shellPid) || shellPid <= 1) return { armed: false, stop: () => {} };
  const write = options.write ?? writeLine;
  const kill = options.kill ?? ((pid, signal) => proc.kill(pid, signal));
  const exit = options.exit ?? ((code) => proc.exit(code));
  const wait = options.wait ?? ((fn, ms) => setTimeout(fn, ms));
  const readAlive = options.readAlive ?? ((pid) => isProcessAlive(proc, pid));
  const schedule = options.schedule ?? ((tick, ms) => {
    const timer = setInterval(tick, ms);
    if (typeof timer.unref === 'function') timer.unref();
    return timer;
  });
  const cancel = options.cancel ?? ((timer) => clearInterval(timer));
  const shutdown = () => {
    write(`orphan guard: launcher pid ${String(shellPid)} is gone; requesting shutdown`);
    if (typeof proc.listenerCount === 'function' && proc.listenerCount('SIGTERM') > 0) {
      kill(proc.pid, 'SIGTERM');
      wait(() => exit(0), ORPHAN_GUARD_EXIT_GRACE_MS);
      return;
    }
    // No handler yet (the tree is still mounting, so a SIGTERM would be
    // swallowed by the default action we cannot rely on): leave outright.
    exit(0);
  };
  const guard = createOrphanGuard({
    shellPid,
    readAlive,
    readPpid: () => proc.ppid,
    shutdown,
  });
  let timer;
  const stop = () => {
    if (timer !== undefined) cancel(timer);
  };
  timer = schedule(() => {
    if (guard.tick()) stop();
  }, ORPHAN_GUARD_INTERVAL_MS);
  return { armed: true, stop };
}

installOrphanGuard(process, process.env);
