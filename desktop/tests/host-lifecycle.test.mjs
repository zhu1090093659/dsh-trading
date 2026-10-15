import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import {
  HOST_LIFECYCLE_PREFIX,
  installExitTracer,
  armExitTracerForShellChild,
} from '../src/host-exit-tracer.mjs';
import {
  createOrphanGuard,
  installOrphanGuard,
  isProcessAlive,
} from '../src/host-orphan-guard.mjs';

/** Contract-verified stand-in for the process slice the two hooks observe. */
class FakeProcess {
  constructor({ pid = 4242, ppid = 11, signalListeners = 0 } = {}) {
    this.pid = pid;
    this.ppid = ppid;
    this.signalListeners = signalListeners;
    this.listeners = new Map();
    this.exitCodes = [];
    this.signals = [];
  }

  on(event, listener) {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
    return this;
  }

  emit(event, ...args) {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args);
  }

  exit(code) {
    this.exitCodes.push(code);
  }

  kill(pid, signal) {
    this.signals.push([pid, signal]);
  }

  listenerCount(event) {
    return event === 'SIGTERM' ? this.signalListeners : 0;
  }
}

const HOOK_PATHS = ['host-exit-tracer.mjs', 'host-orphan-guard.mjs']
  .map((name) => pathToFileURL(path.join(import.meta.dirname, '..', 'src', name)).href);

/** `--import` arguments for both hooks, in the order main.cjs injects them. */
function hookArguments() {
  return HOOK_PATHS.flatMap((specifier) => ['--import', specifier]);
}

test('operator gets the caller of an explicit host exit on the record', () => {
  // Given an instrumented host process
  const proc = new FakeProcess();
  const lines = [];
  const { exit } = installExitTracer(proc, {
    write: (line) => lines.push(line),
    stack: () => 'at profile-boot forceExitOnce',
  });

  // When the host asks to exit
  exit(7);

  // Then the request, its caller and the attachment are on the record, and the
  // real exit still received the code
  assert.deepEqual(proc.exitCodes, [7]);
  assert.ok(lines.some((line) => line.includes('exit(7) requested')), 'the exit request must be recorded');
  assert.ok(lines.some((line) => line.includes('at profile-boot forceExitOnce')), 'the caller stack must be recorded');
  assert.ok(lines.some((line) => line.includes('tracer attached pid=4242 ppid=11')), 'the attachment must name the process');
});

test('operator can tell a drained event loop apart from an exit request', () => {
  // Given an instrumented host process that never calls process.exit
  const proc = new FakeProcess();
  const lines = [];
  installExitTracer(proc, { write: (line) => lines.push(line), stack: () => 'unused' });

  // When the event loop drains and the process leaves
  proc.emit('beforeExit', 0);
  proc.emit('exit', 0);

  // Then the drain is named as such, so it cannot be read as a signalled host
  assert.ok(lines.some((line) => line.includes('event loop drained without an exit request (beforeExit code=0)')));
  assert.ok(lines.some((line) => line.includes('process exiting code=0')));
  assert.equal(lines.some((line) => line.includes('requested')), false, 'a drained loop must not look like an exit request');
});

test('operator sees the exit tracer arm only for a host the shell spawned', () => {
  // Given a process with no launcher announcement
  const unspawned = new FakeProcess();
  unspawned.env = {};
  assert.equal(armExitTracerForShellChild(unspawned), false);
  assert.equal(unspawned.listeners.size, 0, 'an unspawned process must stay untouched');

  // When the same kind of process is spawned by the shell, which announces itself
  const spawned = new FakeProcess();
  spawned.env = { DSH_DESKTOP_SHELL_PID: '99' };

  // Then the tracer observes it
  assert.equal(armExitTracerForShellChild(spawned), true);
  assert.ok(spawned.listeners.has('exit'), 'the armed tracer must observe the process outcome');
});

test('operator sees a foreign process kept alive and a vanished one dropped', () => {
  // Given three answers from the operating system
  const live = { kill() {} };
  const denied = {
    kill() {
      const error = new Error('EPERM: operation not permitted');
      error.code = 'EPERM';
      throw error;
    },
  };
  const gone = {
    kill() {
      const error = new Error('ESRCH: no such process');
      error.code = 'ESRCH';
      throw error;
    },
  };

  // When liveness is probed

  // Then only a vanished process counts as gone
  assert.equal(isProcessAlive(live, 1), true);
  assert.equal(isProcessAlive(denied, 1), true, 'EPERM means the process exists but is not ours');
  assert.equal(isProcessAlive(gone, 1), false);
});

test('operator keeps the host running while the launcher answers', () => {
  // Given a guard whose launcher is alive and is still this process's parent
  const shutdowns = [];
  const guard = createOrphanGuard({
    shellPid: 99,
    readAlive: () => true,
    readPpid: () => 99,
    shutdown: () => shutdowns.push('shutdown'),
  });

  // When the guard samples
  const fired = guard.tick();

  // Then the host keeps running
  assert.equal(fired, false);
  assert.deepEqual(shutdowns, []);
});

test('operator gets exactly one shutdown request once the launcher is gone', () => {
  // Given a guard whose launcher has disappeared
  const shutdowns = [];
  const guard = createOrphanGuard({
    shellPid: 99,
    readAlive: () => false,
    readPpid: () => 42,
    shutdown: () => shutdowns.push('shutdown'),
  });

  // When the guard samples repeatedly
  const first = guard.tick();
  const second = guard.tick();

  // Then the shutdown is requested once
  assert.equal(first, true);
  assert.equal(second, false);
  assert.deepEqual(shutdowns, ['shutdown']);
});

