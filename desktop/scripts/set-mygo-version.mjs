#!/usr/bin/env node
'use strict';

/**
 * Set the mygo shell's version from the release tag before `mygo build` runs.
 *
 * `mygo build` takes the app version from desktop/mygo/mygo.json and nothing
 * else: the bundle's CFBundleShortVersionString, the linked package version and
 * the disk image name (`<slug>-<version>-<arch>.dmg`) all come from it, and the
 * CLI has no version flag and no environment override. The Electron shell has
 * the same shape of problem with desktop/package.json, which
 * scripts/set-desktop-version.mjs rewrites in the runner for one reason: the tag
 * is the single version source of truth. This is the mygo counterpart, so a
 * release built from tag vX.Y.Z ships both shells' artifacts saying X.Y.Z
 * instead of whatever version the manifest was committed with.
 *
 * The rewrite happens in the runner that packages the app; the repository keeps
 * its committed version, and a local build keeps packaging that one.
 *
 * Usage (CI): DESKTOP_VERSION=vX.Y.Z node scripts/set-mygo-version.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = path.join(desktopDir, 'mygo', 'mygo.json');

const version = (process.env.DESKTOP_VERSION ?? '').replace(/^v/, '');
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error('set-mygo-version: DESKTOP_VERSION must be a semver (vX.Y.Z), got "' + process.env.DESKTOP_VERSION + '"');
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const previous = manifest.version;
manifest.version = version;
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
console.log('set-mygo-version: mygo/mygo.json version ' + previous + ' -> ' + version);
console.log('set-mygo-version: disk image becomes ' + manifest.slug + '-' + version + '-<arch>.dmg');
