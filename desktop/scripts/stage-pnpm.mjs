#!/usr/bin/env node
'use strict';

/**
 * Install pnpm into every staged Node distribution for the current platform
 * so the packaged app carries node + npm + pnpm and works on a machine with
 * zero preinstalled tooling. The dsh host forwards `pnpm <args>` when managing
 * profile plugins; without a bundled pnpm a fresh machine would depend on
 * corepack downloading it from the network on first use.
 *
 * Runs after fetch-node.mjs (needs the staged node-<os>-<cpu> directories)
 * and before build-runtime.mjs. Only the directories matching the running
 * platform are touched: global bin shims are platform-specific (unix symlinks
 * vs Windows cmd shims) and each release runner packages only its own
 * platform's distribution.
 *
 * The pnpm version follows the repository's packageManager pin so the shipped
 * pnpm matches the one that built the runtime payload.
 *
 * Usage: node scripts/stage-pnpm.mjs
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(desktopDir, '..');
const runtimeRoot = path.join(desktopDir, 'resources', 'runtime');

/** Fallback when the repository root has no packageManager pin. */
const FALLBACK_PNPM_VERSION = '11.9.0';

/** Staged node directories keyed by the platform that packages them. */
const PLATFORM_TARGETS = {
  darwin: ['node-darwin-arm64', 'node-darwin-x64'],
  win32: ['node-win32-x64'],
};

// Windows resolves pnpm through a .cmd shim, which spawnSync cannot execute
// without a shell (ENOENT). shell:true is only needed there; args are fixed
// constants, never user input.
const spawnOptions = { env: { ...process.env }, shell: process.platform === 'win32' };

function readPnpmVersionPin() {
  const rootManifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const pin = rootManifest.packageManager;
  const match = typeof pin === 'string' ? /^pnpm@(\d+\.\d+\.\d+[^\s]*)$/.exec(pin.trim()) : null;
  return match === null ? FALLBACK_PNPM_VERSION : match[1];
}

function pnpmPackageDir(nodeDir) {
  // npm lays out global packages under lib/node_modules on unix and directly
  // under node_modules on Windows.
  return process.platform === 'win32'
    ? path.join(nodeDir, 'node_modules', 'pnpm')
    : path.join(nodeDir, 'lib', 'node_modules', 'pnpm');
}

function installedPnpmVersion(nodeDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(pnpmPackageDir(nodeDir), 'package.json'), 'utf8')).version;
  } catch {
    return undefined;
  }
}

function assertRelativeBinLinks(binDir) {
  for (const entry of fs.readdirSync(binDir, { withFileTypes: true })) {
    if (!entry.isSymbolicLink()) continue;
    const target = fs.readlinkSync(path.join(binDir, entry.name));
    if (path.isAbsolute(target) || !fs.existsSync(path.resolve(binDir, target))) {
      throw new Error(entry.name + ' has a broken/absolute symlink: ' + target);
    }
  }
}

function assertPnpmWorks(nodeDir) {
  const binDir = process.platform === 'win32' ? nodeDir : path.join(nodeDir, 'bin');
  const pnpmBin = process.platform === 'win32' ? path.join(binDir, 'pnpm.cmd') : path.join(binDir, 'pnpm');
  if (!fs.existsSync(pnpmBin)) throw new Error('staged pnpm bin is missing: ' + pnpmBin);
  if (process.platform !== 'win32') assertRelativeBinLinks(binDir);
  const version = execFileSync(pnpmBin, ['--version'], { ...spawnOptions, encoding: 'utf8' }).trim();
  console.log('[stage-pnpm] verified pnpm ' + version + ' in ' + path.relative(desktopDir, nodeDir));
}

function main() {
  const targets = PLATFORM_TARGETS[process.platform];
  if (targets === undefined) throw new Error('unsupported platform: ' + process.platform);

  const version = readPnpmVersionPin();
  console.log('[stage-pnpm] installing pnpm@' + version);

  for (const name of targets) {
    const nodeDir = path.join(runtimeRoot, name);
    if (!fs.existsSync(nodeDir)) throw new Error('staged node distribution is missing (run fetch-node.mjs first): ' + nodeDir);

    const current = installedPnpmVersion(nodeDir);
    if (current === version) {
      console.log('[stage-pnpm] ' + name + ' already has pnpm@' + version + ', skipping');
    } else {
      if (current !== undefined) console.log('[stage-pnpm] ' + name + ' has pnpm@' + current + ', upgrading to ' + version);
      execFileSync('npm', [
        'install', '-g', 'pnpm@' + version,
        '--prefix', nodeDir,
        '--no-audit', '--no-fund', '--loglevel=error',
      ], { ...spawnOptions, stdio: 'inherit', maxBuffer: 16 * 1024 * 1024 });
    }
    assertPnpmWorks(nodeDir);
  }
}

main();
