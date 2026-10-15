'use strict';

/**
 * Pure helpers for the desktop main process. This module must stay free of
 * the electron import so it can be unit-tested with plain node --test.
 */

const fs = require('node:fs');
const { createHash } = require('node:crypto');
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
 * 显式 DSH_HOME 能不能被这个专用壳沿用：判据是路径含 `-trading`，与 CLI wrapper
 * `scripts/home/dsh-trading` 的 `case "${DSH_HOME:-}" in *-trading*` 是同一条判据。
 * 判据落在**展开之前**的原文上，所以被接受的是 `~/.dsh-trading`、`~/probe-trading`
 * 这类值——冒烟/取证用的独立 home 因此要命名成 *-trading。
 * @param {unknown} value
 */
function isTradingHomePath(value) {
  return typeof value === 'string' && value.includes('-trading');
}

/**
 * 选出这个壳管理的 DSH home，并把被忽略的显式值回报给调用方（供告警用）。不是
 * trading home 的一切显式值都回落到 ~/.dsh-trading：这是 DSH Trading 专用壳，
 * Dock 直点不带环境变量，trading home 必须是内置缺省（2026-09-08；宿主 dsh CLI
 * 自身的缺省仍是 ~/.dsh，两者语义不同是刻意的）。空白视为未设；`~` 与 `~/x` 对
 * 判据接受的值照旧展开。
 *
 * 为什么要判据（2026-10-14 实证）：agent/harness 会话 shell 把宿主实例的
 * DSH_HOME=~/.dsh 整份带给 GUI app，无条件沿用就落回宿主 home——交易数据、
 * 自定义指标与 profile 全写错地方（dsh-host.log 第 9-15 行 `[desktop] dsh home:
 * /Users/zcl/.dsh` + `[dsh-home] 解析到缺省 home …` 告警 + `profile action:
 * reseed` 把 ~/.dsh/profiles/trading-web 播种成 app 载荷，而该 home 下没有
 * indicators/custom.json ⇒ 自定义指标为空）。
 * @param {NodeJS.ProcessEnv} env
 * @param {string} homedir
 * @returns {{ home: string, ignored: string | undefined }} `ignored` 是被忽略的显式
 *   DSH_HOME 原文（未展开）；未忽略时为 undefined。
 */
function selectDshHome(env, homedir) {
  const tradingHome = path.join(homedir, '.dsh-trading');
  const configured = env.DSH_HOME;
  if (configured === undefined || configured.trim() === '') return { home: tradingHome, ignored: undefined };
  const trimmed = configured.trim();
  if (!isTradingHomePath(trimmed)) return { home: tradingHome, ignored: trimmed };
  if (trimmed === '~') return { home: homedir, ignored: undefined };
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return { home: path.join(homedir, trimmed.slice(2)), ignored: undefined };
  }
  return { home: path.resolve(trimmed), ignored: undefined };
}

/**
 * Resolve the bundled dependency payload the Office and workspace-dependency rows
 * consume. The payload is never copied or downloaded by this app: it is read in
 * place when the installation or the trading home already carries one, and the
 * rows stay explicitly disabled otherwise (no silent system-Python fallback).
 *
 * Candidates, in order: a payload staged inside this app's runtime resources (for
 * a carrier that ships one), then the conventional per-home location used by the
 * official desktop. Only a directory holding runtime.json qualifies.
 *
 * The host "$HOME/.dsh/dsh-runtimes/..." instance is deliberately NOT a candidate:
 * this project runs under the dedicated trading home, and reaching across homes is
 * the user's decision, not this shell's.
 * @param {string} runtimeRoot - Absolute runtime payload directory.
 * @param {string} home - Resolved DSH home (the trading home by default).
 * @returns {string|undefined} Absolute payload directory, or undefined when neither candidate exists.
 */
function resolvePrimaryRuntime(runtimeRoot, home) {
  const candidates = [
    path.join(runtimeRoot, 'primary-runtime'),
    path.join(home, 'dsh-runtimes', 'dsh-primary-runtime'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'runtime.json'))) return candidate;
  }
  return undefined;
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
 * Root entries the packaged profile seed carries. vendor/ holds the packed
 * workspace tarballs the generated manifest references as file:./vendor/*.tgz,
 * so the seed installs plugins inside $DSH_HOME without the repository.
 */
