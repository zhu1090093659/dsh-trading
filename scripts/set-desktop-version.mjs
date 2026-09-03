#!/usr/bin/env node
'use strict';

/**
 * Set the desktop app version from the release tag before electron-builder
 * runs, so installer artifact names (dsh-trading-desktop-${version}-*) and
 * the app's reported version always follow the tag. desktop/package.json is
 * private and outside the changesets fixed group, so it is not bumped by
 * 'pnpm changeset version' — the tag is the single version source of truth.
 *
 * Usage (CI): DESKTOP_VERSION=vX.Y.Z node scripts/set-desktop-version.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = path.join(repoRoot, 'desktop', 'package.json');

const version = (process.env.DESKTOP_VERSION ?? '').replace(/^v/, '');
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error('set-desktop-version: DESKTOP_VERSION must be a semver (vX.Y.Z), got "' + process.env.DESKTOP_VERSION + '"');
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
manifest.version = version;
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
console.log('set-desktop-version: desktop/package.json version -> ' + version);
