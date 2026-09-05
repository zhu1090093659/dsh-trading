#!/usr/bin/env node
'use strict';

/**
 * Release-gate check for the bundled desktop toolchain: the staged Node
 * distribution for the current platform must provide node, npm, npx and pnpm,
 * so a machine with zero preinstalled tooling can run the packaged app.
 * Run after prepare-runtime, before electron-builder.
 *
 * Usage: node scripts/verify-runtime-toolchain.mjs
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimeRoot = path.join(desktopDir, 'resources', 'runtime');

/** Staged node directories keyed by the platform that packages them. */
const PLATFORM_TARGETS = {
  darwin: ['node-darwin-arm64', 'node-darwin-x64'],
  win32: ['node-win32-x64'],
};

// Windows tools are .cmd shims that spawnSync cannot execute without a
// shell (ENOENT); args are fixed constants, never user input.
const spawnOptions = { env: { ...process.env }, shell: process.platform === 'win32' };

function toolBin(nodeDir, name) {
  if (process.platform === 'win32') {
    // The Windows distribution has node.exe plus .cmd shims for npm/npx/pnpm.
    return path.join(nodeDir, name === 'node' ? 'node.exe' : name + '.cmd');
  }
  return path.join(nodeDir, 'bin', name);
}

function checkTool(nodeDir, label, bin, args) {
  if (!fs.existsSync(bin)) throw new Error(label + ' is missing from the staged runtime: ' + bin);
  if (process.platform !== 'win32' && fs.lstatSync(bin).isSymbolicLink()) {
    const target = fs.readlinkSync(bin);
    if (path.isAbsolute(target) || !fs.existsSync(path.resolve(path.dirname(bin), target))) {
      throw new Error(label + ' has a broken/absolute symlink: ' + target);
    }
  }
  const version = execFileSync(bin, args, { ...spawnOptions, encoding: 'utf8' }).trim();
  console.log('[verify-runtime-toolchain] ' + label + ' ' + version);
}

function main() {
  const targets = PLATFORM_TARGETS[process.platform];
  if (targets === undefined) throw new Error('unsupported platform: ' + process.platform);

  for (const name of targets) {
    const nodeDir = path.join(runtimeRoot, name);
    if (!fs.existsSync(nodeDir)) throw new Error('staged node distribution is missing (run fetch-node.mjs first): ' + nodeDir);
    console.log('[verify-runtime-toolchain] checking ' + name);
    checkTool(nodeDir, 'node', toolBin(nodeDir, 'node'), ['--version']);
    checkTool(nodeDir, 'npm', toolBin(nodeDir, 'npm'), ['--version']);
    checkTool(nodeDir, 'npx', toolBin(nodeDir, 'npx'), ['--version']);
    checkTool(nodeDir, 'pnpm', toolBin(nodeDir, 'pnpm'), ['--version']);
  }
  console.log('[verify-runtime-toolchain] bundled toolchain (node/npm/npx/pnpm) complete');
}

main();