test('operator sees the guard fire when the host was reparented to launchd', () => {
  // Given a launcher pid that still answers but a parent that is already init
  // (the unreaped-zombie case the pid probe reports as alive)
  const shutdowns = [];
  const guard = createOrphanGuard({
    shellPid: 99,
    readAlive: () => true,
    readPpid: () => 1,
    shutdown: () => shutdowns.push('shutdown'),
  });

  // When the guard samples
  const fired = guard.tick();

  // Then the host does not outlive its launcher
  assert.equal(fired, true);
  assert.deepEqual(shutdowns, ['shutdown']);
});

test('operator gets no guard when no launcher announced itself', () => {
  // Given a host started without the launcher pid (development, tests)
  let scheduled = 0;

  // When the guard is installed
  const installed = installOrphanGuard(new FakeProcess(), {}, { schedule: () => { scheduled += 1; } });

  // Then no sampling happens and nothing can shut the host down
  assert.equal(installed.armed, false);
  assert.equal(scheduled, 0);
});

test('operator gets the graceful signal first and a forced exit if it wedges', () => {
  // Given an armed guard for a dead launcher and a host with a SIGTERM handler
  const proc = new FakeProcess({ pid: 5000, ppid: 99, signalListeners: 1 });
  const lines = [];
  const pending = [];
  let tick;
  const installed = installOrphanGuard(proc, { DSH_DESKTOP_SHELL_PID: '99' }, {
    write: (line) => lines.push(line),
    readAlive: () => false,
    schedule: (sample) => {
      tick = sample;
      return { unref() {} };
    },
    cancel: () => {},
    wait: (fn) => pending.push(fn),
  });
  assert.equal(installed.armed, true);

  // When the sampling interval fires
  tick();

  // Then the host asks itself for the shutdown the shell would have sent
  assert.deepEqual(proc.signals, [[5000, 'SIGTERM']]);
  assert.deepEqual(proc.exitCodes, [], 'the graceful path must be given its chance first');
  assert.ok(lines.some((line) => line.includes('launcher pid 99 is gone')), 'the reason must reach the host log');

  // And a handler that never completes cannot leave the orphan behind
  pending[0]();
  assert.deepEqual(proc.exitCodes, [0]);
});

test('operator gets an outright exit when the host has no shutdown handler yet', () => {
  // Given an armed guard whose host is still mounting its tree
  const proc = new FakeProcess({ pid: 5001, ppid: 99, signalListeners: 0 });
  const lines = [];
  let tick;
  installOrphanGuard(proc, { DSH_DESKTOP_SHELL_PID: '99' }, {
    write: (line) => lines.push(line),
    readAlive: () => false,
    schedule: (sample) => {
      tick = sample;
      return { unref() {} };
    },
    cancel: () => {},
  });

  // When the sampling interval fires
  tick();

  // Then the host leaves without waiting for a handler that does not exist
  assert.deepEqual(proc.exitCodes, [0]);
  assert.deepEqual(proc.signals, []);
  assert.ok(lines.some((line) => line.includes('launcher pid 99 is gone')));
});

test('operator can read the exit shape of a hooked host from its stderr', () => {
  // Given a child the shell spawned, importing both hooks the way main.cjs does
  const result = spawnSync(process.execPath, [...hookArguments(), '-e', 'console.log("host-ok")'], {
    encoding: 'utf8',
    env: { ...process.env, DSH_DESKTOP_SHELL_PID: String(process.pid) },
  });

  // When it finishes on its own
  // Then it runs normally and its exit shape reaches stderr for dsh-host.log
  assert.equal(result.status, 0, 'hooked child should exit 0, stderr: ' + result.stderr);
  assert.match(result.stdout, /host-ok/);
  assert.ok(
    result.stderr.includes(HOST_LIFECYCLE_PREFIX + ' tracer attached'),
    'the attachment must be readable in dsh-host.log: ' + result.stderr,
  );
  assert.match(result.stderr, /event loop drained without an exit request \(beforeExit code=0\)/);
});

test('operator keeps the exit code of a hooked child that calls process.exit', () => {
  // Given a child the shell spawned that leaves through process.exit
  const result = spawnSync(process.execPath, [...hookArguments(), '-e', 'process.exit(3)'], {
    encoding: 'utf8',
    env: { ...process.env, DSH_DESKTOP_SHELL_PID: String(process.pid) },
  });

  // When it leaves
  // Then the exit request and its caller are logged, and the code survives
  assert.equal(result.status, 3);
  assert.match(result.stderr, /exit\(3\) requested/);
  assert.match(result.stderr, /host-exit-tracer\.mjs/);
});

test('operator sees no lifecycle noise from a child the shell did not spawn', () => {
  // Given a child importing the same hooks without a launcher announcement
  const unspawnedEnv = { ...process.env };
  delete unspawnedEnv.DSH_DESKTOP_SHELL_PID;
  const result = spawnSync(process.execPath, [...hookArguments(), '-e', 'console.log("host-ok")'], {
    encoding: 'utf8',
    env: unspawnedEnv,
  });

  // When it runs to completion
  // Then nothing of the hook's contract leaks into a host this shell does not own
  assert.equal(result.status, 0, 'unhooked child should exit 0, stderr: ' + result.stderr);
  assert.equal(result.stderr.includes(HOST_LIFECYCLE_PREFIX), false, 'an unspawned child must stay untouched');
});
