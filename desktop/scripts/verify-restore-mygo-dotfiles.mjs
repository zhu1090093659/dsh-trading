#!/usr/bin/env node
'use strict';

/**
 * Verify the dotfile restore on a fixture bundle, without building anything.
 *
 * restore-mygo-dotfiles.mjs writes into an app bundle, so what it is allowed to
 * write is checked here: a staged payload with dotfiles mygo drops, a bundle
 * that copy produced, and then the cases the build relies on:
 *
 *   1. --check sees the gap and exits 1 while nothing is restored;
 *   2. the restore copies exactly the dotfiles, byte for byte, keeping mode and
 *      modification time, and creates the hidden directories they live in;
 *   3. after it, --check exits 0 and the two trees match entry for entry;
 *   4. a second run has nothing to do (the restore is idempotent);
 *   5. a missing file that is not a dotfile is refused, and nothing is written;
 *   6. a bundle file the payload does not hold is refused;
 *   7. a bundle file whose content differs from the payload is refused;
 *   8. the report carries the copied count and the entries (the build reads the
 *      count out of it with plutil);
 *   9. the command line works when the script is reached through a symlinked
 *      directory, which is how a build under /tmp calls it on macOS.
 *
 * Run it whenever the restore or the packaging step around it changes:
 *   node desktop/scripts/verify-restore-mygo-dotfiles.mjs
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const modulePath = path.join(here, 'restore-mygo-dotfiles.mjs');
const { restore } = await import(pathToFileURL(modulePath).href);

let checks = 0;

/** Assert one property of the restore and say so. */
function check(what, condition, detail) {
  checks += 1;
  assert.ok(condition, what + (detail === undefined ? '' : ' (' + detail + ')'));
  console.log('  ok  ' + what);
}

/** Write one fixture file, creating its directories. */
function file(root, relative, content, mode = 0o644) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  fs.chmodSync(target, mode);
  return Buffer.byteLength(content);
}

/** A staged payload and the bundle a dot-dropping copy makes of it. */
function makeFixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'restore-mygo-dotfiles-'));
  const source = path.join(base, 'payload');
  const bundle = path.join(base, 'bundle');
  const sizes = {};
  sizes.manifest = file(source, 'host/node_modules/pi-ai/dist/providers/data/.manifest.json', '{"models":[]}\n');
  sizes.modules = file(source, 'host/node_modules/.modules.yaml', 'hoistedDependencies: {}\n');
  sizes.yarn = file(source, 'host/node_modules/domino/.yarn/plugins/plugin-version.cjs', 'module.exports = 1\n');
  sizes.keep = file(source, 'host/node_modules/plain/lib/.keep', '', 0o600);
  sizes.index = file(source, 'host/node_modules/plain/lib/index.js', 'exports.plain = 1\n');
  sizes.profile = file(source, 'profile-trading/node_modules/.tool/x.txt', 'x\n');
  sizes.sibling = file(source, 'host/node_modules/pi-ai/dist/providers/data/deepseek.json', '{"models":["x"]}\n');
  sizes.domino = file(source, 'host/node_modules/domino/package.json', '{"name":"domino"}\n');
  sizes.profileManifest = file(source, 'profile-trading/package.json', '{"name":"trading-web"}\n');
  sizes.profilePackage = file(source, 'profile-trading/node_modules/plain/index.js', 'exports.shipped = 1\n');
  // What mygo build ships: the same tree without any name that starts with a dot,
  // which leaves the directories around a hidden file in place (the real
  // @earendil-works/pi-ai package holds .manifest.json beside its JSON files).
  for (const relative of [
    'host/node_modules/plain/lib/index.js',
    'host/node_modules/pi-ai/dist/providers/data/deepseek.json',
    'host/node_modules/domino/package.json',
    'profile-trading/package.json',
    'profile-trading/node_modules/plain/index.js',
  ]) {
    file(bundle, relative, fs.readFileSync(path.join(source, relative), 'utf8'));
  }
  fs.chmodSync(path.join(bundle, 'host/node_modules/plain/lib/index.js'), 0o755);
  return { base, source, bundle, sizes };
}

/** Drop a fixture tree. */
function drop(base) {
  fs.rmSync(base, { recursive: true, force: true });
}

/** Run the command line and return its result. */
function run(args) {
  return spawnSync(process.execPath, [modulePath, ...args], { encoding: 'utf8' });
}

console.log('restore-mygo-dotfiles: fixture cases');

