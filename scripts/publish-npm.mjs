#!/usr/bin/env node
'use strict';

/**
 * Publish every publishable @dsh-trading/* workspace package to npm.
 *
 * Requires npm auth (CI: NODE_AUTH_TOKEN via actions/setup-node registry-url;
 * local: your own npm login). Publishing order is topological over the
 * @dsh-trading/* workspace dependency graph so dependents never precede
 * their dependencies. Uses pnpm publish so workspace:* ranges are replaced
 * with real versions in the packed manifest.
 *
 * Idempotent for tag re-pushes: a package whose exact version is already on
 * the registry is skipped. Same-version-different-code re-pushes are
 * forbidden by release discipline (npm versions are immutable) — bump first.
 *
 * Usage: node scripts/publish-npm.mjs
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packagesDir = path.join(repoRoot, 'packages');
const REGISTRY = 'https://registry.npmjs.org/';
// Windows resolves pnpm through a .cmd shim; spawnSync needs a shell there
// (same platform-aware spawn as desktop/scripts/build-runtime.mjs).
const spawnOptions = { env: { ...process.env }, shell: process.platform === 'win32' };

const packages = new Map();
for (const entry of fs.readdirSync(packagesDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const dir = path.join(packagesDir, entry.name);
  const manifestPath = path.join(dir, 'package.json');
  if (!fs.existsSync(manifestPath)) continue;
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (typeof manifest.name !== 'string' || manifest.private === true) continue;
  const deps = { ...manifest.dependencies, ...manifest.devDependencies, ...manifest.optionalDependencies };
  const workspaceDeps = Object.keys(deps).filter((n) => n.startsWith('@dsh-trading/') && String(deps[n]).startsWith('workspace:'));
  packages.set(manifest.name, { dir, version: manifest.version, workspaceDeps });
}

if (packages.size === 0) {
  console.error('publish-npm: no publishable packages found — aborting');
  process.exit(1);
}

// Kahn topological sort over workspace deps (cycles are a packaging bug).
const order = [];
const pending = new Map([...packages].map(([name, p]) => [name, new Set(p.workspaceDeps)]));
while (pending.size > 0) {
  const ready = [...pending.entries()].filter(([, deps]) => [...deps].every((d) => !pending.has(d))).map(([n]) => n);
  if (ready.length === 0) throw new Error('circular workspace dependency among: ' + [...pending.keys()].join(', '));
  for (const name of ready) {
    order.push(name);
    pending.delete(name);
  }
}

function onRegistry(name, version) {
  try {
    execFileSync('npm', ['view', name + '@' + version, 'version', '--registry', REGISTRY], { ...spawnOptions, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

const published = [];
const skipped = [];
const failed = [];
for (const name of order) {
  const pkg = packages.get(name);
  if (onRegistry(name, pkg.version)) {
    skipped.push(name + '@' + pkg.version);
    console.log('[skip] ' + name + '@' + pkg.version + ' already on registry');
    continue;
  }
  console.log('[publish] ' + name + '@' + pkg.version);
  try {
    const output = execFileSync('pnpm', ['publish', '--no-git-checks', '--access', 'public', '--tag', 'latest', '--registry', REGISTRY], {
      cwd: pkg.dir,
      ...spawnOptions,
      maxBuffer: 16 * 1024 * 1024,
    });
    console.log(String(output).split('\n').slice(-2).join('\n'));
    published.push(name + '@' + pkg.version);
  } catch (err) {
    failed.push(name + '@' + pkg.version + ': ' + String(err.stderr || err.message).split('\n').slice(-3).join(' | '));
  }
}

console.log('');
console.log('published: ' + published.length + ', skipped (already on registry): ' + skipped.length + ', failed: ' + failed.length);
if (failed.length > 0) {
  console.error('publish-npm: failures:');
  for (const line of failed) console.error('  - ' + line);
  console.error('Already-published versions are immutable: fix the issue and re-run; do NOT retry the whole tag assuming a clean slate.');
  process.exit(1);
}