const PROFILE_SEED_FILES = [
  'package.json',
  'pnpm-workspace.yaml',
  'cordis.patch.yml',
  'vendor',
  'node_modules',
];

/**
 * pnpm bookkeeping the build machine wrote, relative to the seed's
 * node_modules. .modules.yaml records absolute storeDir/virtualStoreDir,
 * .pnpm-workspace-state-v1.json the absolute project path and .pnpm the
 * generated lock state, so pnpm on the user's machine rejects the tree
 * (ERR_PNPM_UNEXPECTED_STORE / ERR_PNPM_UNEXPECTED_VIRTUAL_STORE). Dropping
 * the storeDir and virtualStoreDir keys alone still fails with "linked from
 * the store at undefined" — the whole entry has to go; the first install
 * regenerates all of them locally.
 */
const PROFILE_SEED_BUILD_HOST_STATE = [
  '.modules.yaml',
  '.pnpm-workspace-state-v1.json',
  '.package-map.json',
  '.pnpm',
];

/**
 * Strip the build machine's pnpm state from a profile seed directory.
 * @param {string} seedDir
 * @returns {string[]} the entries removed, for logging.
 */
function pruneProfileSeedBuildHostState(seedDir) {
  const removed = [];
  for (const relative of PROFILE_SEED_BUILD_HOST_STATE) {
    const target = path.join(seedDir, 'node_modules', relative);
    if (!fs.existsSync(target)) continue;
    fs.rmSync(target, { recursive: true, force: true });
    removed.push(relative);
  }
  return removed;
}

/**
 * Assert a staged profile seed can install plugins on its own: it carries no
 * build machine pnpm state and every file:./vendor/*.tgz its manifest points at
 * is present. The packaged seed is the only copy the user's $DSH_HOME gets, so
 * build-runtime.mjs fails the build instead of shipping an unusable one.
 * @param {string} seedDir
 * @returns {number} how many vendored tarballs the manifest references.
 */
function assertProfileSeedSelfContained(seedDir) {
  for (const relative of PROFILE_SEED_BUILD_HOST_STATE) {
    if (fs.existsSync(path.join(seedDir, 'node_modules', relative))) {
      throw new Error('profile seed carries build-host pnpm state: node_modules/' + relative);
    }
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(seedDir, 'package.json'), 'utf8'));
  const vendored = [...new Set(Object.values(manifest.dependencies ?? {})
    .filter((spec) => typeof spec === 'string' && spec.startsWith('file:./vendor/'))
    .map((spec) => spec.slice('file:./vendor/'.length)))];
  if (vendored.length === 0) throw new Error('profile seed references no vendor tarball');
  for (const file of vendored) {
    if (!fs.existsSync(path.join(seedDir, 'vendor', file))) {
      throw new Error('profile seed is missing vendor/' + file + ' (referenced by its package.json)');
    }
  }
  return vendored.length;
}

/** Hash the staged profile contents, independent of file timestamps and location. */
function profileSeedFingerprint(seedDir) {
  const hash = createHash('sha256');
  const visit = (dir, relativeDir) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name);
      const relative = relativeDir ? relativeDir + '/' + name : name;
      const stat = fs.lstatSync(file);
      if (stat.isDirectory()) visit(file, relative);
      else if (stat.isFile()) {
        const contents = fs.readFileSync(file);
        hash.update(relative + '\0' + contents.length + '\0');
        hash.update(contents);
      } else {
        throw new Error('profile seed contains an unsupported entry: ' + relative);
      }
    }
  };
  visit(seedDir, '');
  return hash.digest('hex');
}

