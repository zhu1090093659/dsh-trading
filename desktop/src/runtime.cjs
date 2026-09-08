'use strict';

/**
 * Pure helpers for the desktop main process. This module must stay free of
 * the electron import so it can be unit-tested with plain node --test.
 */

const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

/** Marker file written into a profile directory this app seeded itself. */
const SEED_MARKER = '.dsh-desktop-seed.json';

/** Version stamp file produced by scripts/build-runtime.mjs. */
const RUNTIME_STAMP = 'VERSION.json';

/**
 * Resolve the on-disk locations of the bundled runtime payload.
 * @param {string} resourcesRoot - process.resourcesPath when packaged, else
 *   the desktop/resources directory in a development checkout.
 * @param {string} platform - process.platform.
 * @param {string} arch - process.arch.
 */
function resolveRuntimePaths(resourcesRoot, platform, arch, packaged = true) {
  const runtimeRoot = path.join(resourcesRoot, 'runtime');
  // Packaged builds map node-<os>-<arch> to runtime/node via extraResources;
  // a development checkout keeps the per-platform directory name.
  const nodeRoot = packaged ? path.join(runtimeRoot, 'node') : path.join(runtimeRoot, 'node-' + platform + '-' + arch);
  return {
    runtimeRoot,
    nodeBin: platform === 'win32'
      ? path.join(nodeRoot, 'node.exe')
      : path.join(nodeRoot, 'bin', 'node'),
    nodeHome: nodeRoot,
    hostBin: path.join(runtimeRoot, 'host', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    hostModules: path.join(runtimeRoot, 'host', 'node_modules'),
    profileSeed: path.join(runtimeRoot, 'profile-trading'),
    stampFile: path.join(runtimeRoot, RUNTIME_STAMP),
  };
}

/**
 * Resolve the DSH home the desktop app manages: an explicit DSH_HOME from the
 * environment wins, everything else falls back to ~/.dsh-trading — this is the
 * DSH Trading dedicated shell, and Dock launches carry no environment, so the
 * trading home must be the built-in default (2026-09-08; 宿主 dsh CLI 自身的
 * 缺省仍是 ~/.dsh，两者语义不同是刻意的).
 * @param {NodeJS.ProcessEnv} env
 * @param {string} homedir
 */
function resolveDshHome(env, homedir) {
  const configured = env.DSH_HOME;
  if (configured === undefined || configured.trim() === '') return path.join(homedir, '.dsh-trading');
  const trimmed = configured.trim();
  if (trimmed === '~') return homedir;
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) return path.join(homedir, trimmed.slice(2));
  return path.resolve(trimmed);
}

/**
 * Read a JSON stamp file; undefined when missing or unreadable.
 * @param {string} stampFile
 */
