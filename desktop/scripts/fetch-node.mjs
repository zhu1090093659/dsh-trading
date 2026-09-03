#!/usr/bin/env node
'use strict';

/**
 * Download the official Node.js distributions the desktop app bundles, one
 * directory per shipped target under desktop/resources/runtime/node-<os>-<cpu>.
 * Every download is verified against the release's SHASUMS256.txt.
 *
 * Usage: node scripts/fetch-node.mjs [v24.20.0]
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseShasums } = require('../src/runtime.cjs');

const DEFAULT_NODE_VERSION = 'v24.20.0';
// distOs is Node's own archive naming (win, not win32); the staged
// directory keeps the Electron ${os}-${arch} naming for extraResources.
const TARGETS = [
  { os: 'darwin', cpu: 'arm64', ext: 'tar.gz', distOs: 'darwin' },
  { os: 'darwin', cpu: 'x64', ext: 'tar.gz', distOs: 'darwin' },
  { os: 'win32', cpu: 'x64', ext: 'zip', distOs: 'win' },
];

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outRoot = path.join(desktopDir, 'resources', 'runtime');

async function download(url, dest) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error('download failed: ' + response.status + ' ' + url);
  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(dest, buffer);
  return buffer;
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function extract(archive, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  // bsdtar (macOS) and GNU tar both handle tar.gz; bsdtar also unpacks zip.
  execFileSync('tar', ['-xf', archive, '-C', destDir], { stdio: 'inherit' });
}

async function main() {
  const version = process.argv[2] ?? DEFAULT_NODE_VERSION;
  const base = 'https://nodejs.org/dist/' + version;
  const sumsText = await (await fetch(base + '/SHASUMS256.txt')).text();
  const sums = parseShasums(sumsText);

  for (const target of TARGETS) {
    const name = 'node-' + version + '-' + target.distOs + '-' + target.cpu;
    const file = name + '.' + target.ext;
    const expected = sums.get(file);
    if (expected === undefined) throw new Error('SHASUMS256.txt has no entry for ' + file);

    const outDir = path.join(outRoot, 'node-' + target.os + '-' + target.cpu);
    const marker = path.join(outDir, '.node-version');
    if (fs.existsSync(marker) && fs.readFileSync(marker, 'utf8').trim() === version) {
      console.log('[fetch-node] ' + target.os + '-' + target.cpu + ' already at ' + version + ', skipping');
      continue;
    }

    console.log('[fetch-node] downloading ' + file);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-node-'));
    const archive = path.join(tmp, file);
    const buffer = await download(base + '/' + file, archive);
    const actual = sha256(buffer);
    if (actual !== expected) throw new Error('sha256 mismatch for ' + file + ': got ' + actual + ', want ' + expected);

    const unpackDir = path.join(tmp, 'unpacked');
    extract(archive, unpackDir);
    const entries = fs.readdirSync(unpackDir);
    if (entries.length !== 1) throw new Error('unexpected archive layout for ' + file + ': ' + entries.join(', '));

    fs.rmSync(outDir, { recursive: true, force: true });
    fs.mkdirSync(outRoot, { recursive: true });
    fs.cpSync(path.join(unpackDir, entries[0]), outDir, { recursive: true, dereference: true });
    fs.writeFileSync(marker, version + '\n');
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log('[fetch-node] staged ' + target.os + '-' + target.cpu + ' -> ' + path.relative(desktopDir, outDir));
  }
}

main().catch((error) => {
  console.error('[fetch-node] ' + String(error && error.message ? error.message : error));
  process.exitCode = 1;
});
