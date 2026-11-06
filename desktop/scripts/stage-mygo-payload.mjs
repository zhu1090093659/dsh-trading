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
 * Usage:
 *   node scripts/stage-mygo-payload.mjs [--platform darwin-arm64]
 *                                       [--from <runtime>] [--to <resources/runtime>]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultSource = path.join(desktopDir, 'resources', 'runtime');
const defaultTarget = path.join(desktopDir, 'mygo', 'resources', 'runtime');

/** The files the payload must carry, as paths inside the staged directory. */
const REQUIRED = [
  ['node', 'bin', 'node'],
  ['node', 'bin', 'npm'],
  ['node', 'bin', 'npx'],
  ['host', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'],
  ['profile-trading', 'package.json'],
  ['profile-trading', 'cordis.patch.yml'],
];

/** The directories staged into the payload root, beside VERSION.json. */
const STAGED = ['node', 'host', 'profile-trading'];

/** Parse the command line. */
function parseArgs(argv) {
  const options = {
    platform: process.platform + '-' + process.arch,
    from: defaultSource,
    to: defaultTarget,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
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
 * Locate the node distribution inside a payload: node/ in one an app already
 * mapped, node-<os>-<arch>/ in the staged one fetch-node.mjs writes.
 */
function nodeDistribution(source, platform) {
  const mapped = path.join(source, 'node');
  if (fs.existsSync(path.join(mapped, 'bin', 'node'))) return { dir: mapped, name: 'node' };
  const staged = path.join(source, 'node-' + platform);
  if (fs.existsSync(path.join(staged, 'bin', 'node'))) return { dir: staged, name: 'node-' + platform };
  throw new Error(
    'no node distribution in ' + source
    + ': looked for node/bin/node and node-' + platform + '/bin/node (run scripts/fetch-node.mjs first)',
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
function assertComplete(target) {
  for (const parts of REQUIRED) {
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
  assertComplete(options.to);

  console.log('[stage-mygo-payload] from ' + relative(options.from) + ' (' + node.name + ')');
  for (const name of STAGED) {
    console.log('[stage-mygo-payload]   ' + name + '  ' + human(sizeOf(path.join(options.to, name))));
  }
  console.log('[stage-mygo-payload] staged ' + relative(options.to) + ' (gitignored; mygo build ships it as Contents/Resources/runtime)');
}

try {
  main();
} catch (error) {
  console.error('[stage-mygo-payload] ' + String(error && error.message ? error.message : error));
  process.exitCode = 1;
}
