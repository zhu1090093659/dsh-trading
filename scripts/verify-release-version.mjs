#!/usr/bin/env node
'use strict';

/**
 * Release gate: every @dsh-trading/* package version must equal the release
 * tag version. The desktop installer carries the workspace packages as
 * packed tarballs, so a mismatch would ship installers whose internal
 * package versions disagree with the release version.
 *
 * Usage (CI): EXPECTED_VERSION=vX.Y.Z node scripts/verify-release-version.mjs
 *
 * Exits 0 when all family versions match; exits 1 with the mismatch list
 * otherwise (fix versions via changesets first, then re-tag).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packagesDir = path.join(repoRoot, 'packages');

const expected = (process.env.EXPECTED_VERSION ?? '').replace(/^v/, '');
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(expected)) {
  console.error('verify-release-version: EXPECTED_VERSION must be a semver (vX.Y.Z), got "' + process.env.EXPECTED_VERSION + '"');
  process.exit(1);
}

const mismatches = [];
const checked = [];
for (const entry of fs.readdirSync(packagesDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
  if (!entry.isDirectory()) continue;
  const manifestPath = path.join(packagesDir, entry.name, 'package.json');
  if (!fs.existsSync(manifestPath)) continue;
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (typeof manifest.name !== 'string' || !manifest.name.startsWith('@dsh-trading/')) continue;
  checked.push(manifest.name + '@' + manifest.version);
  if (manifest.version !== expected) mismatches.push(manifest.name + ' = ' + manifest.version);
}

if (checked.length === 0) {
  console.error('verify-release-version: no @dsh-trading/* packages found under packages/ — aborting');
  process.exit(1);
}

if (mismatches.length > 0) {
  console.error('verify-release-version: tag v' + expected + ' does not match ' + mismatches.length + ' package(s):');
  for (const line of mismatches) console.error('  - ' + line);
  console.error('Bump versions (pnpm changeset version) so the whole family is at ' + expected + ', commit, then re-tag.');
  process.exit(1);
}

console.log('verify-release-version: ' + checked.length + ' @dsh-trading/* packages all at ' + expected);