function readStampFile(stampFile) {
  try {
    return JSON.parse(fs.readFileSync(stampFile, 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * Decide how the live web profile relates to the bundled seed.
 * @param {string} profileDir - $DSH_HOME/profiles/web.
 * @param {string} stamp - current runtime stamp string.
 * @returns {'seed' | 'reseed' | 'leave'} - seed when missing, reseed when we
 *   seeded it before and the stamp moved, leave when it is user-managed.
 */
function profileAction(profileDir, stamp) {
  if (!fs.existsSync(path.join(profileDir, 'package.json'))) return 'seed';
  const marker = readStampFile(path.join(profileDir, SEED_MARKER));
  if (marker === undefined) return 'leave';
  return marker.stamp === stamp ? 'leave' : 'reseed';
}

/**
 * Copy the bundled seed profile into place. Only ever touches profiles this
 * app seeded itself; user-managed profiles are left untouched. On reseed the
 * user's patch layer and its backups survive: node_modules and the manifests
 * are replaced, cordis.patch.yml* files are kept.
 */
function applyProfileSeed(seedDir, profileDir, action, stamp, extra) {
  const keep = (name) => name.startsWith('cordis.patch.yml');
  if (action === 'reseed') {
    for (const name of ['node_modules', 'package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml']) {
      fs.rmSync(path.join(profileDir, name), { recursive: true, force: true });
    }
  }
  fs.mkdirSync(profileDir, { recursive: true });
  fs.cpSync(seedDir, profileDir, {
    recursive: true,
    dereference: true,
    filter: (source) => action !== 'reseed' || !keep(path.basename(source)),
  });
  const marker = { stamp, seededAt: new Date().toISOString(), ...extra };
  fs.writeFileSync(path.join(profileDir, SEED_MARKER), JSON.stringify(marker, null, 2) + '\n');
}

/**
 * Probe whether a dsh web GUI already answers at the given URL.
 * @param {string} url
 * @param {number} timeoutMs
 * @returns {Promise<boolean>}
 */
function probeGui(url, timeoutMs) {
  return new Promise((resolvePromise) => {
    const request = http.get(url, (response) => {
      response.resume();
      resolvePromise(response.statusCode !== undefined && response.statusCode < 500);
    });
    request.setTimeout(timeoutMs, () => {
      request.destroy();
      resolvePromise(false);
    });
    request.on('error', () => resolvePromise(false));
  });
}

/**
 * Ask the OS for a free loopback port.
 * @returns {Promise<number>}
 */
function findFreePort() {
  return new Promise((resolvePromise, rejectPromise) => {
    const server = net.createServer();
    server.once('error', rejectPromise);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => resolvePromise(port));
    });
  });
}

/**
 * Wait until the spawned host serves the GUI, or fail when the host exits
 * first or the deadline passes.
 */
async function waitForGui(port, options) {
  const url = `http://127.0.0.1:${port}/`;
  const deadline = Date.now() + options.deadlineMs;
  for (;;) {
    if (!options.isAlive()) throw new Error('the dsh host process exited before the GUI became ready');
    if (await probeGui(url, 1500)) return;
    if (Date.now() > deadline) throw new Error(`timed out after ${Math.round(options.deadlineMs / 1000)}s waiting for ${url}`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
}

/** The host prints its tokenized GUI URL on this stdout line. */
const TOKEN_URL_PATTERN = /^dsh web: (\S+)$/;

/**
 * Extract the tokenized GUI URL from one host stdout line, if any.
 * @param {string} line
 * @returns {string | undefined}
 */
function parseTokenUrlLine(line) {
  const match = TOKEN_URL_PATTERN.exec(line);
  return match === null ? undefined : match[1];
}

/**
 * Parse a Node.js SHASUMS256.txt into a name -> hash map.
 * @param {string} text
 * @returns {Map<string, string>}
 */
function parseShasums(text) {
  const map = new Map();
  for (const line of text.split('\n')) {
    const match = /^([0-9a-f]{64})\s+(\S+)$/.exec(line.trim());
    if (match !== null) map.set(match[2], match[1]);
  }
  return map;
}

/**
 * Analyze host process exit codes and signals to produce actionable diagnostic messages.
 * @param {number | null} code
 * @param {string | null} signal
 * @param {string} [platform]
 * @returns {{ message: string, isMissingVCRedist: boolean }}
 */
function formatHostExitDiagnostic(code, signal, platform = process.platform) {
  // 0xC0000135 = 3221225781 unsigned, or -1073741515 signed 32-bit int
  // Windows NTSTATUS STATUS_DLL_NOT_FOUND
  const isDllNotFound = platform === 'win32' && (code === 3221225781 || code === -1073741515);

  if (isDllNotFound) {
    return {
      message: '后台服务进程启动失败（错误代码 0xC0000135: STATUS_DLL_NOT_FOUND）。系统检测到缺少 Microsoft Visual C++ 2015-2022 运行库（x64），导致 Node.js 运行时无法加载。',
      isMissingVCRedist: true,
    };
  }

  if (signal !== null) {
    return {
      message: `后台服务进程被系统信号终止: ${signal}`,
      isMissingVCRedist: false,
    };
  }

  if (code !== null && code !== 0) {
    return {
      message: `后台服务进程异常退出，退出码: ${code}`,
      isMissingVCRedist: false,
    };
  }

  return {
    message: '后台服务进程意外停止。',
    isMissingVCRedist: false,
  };
}

/**
 * Convert a filesystem path to a specifier safe for Node's `--import` flag.
 * On Windows, passing raw absolute paths (e.g. C:\...) throws
 * ERR_UNSUPPORTED_ESM_URL_SCHEME because Node treats the drive letter as a
 * URL scheme. Converting to a file:// URL via pathToFileURL works portably
 * on all platforms and handles spaces/special characters safely.
 * @param {string | undefined} filePath
 * @returns {string | undefined}
 */
function toNodeImportSpecifier(filePath) {
  if (filePath === undefined) return undefined;
  return pathToFileURL(filePath).href;
}

/** The scope every dsh core package lives under. */
const CORE_SCOPE = '@deepseek-ai';
/** Depth cap for the nested `node_modules` walk that finds shadow copies. */
const COHORT_WALK_DEPTH = 6;

/**
 * Collect every `node_modules/@deepseek-ai/<pkg>` entry under a node_modules
 * root, nested shadow copies included. Symlinked package directories are not
 * descended into: a symlinked package's own node_modules belongs to another
 * install (a repo checkout, a pnpm store) and must not be rewritten from here.
 * @param {string} nodeModulesRoot
 * @param {number} [depth]
 * @returns {{ pkg: string, path: string }[]}
 */
function collectCorePackageDirs(nodeModulesRoot, depth = 0) {
  const found = [];
  if (depth > COHORT_WALK_DEPTH) return found;
  let entries;
  try {
    entries = fs.readdirSync(nodeModulesRoot, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const child = path.join(nodeModulesRoot, entry.name);
    if (entry.name === CORE_SCOPE) {
      let packages;
      try {
        packages = fs.readdirSync(child, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const pkg of packages) {
        if (pkg.isDirectory() || pkg.isSymbolicLink()) found.push({ pkg: pkg.name, path: path.join(child, pkg.name) });
      }
      continue;
    }
    if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
    // A scoped directory holds packages one level down; an unscoped one is a
    // package itself. Both may carry their own nested node_modules.
    if (entry.name.startsWith('@')) {
      let scoped;
      try {
        scoped = fs.readdirSync(child, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const pkg of scoped) {
        if (pkg.isSymbolicLink() || !pkg.isDirectory()) continue;
        found.push(...collectCorePackageDirs(path.join(child, pkg.name, 'node_modules'), depth + 1));
      }
      continue;
    }
    found.push(...collectCorePackageDirs(path.join(child, 'node_modules'), depth + 1));
  }
  return found;
}

/**
 * Normalize the live profile's core `@deepseek-ai/*` packages onto THIS app's
 * bundled runtime.
 *
 * The profile is also maintained by the dsh CLI, whose `dsh plugin install`
 * links core packages against the globally installed npm tree. This app instead
 * spawns its own bundled runtime, and every core package resolved from the
 * profile shadows the runtime's copy with a second module instance. Two
 * instances split module-level state: `@deepseek-ai/dsh-scope` keeps its
 * scope-parent table in a per-instance WeakMap, so a preset that binds an
 * agent's scope through one copy is invisible to the other. Symptoms are
 * exactly inverted from "the preset did not load" — the preset's TOOLS resolve
 * (the tools registry shares the binder's copy) while its prompt sections and
 * its event listeners silently miss the agent: no persona, no workspace
 * AGENTS.md, no skill catalog (2026-09-08). The bundled symbol normalizer
 * cannot repair this, because a WeakMap is not a symbol.
 *
 * Only entries the runtime also ships are relinked, so a profile carrying a
 * newer package than the bundled runtime keeps that package. Every change is
 * reported; failures are logged and never block the boot.
 * @param {string} profileDir
 * @param {string} hostModulesDir - the bundled runtime's node_modules.
 * @param {{ log?: (line: string) => void }} [options]
 * @returns {{ relinked: string[], failed: string[] }}
 */
function normalizeProfileCohort(profileDir, hostModulesDir, options = {}) {
  const log = typeof options.log === 'function' ? options.log : () => {};
  const relinked = [];
  const failed = [];
  const root = path.join(profileDir, 'node_modules');
  const scopeDir = path.join(hostModulesDir, CORE_SCOPE);
  if (!fs.existsSync(root) || !fs.existsSync(scopeDir)) return { relinked, failed };
  const realPath = (target) => {
    try {
      return fs.realpathSync(target);
    } catch {
      return undefined;
    }
  };
  for (const entry of collectCorePackageDirs(root)) {
    const bundled = path.join(scopeDir, entry.pkg);
    if (!fs.existsSync(path.join(bundled, 'package.json'))) continue;
    const target = realPath(bundled);
    if (target !== undefined && realPath(entry.path) === target) continue;
    try {
      fs.rmSync(entry.path, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(entry.path), { recursive: true });
      // A Windows directory junction needs no elevation; a plain 'dir' symlink does.
      fs.symlinkSync(bundled, entry.path, process.platform === 'win32' ? 'junction' : 'dir');
      relinked.push(entry.path);
    } catch (error) {
      failed.push(entry.path);
      log('[desktop] core package relink failed: ' + entry.path + ' (' + String(error && error.message ? error.message : error) + ')');
    }
  }
  return { relinked, failed };
}

module.exports = {
  SEED_MARKER,
  RUNTIME_STAMP,
  resolveRuntimePaths,
  normalizeProfileCohort,
  resolveDshHome,
  readStampFile,
  profileAction,
  applyProfileSeed,
  probeGui,
  findFreePort,
  waitForGui,
  parseTokenUrlLine,
  parseShasums,
  formatHostExitDiagnostic,
  toNodeImportSpecifier,
};