// 1-4. The gap, the restore, the result, and a second run.
{
  const { base, source, bundle, sizes } = makeFixture();
  try {
    const gap = run(['--source', source, '--bundle', bundle, '--check']);
    check('--check exits 1 while dotfiles are missing', gap.status === 1, String(gap.status));
    check('--check says how many', /missing 8 entries/.test(gap.stdout), gap.stdout.trim());
    check('--check writes nothing', fs.existsSync(path.join(bundle, 'host/node_modules/.modules.yaml')) === false);

    const report = restore({ source, bundle });
    const wantBytes = sizes.manifest + sizes.modules + sizes.yarn + sizes.keep + sizes.profile;
    check('the restore copies every missing entry', report.copied === 8, String(report.copied));
    check('the reported bytes are the dotfiles on disk', report.bytes === wantBytes, report.bytes + ' vs ' + wantBytes);
    check('the hidden file is there with its content', fs.readFileSync(path.join(bundle, 'host/node_modules/pi-ai/dist/providers/data/.manifest.json'), 'utf8') === '{"models":[]}\n');
    check('the hidden directory chain is made', fs.existsSync(path.join(bundle, 'profile-trading/node_modules/.tool/x.txt')));
    const restored = fs.statSync(path.join(bundle, 'host/node_modules/plain/lib/.keep'));
    const original = fs.statSync(path.join(source, 'host/node_modules/plain/lib/.keep'));
    check('mode is kept', (restored.mode & 0o777) === 0o600, (restored.mode & 0o777).toString(8));
    check('mtime is kept', Math.abs(restored.mtimeMs - original.mtimeMs) < 1, String(restored.mtimeMs - original.mtimeMs));
    check('the file the bundle already had is untouched', (fs.statSync(path.join(bundle, 'host/node_modules/plain/lib/index.js')).mode & 0o777) === 0o755);

    const done = run(['--source', source, '--bundle', bundle, '--check']);
    check('--check exits 0 once the bundle matches', done.status === 0, done.stderr);
    const again = restore({ source, bundle });
    check('a second restore copies nothing', again.copied === 0 && again.missing === 0, String(again.copied));
  } finally {
    drop(base);
  }
}

// 5. A missing file that is not a dotfile is refused, and nothing is written.
{
  const { base, source, bundle } = makeFixture();
  try {
    file(source, 'host/node_modules/plain/lib/extra.js', 'exports.extra = 1\n');
    let message = '';
    try {
      restore({ source, bundle });
    } catch (error) {
      message = String(error.message);
    }
    check('a missing non-dotfile is refused', /not dotfiles/.test(message), message);
    check('a refused restore writes nothing', fs.existsSync(path.join(bundle, 'host/node_modules/.modules.yaml')) === false);
  } finally {
    drop(base);
  }
}

// 6. A bundle entry the payload does not hold is refused.
{
  const { base, source, bundle } = makeFixture();
  try {
    file(bundle, 'host/node_modules/plain/lib/stray.js', 'stray\n');
    let message = '';
    try {
      restore({ source, bundle });
    } catch (error) {
      message = String(error.message);
    }
    check('a stray bundle file is refused', /does not, so this is not a copy/.test(message), message);
  } finally {
    drop(base);
  }
}

// 7. A bundle file whose content differs from the payload is refused.
{
  const { base, source, bundle } = makeFixture();
  try {
    file(bundle, 'host/node_modules/plain/lib/index.js', 'different\n');
    let message = '';
    try {
      restore({ source, bundle });
    } catch (error) {
      message = String(error.message);
    }
    check('a differing copy is refused', /different content/.test(message), message);
  } finally {
    drop(base);
  }
}

// 8. The report the build reads: a numeric copied count and the entries.
{
  const { base, source, bundle } = makeFixture();
  try {
    const reportFile = path.join(base, 'report.json');
    const result = run(['--source', source, '--bundle', bundle, '--report', reportFile]);
    check('the restore exits 0', result.status === 0, result.stderr);
    const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
    check('the report counts what it copied', report.copied === 8, String(report.copied));
    check('the report lists the entries', Array.isArray(report.entries) && report.entries.length === 8);
    check('the report names the hidden file', report.entries.some((entry) => entry.path.endsWith('.manifest.json')));
  } finally {
    drop(base);
  }
}

// 9. Reached through a symlinked directory, as /tmp is on macOS.
{
  const { base, source, bundle } = makeFixture();
  try {
    const linked = path.join(base, 'linked-scripts');
    fs.symlinkSync(here, linked);
    const result = spawnSync(
      process.execPath,
      [path.join(linked, 'restore-mygo-dotfiles.mjs'), '--source', source, '--bundle', bundle, '--check'],
      { encoding: 'utf8' },
    );
    check('a script reached through a symlinked directory runs', result.status === 1 && /missing 8 entries/.test(result.stdout), result.stdout + result.stderr);
  } finally {
    drop(base);
  }
}

console.log('restore-mygo-dotfiles: ' + checks + ' checks ok');