/** Include plugin content in seed identity; older runtime stamps remain readable. */
function runtimeSeedStamp(stamp) {
  return stamp === undefined ? 'unknown' : [stamp.node, stamp.host, stamp.profileHash ?? stamp.webAll].join(' / ');
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
    filter: (source) => action !== 'reseed' || !keep(path.relative(seedDir, source)),
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

/**
 * The host prints its tokenized GUI URL on this stdout line. Only the URL
 * token is required, not the whole rest of the line: a non-loopback bind
 * appends " (LAN: <url>)" (dsh-web-app prints one line with both), and an
 * anchored end-of-line pattern turns that into "no token line seen" — which
 * used to mean loading the unauthenticated URL (2026-10-15). Matching the
 * scheme also rejects the host's other "dsh web: opening the default
 * browser…" line.
 */
const TOKEN_URL_PATTERN = /^dsh web: (https?:\/\/\S+)/;

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
 * Wait for the host's tokenized GUI URL line.
 *
 * The port answering is not readiness: the web server binds and answers 401
 * before the host has loaded its plugins and printed this line (observed on
 * the trading profile 2026-10-15). Without the line there is no way in — the
 * launch token is per-process and no cookie exists for a port the shell has
 * never authenticated on — so the shell waits here while the host is alive
 * instead of loading the bare URL and parking the window on the 401 page.
 * @param {object} options
 * @param {() => (string | undefined)} options.readUrl - Current parsed URL, if the line has arrived.
 * @param {() => boolean} options.isAlive - Whether the host process is still running.
 * @param {number} options.deadlineMs - Budget for the line to arrive.
 * @param {number} options.pollMs - Poll interval.
 * @returns {Promise<string>} The tokenized URL the window must load.
 */
async function waitForTokenUrl(options) {
  const deadline = Date.now() + options.deadlineMs;
  for (;;) {
    const url = options.readUrl();
    if (url !== undefined) return url;
    if (!options.isAlive()) throw new Error('the dsh host process exited before it printed its tokenized GUI URL');
    if (Date.now() >= deadline) {
      throw new Error(`timed out after ${Math.round(options.deadlineMs / 1000)}s waiting for the host to print its tokenized GUI URL`);
    }
    await new Promise((resolvePromise) => {
      setTimeout(resolvePromise, options.pollMs);
    });
  }
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

/**
 * The POSIX dsh CLI shim content (see {@link writeHostCliShims}).
 * @returns {string}
 */
function hostCliShimPosix() {
  return [
    '#!/bin/sh',
    '# dsh-trading desktop CLI shim (generated by desktop/scripts/build-runtime.mjs).',
    '#',
    '# The plugin-manager gateway resolves the official dsh CLI by walking',
    '# node_modules/.bin upward from the running host entry; the staged payload',
    '# strips every pnpm .bin directory, so this file restores that exact lookup',
    '# path and runs the bundled host entry with the bundled Node runtime.',
    'set -e',
    'here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)',
    'entry="$here/../@deepseek-ai/dsh/lib/bin.js"',
    'for candidate in "$here/../../../node/bin/node" "$here"/../../../node-*/bin/node; do',
    '  if [ -x "$candidate" ]; then exec "$candidate" "$entry" "$@"; fi',
    'done',
    'exec node "$entry" "$@"',
    '',
  ].join('\n');
}

/**
 * The Windows dsh CLI shim content. The gateway spawns the bundled node.exe
 * plus the host entry directly once it finds this shim (the npm-shim branch of
 * its spawn command), so the batch body is only a fallback.
 * @returns {string}
 */
function hostCliShimWindows() {
  return [
    '@echo off',
    'rem dsh-trading desktop CLI shim (generated by desktop/scripts/build-runtime.mjs).',
    'rem The plugin-manager gateway resolves the official dsh CLI by walking',
    'rem node_modules/.bin upward from the running host entry; the staged payload',
    'rem strips every pnpm .bin directory, so this file restores that lookup path.',
    'setlocal',
    'set "HERE=%~dp0"',
    'set "ENTRY=%HERE%..\\@deepseek-ai\\dsh\\lib\\bin.js"',
    'if exist "%HERE%..\\..\\..\\node\\node.exe" (',
    '  "%HERE%..\\..\\..\\node\\node.exe" "%ENTRY%" %*',
    '  exit /b %ERRORLEVEL%',
    ')',
    'for /d %%D in ("%HERE%..\\..\\..\\node-*") do (',
    '  if exist "%%D\\node.exe" (',
    '    "%%D\\node.exe" "%ENTRY%" %*',
    '    exit /b %ERRORLEVEL%',
    '  )',
    ')',
    'node "%ENTRY%" %*',
    'exit /b %ERRORLEVEL%',
    '',
  ].join('\r\n');
}

/**
 * Path of the dsh CLI shim inside a staged host tree. The plugin-manager
 * gateway probes exactly this location (host/node_modules/.bin/dsh) when it
 * walks up from the host entry looking for the CLI.
 * @param {string} hostDir - staged host root (.../runtime/host).
 * @returns {string}
 */
function hostCliShimPath(hostDir, platform = process.platform) {
  return path.join(hostDir, 'node_modules', '.bin', platform === 'win32' ? 'dsh.cmd' : 'dsh');
}

/**
 * Write the dsh CLI shims into a staged host tree.
 *
 * Why they are needed: the desktop payload deliberately removes every pnpm
 * .bin directory (symlinks cannot survive installers), which also removes the
 * only dsh the plugin-manager gateway can find when the machine has no
 * globally installed CLI. Both platform shims are written into the shared,
 * platform-independent host tree: a mac package ignores the .cmd and a
 * Windows package ignores the shell script.
 * @param {string} hostDir - staged host root (.../runtime/host).
 * @param {{ log?: (line: string) => void }} [options]
 * @returns {{ posix: string, windows: string }}
 */
function writeHostCliShims(hostDir, options = {}) {
  const log = typeof options.log === 'function' ? options.log : () => {};
  const binDir = path.join(hostDir, 'node_modules', '.bin');
  fs.mkdirSync(binDir, { recursive: true });
  const posix = path.join(binDir, 'dsh');
  const windows = path.join(binDir, 'dsh.cmd');
  fs.writeFileSync(posix, hostCliShimPosix(), { mode: 0o755 });
  fs.writeFileSync(windows, hostCliShimWindows());
  log('[build-runtime] wrote CLI shims ' + path.relative(hostDir, posix) + ' / ' + path.basename(windows));
  return { posix, windows };
}

/** 落盘的级别集合：GUI 的 info/debug 噪音大，丢弃。 */
const RENDERER_LOG_LEVELS = new Set(['warning', 'error']);

/** 单行上限：渲染进程一条超长 message 就能把宿主日志撑爆。 */
const RENDERER_LOG_LINE_MAX = 500;

/**
 * 来源字段上限。客户端插件批的 combo URL 是一行 2.8 KiB 的
 * `/plugins/??<每个客户端入口>&rev=…`，来源若不受限就吃掉整行预算，日得下的
 * 只剩 URL、真正说明原因的那句 message 反被截掉（2026-10-15 实证：一次
 * `[renderer] error` 行 100% 是 URL）。来源收短到能指认入口即可，余下预算全给
 * message。
 */
const RENDERER_LOG_SOURCE_MAX = 120;

/** 截断标记：留下「这条被截过」的证据，而不是静默丢尾。 */
const RENDERER_LOG_TRUNCATION = ' ...[truncated]';

/** 旧版位置参数级别的名字表：0 起依次 verbose / info / warning / error。 */
const LEGACY_CONSOLE_LEVELS = ['verbose', 'info', 'warning', 'error'];

/**
 * 级别归一：Electron 用 warning/error 命名（`console.warn` 到达时是 warning），
 * 旧版位置参数是 0..3 的数字。其余（verbose/info/debug）不落盘。
 * @param {unknown} level
 * @returns {'warning' | 'error' | undefined}
 */
function normalizeRendererLevel(level) {
  const name = typeof level === 'string' ? level.toLowerCase() : LEGACY_CONSOLE_LEVELS[level];
  const canonical = name === 'warn' ? 'warning' : name;
  return RENDERER_LOG_LEVELS.has(canonical) ? canonical : undefined;
}

/**
 * Electron 的 webContents `console-message` 在 44.1.1 把字段放进详情对象
 * (`Event<WebContentsConsoleMessageEventParams>`)，同时保留早先的位置参数
 * (event, level, message, line, sourceId)（node_modules/electron/electron.d.ts:16209
 * 与 :24277）。两种形状归一到同一个描述对象，落盘代码只认这一个形状。
 * @param {unknown} details
 * @param {number} [legacyLevel]
 * @param {string} [legacyMessage]
 * @param {number} [legacyLine]
 * @param {string} [legacySourceId]
 * @returns {{ level: unknown, message: unknown, source: unknown, line: unknown }}
 */
function consoleMessageArgsToEntry(details, legacyLevel, legacyMessage, legacyLine, legacySourceId) {
  const isDetails = details !== null && typeof details === 'object' && typeof details.message === 'string';
  if (isDetails) {
    return { level: details.level, message: details.message, source: details.sourceId, line: details.lineNumber };
  }
  return { level: legacyLevel, message: legacyMessage, source: legacySourceId, line: legacyLine };
}

/**
 * 来源字段收短到 {@link RENDERER_LOG_SOURCE_MAX}，超出部分记成省略字数（保留长度
 * 线索，不静默丢尾）。短来源原样返回，既有行形不变。
 * @param {unknown} value
 * @returns {string}
 */
function shortenRendererSource(value) {
  if (value === undefined || value === '') return '';
  const text = String(value);
  if (text.length <= RENDERER_LOG_SOURCE_MAX) return text;
  const head = text.slice(0, RENDERER_LOG_SOURCE_MAX - 20);
  return head + '…(+' + String(text.length - head.length) + 'ch)';
}

/**
 * 渲染进程 console 消息 → 一条 dsh-host.log 行；该丢弃的级别返回 undefined。
 * 行形如 `[renderer] <level> <sourceId>:<行号> <message>`，来源放在正文前面，
 * 这样超长消息被截断后仍能指认是谁在哪一行打的；来源自身先按上限收短，免得
 * 一条 combo URL 把 message 挤出预算。
 * @param {{ level: unknown, message: unknown, source?: unknown, line?: unknown }} entry
 * @returns {string | undefined}
 */
function rendererLogLine(entry) {
  const level = normalizeRendererLevel(entry.level);
  if (level === undefined) return undefined;
  const source = shortenRendererSource(entry.source);
  const lineNumber = entry.line === undefined || entry.line === null ? '' : ':' + String(entry.line);
  const head = '[renderer] ' + level + (source === '' ? '' : ' ' + source + lineNumber);
  // 一条 message 里的换行必须收成一个空格：宿主日志一行一条记录。
  const message = String(entry.message === undefined ? '' : entry.message).replace(/\s*\r?\n\s*/g, ' ');
  const budget = RENDERER_LOG_LINE_MAX - head.length - 1 - RENDERER_LOG_TRUNCATION.length;
  const body = message.length <= budget ? message : message.slice(0, Math.max(0, budget)) + RENDERER_LOG_TRUNCATION;
  const rendered = head + ' ' + body;
  // sourceId 畸形超长时仍守住单行上限。
  return rendered.length <= RENDERER_LOG_LINE_MAX
    ? rendered
    : rendered.slice(0, RENDERER_LOG_LINE_MAX - RENDERER_LOG_TRUNCATION.length) + RENDERER_LOG_TRUNCATION;
}

module.exports = {
  SEED_MARKER,
  RUNTIME_STAMP,
  resolveRuntimePaths,
  hostCliShimPath,
  writeHostCliShims,
  normalizeProfileCohort,
  isTradingHomePath,
  selectDshHome,
  RENDERER_LOG_LEVELS,
  RENDERER_LOG_LINE_MAX,
  RENDERER_LOG_SOURCE_MAX,
  shortenRendererSource,
  normalizeRendererLevel,
  consoleMessageArgsToEntry,
  rendererLogLine,
  resolvePrimaryRuntime,
  readStampFile,
  PROFILE_SEED_FILES,
  PROFILE_SEED_BUILD_HOST_STATE,
  pruneProfileSeedBuildHostState,
  assertProfileSeedSelfContained,
  profileSeedFingerprint,
  runtimeSeedStamp,
  profileAction,
  applyProfileSeed,
  probeGui,
  findFreePort,
  waitForGui,
  waitForTokenUrl,
  parseTokenUrlLine,
  parseShasums,
  formatHostExitDiagnostic,
  toNodeImportSpecifier,
};
