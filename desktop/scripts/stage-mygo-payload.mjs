#!/usr/bin/env node
'use strict';

/**
 * Stage the desktop runtime payload into the layout `mygo build` ships.
 *
 * The Electron shell reads desktop/resources/runtime/{node-<os>-<cpu>,host,
 * profile-trading,VERSION.json}: electron-builder's extraResources maps the
 * per-platform node directory to runtime/node. The mygo shell reads the same
 * payload from its own resources directory, already mapped:
 * resources/runtime/{node,host,profile-trading,VERSION.json}
 * (desktop/mygo/internal/launch/runtime.go). This script is the bridge between
 * the two: it copies the staged payload into desktop/mygo/resources/runtime,
 * mapping node-<os>-<cpu> to node, and fails before a build when the payload is
 * incomplete.
 *
 * The payload is a build output of fetch-node.mjs / stage-pnpm.mjs /
 * build-runtime.mjs: desktop/mygo/.gitignore keeps it out of the repository, and
 * every machine stages it before mygo build runs. --from also accepts the
 * runtime directory of an installed app
 * (/Applications/DSH Trading.app/Contents/Resources/runtime), whose layout is
 * already mapped.
 *
 * The copy is then trimmed to the platform it is staged for
 * (scripts/prune-mygo-payload.mjs): the source keeps every platform, because the
 * Electron payload serves mac arm64 + mac x64 + win32, while a mygo build ships
 * one. --keep-all-platforms stages every platform's packages instead, for a
 * payload packed for more than one target.
 *
 * --platform takes the target the way mygo build names it (GOOS/GOARCH) or with
 * a dash: darwin/arm64, windows/amd64, windows-amd64. The payload keeps
 * Electron's naming, so windows/amd64 stages node-win32-x64 and trims to
 * win32-x64 (fetch-node.mjs TARGETS, prune-mygo-payload.mjs PLATFORM_TAGS).
 * The node distribution is read as it is shipped: bin/node on unix, node.exe at
 * its root for Windows.
 *
 * Usage:
 *   node scripts/stage-mygo-payload.mjs [--platform darwin-arm64|windows/amd64]
 *                                       [--from <runtime>] [--to <resources/runtime>]
 *                                       [--keep-all-platforms]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prune } from './prune-mygo-payload.mjs';

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultSource = path.join(desktopDir, 'resources', 'runtime');
const defaultTarget = path.join(desktopDir, 'mygo', 'resources', 'runtime');

/**
 * Where a node distribution keeps what the shell runs: bin/node and its
 * npm/npx wrappers on unix, node.exe and the .cmd wrappers at the root in the
 * Windows archive.
 */
const NODE_LAYOUTS = [
  { name: 'bin/node', executable: ['bin', 'node'], npm: ['bin', 'npm'], npx: ['bin', 'npx'] },
  { name: 'node.exe', executable: ['node.exe'], npm: ['npm.cmd'], npx: ['npx.cmd'] },
];

/** The files the payload must carry of the host and of the profile seed. */
const REQUIRED_PAYLOAD = [
  ['host', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'],
  ['profile-trading', 'package.json'],
  ['profile-trading', 'cordis.patch.yml'],
];

/** The files the payload must carry once node is mapped to node/, as staged paths. */
function requiredFiles(layout) {
  return [
    ['node', ...layout.executable],
    ['node', ...layout.npm],
    ['node', ...layout.npx],
    ...REQUIRED_PAYLOAD,
  ];
}

/** The directories staged into the payload root, beside VERSION.json. */
const STAGED = ['node', 'host', 'profile-trading'];

/**
 * What a --platform value names in the payload: mygo build takes GOOS/GOARCH
 * (windows/amd64) and the build scripts may pass it with a dash, while the
 * payload keeps Electron's naming, where the Windows x64 node distribution is
 * node-win32-x64 (fetch-node.mjs TARGETS) and the packages trimmed for it are
 * tagged win32-x64 (prune-mygo-payload.mjs PLATFORM_TAGS). Every other target
 * passes through, so darwin-arm64 stages what it always staged.
 */
function targetPlatform(value) {
  const key = String(value).trim().toLowerCase().replace(/\//g, '-');
  if (key === 'windows-amd64') return 'win32-x64';
  return key;
}

/** The layout of the node distribution at dir, or null when it holds none. */
function nodeLayout(dir) {
  for (const layout of NODE_LAYOUTS) {
    if (fs.existsSync(path.join(dir, ...layout.executable))) return layout;
  }
  return null;
}

/** Parse the command line. */
function parseArgs(argv) {
  const options = {
    platform: process.platform + '-' + process.arch,
    from: defaultSource,
    to: defaultTarget,
    keepAll: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--keep-all-platforms') {
      options.keepAll = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined) throw new Error(flag + ' needs a value');
    if (flag === '--platform') options.platform = value;
    else if (flag === '--from') options.from = path.resolve(value);
    else if (flag === '--to') options.to = path.resolve(value);
    else throw new Error('unknown flag ' + flag);
    i += 1;
  }
  return options;
}

/**
 * Locate the node distribution of the target inside a payload: node-<os>-<arch>/
 * in the staged payload fetch-node.mjs writes, which holds every target, or node/
 * in one an app already mapped, which holds the one target that app ships.
 *
 * The platform directory comes first, so a payload that carries several can never
 * hand a Windows build the macOS node it also holds. The layout has to be the one
 * the target runs—node.exe for Windows, bin/node elsewhere—because a mapped node/
 * of another platform looks like a match until the installer ships it: a Windows
 * app with a Mach-O node cannot start a host.
 */
function nodeDistribution(source, platform) {
  const wanted = platform.startsWith('win32') ? 'node.exe' : 'bin/node';
  const candidates = [
    { dir: path.join(source, 'node-' + platform), name: 'node-' + platform },
    { dir: path.join(source, 'node'), name: 'node' },
  ];
  const looked = [];
  let wrongLayout = '';
  for (const candidate of candidates) {
    const layout = nodeLayout(candidate.dir);
    if (layout !== null && layout.name === wanted) return { ...candidate, layout };
    if (layout !== null) wrongLayout = candidate.name + ' holds ' + layout.name;
    looked.push(candidate.name + '/{' + NODE_LAYOUTS.map((l) => l.name).join(',') + '}');
  }
  throw new Error(
    'no ' + wanted + ' for ' + platform + ' in ' + source + ': looked for ' + looked.join(' and ')
    + (wrongLayout === '' ? '' : ' (' + wrongLayout + '), which belongs to another platform: an installed app carries the node of the machine it runs on, and only a staged desktop/resources/runtime carries every target (run scripts/fetch-node.mjs)')
    + (wrongLayout === '' ? ' (run scripts/fetch-node.mjs first)' : ''),
  );
}

/** Copy one directory tree, keeping the node distribution's relative symlinks. */
function copyTree(source, target) {
  fs.cpSync(source, target, { recursive: true, verbose: false, verbatimSymlinks: true });
}

/** Sum the bytes of a tree, without following symlinks out of it. */
function sizeOf(target) {
  const stat = fs.lstatSync(target);
  if (!stat.isDirectory()) return stat.size;
  let total = 0;
  for (const entry of fs.readdirSync(target)) total += sizeOf(path.join(target, entry));
  return total;
}

/** Render a byte count the way du -sh does. */
function human(bytes) {
  const units = ['B', 'K', 'M', 'G', 'T'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return (unit === 0 ? String(value) : value.toFixed(value < 10 ? 1 : 0)) + units[unit];
}

/** The path as the repository prints it. */
function relative(target) {
  const rel = path.relative(desktopDir, target);
  return rel.startsWith('..') ? target : rel;
}

/** Fail when a staged payload cannot start a host or seed the profile. */
function assertComplete(target, layout) {
  for (const parts of requiredFiles(layout)) {
    const file = path.join(target, ...parts);
    let stat;
    try {
      stat = fs.lstatSync(file);
    } catch {
      throw new Error('the staged payload is missing ' + path.join(...parts) + ' (incomplete payload: ' + target + ')');
    }
    if (stat.isDirectory()) throw new Error('the staged payload has a directory where ' + path.join(...parts) + ' is a file');
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const requested = options.platform;
  options.platform = targetPlatform(options.platform);
  if (options.platform !== requested) {
    console.log('[stage-mygo-payload] ' + requested + ' is ' + options.platform + ' in the payload (node-win32-x64, prune tag win32-x64)');
  }
  const node = nodeDistribution(options.from, options.platform);
  for (const name of ['host', 'profile-trading']) {
    const source = path.join(options.from, name);
    if (!fs.existsSync(source)) {
      throw new Error('the payload in ' + options.from + ' has no ' + name + '/ (run scripts/build-runtime.mjs first)');
    }
  }

  fs.rmSync(options.to, { recursive: true, force: true });
  fs.mkdirSync(options.to, { recursive: true });
  copyTree(node.dir, path.join(options.to, 'node'));
  for (const name of ['host', 'profile-trading']) {
    copyTree(path.join(options.from, name), path.join(options.to, name));
  }
  const stamp = path.join(options.from, 'VERSION.json');
  if (fs.existsSync(stamp)) fs.copyFileSync(stamp, path.join(options.to, 'VERSION.json'));
  if (options.keepAll) {
    console.log('[stage-mygo-payload] payload kept complete: every platform stays (--keep-all-platforms)');
  } else {
    prune({ root: options.to, platform: options.platform });
  }
  assertComplete(options.to, node.layout);

  console.log('[stage-mygo-payload] from ' + relative(options.from) + ' (' + node.name + ', ' + node.layout.name + ')');
  for (const name of STAGED) {
    console.log('[stage-mygo-payload]   ' + name + '  ' + human(sizeOf(path.join(options.to, name))));
  }
  console.log('[stage-mygo-payload] staged ' + relative(options.to) + ' for ' + options.platform
    + ' (gitignored; mygo build ships it as Contents/Resources/runtime)');
}

try {
  main();
} catch (error) {
  console.error('[stage-mygo-payload] ' + String(error && error.message ? error.message : error));
  process.exitCode = 1;
}
