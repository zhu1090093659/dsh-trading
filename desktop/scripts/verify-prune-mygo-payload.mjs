#!/usr/bin/env node
'use strict';

/**
 * Verify the payload trim on a fixture payload, without building anything.
 *
 * prune-mygo-payload.mjs deletes directories, so its table and its reading of
 * the payload's os/cpu declarations are checked here against a synthetic
 * payload: per-platform packages from the real table, a plain package with a
 * source map and a declaration file, pnpm's node/ bindings that must stay out
 * of scope, and then the cases the build relies on:
 *
 *   1. darwin-arm64 removes exactly the foreign platform packages and *.map;
 *   2. the kept platform's packages, plain packages and node/ survive;
 *   3. darwin/universal keeps both darwin tags and still drops win32;
 *   4. a second run removes nothing: the trim is idempotent;
 *   5. an unknown target refuses to trim at all;
 *   6. a foreign package the table does not name stops the run ("unmapped");
 *   7. a table entry whose package.json pins another platform stops it ("table");
 *   8. a symlinked package (a pnpm store layout) stops it instead of leaking bytes;
 *   9. no rule selected removes nothing and leaves the mapping reported;
 *  10. the report's byte totals are the bytes that were on disk;
 *  11. the command line agrees: --dry-run exits 0, a bad target exits 1.
 *
 * Run it whenever the table, the rules or the payload layout change:
 *   node desktop/scripts/verify-prune-mygo-payload.mjs
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const modulePath = path.join(here, 'prune-mygo-payload.mjs');
const { PLATFORM_PACKAGES, PLATFORM_TAGS, RULES, keepTags, plan, prune } = await import(pathToFileURL(modulePath).href);

let checks = 0;

/** Assert one property of the trim and say so. */
function check(what, condition, detail) {
  checks += 1;
  assert.ok(condition, what + (detail === undefined ? '' : ' (' + detail + ')'));
  console.log('  ok  ' + what);
}

/** Write one fixture package; return the bytes it occupies. */
function packageFixture(root, tree, name, manifest, files = {}) {
  const dir = path.join(root, tree, 'node_modules', ...name.split('/'));
  fs.mkdirSync(dir, { recursive: true });
  const text = JSON.stringify({ name, version: '1.0.0', ...manifest }, null, 2);
  fs.writeFileSync(path.join(dir, 'package.json'), text);
  let bytes = Buffer.byteLength(text);
  for (const [relative, size] of Object.entries(files)) {
    const file = path.join(dir, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'x'.repeat(size));
    bytes += size;
  }
  return bytes;
}

/** One fixture payload: two pruned trees, node/ beside them, a VERSION.json. */
function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prune-mygo-payload-'));
  const bytes = {};
  const add = (tree, name, manifest, files) => {
    bytes[name] = (bytes[name] ?? 0) + packageFixture(root, tree, name, manifest, files);
  };
  const darwinArm64 = { os: ['darwin'], cpu: ['arm64'] };
  const darwinX64 = { os: ['darwin'], cpu: ['x64'] };
  const win32X64 = { os: ['win32'], cpu: ['x64'] };
  const win32Arm64 = { os: ['win32'], cpu: ['arm64'] };

  add('host', '@deepseek-ai/libreoffice-kit-darwin-arm64', darwinArm64, { 'lib/kit.node': 1000 });
  add('host', '@deepseek-ai/libreoffice-kit-darwin-x64', darwinX64, { 'lib/kit.node': 1000 });
  add('host', '@deepseek-ai/libreoffice-kit-win32-x64', win32X64, { 'lib/kit.dll': 1000 });
  add('host', '@deepseek-ai/libreoffice-kit-win32-arm64', win32Arm64, { 'lib/kit.dll': 1000 });
  add('host', '@img/sharp-darwin-arm64', darwinArm64, { 'lib/sharp.node': 1000 });
  add('host', '@img/sharp-win32-x64', win32X64, { 'lib/sharp.node': 1000 });
  add('host', 'sherpa-onnx-darwin-x64', darwinX64, { 'lib/sherpa.node': 1000 });
  add('host', 'node-addon-require-builtin-win32-x64-msvc', win32X64, { 'lib/addon.node': 1000 });
  add('host', 'plain-package', {}, { 'lib/index.js': 100, 'lib/index.js.map': 200, 'lib/index.d.ts': 50 });
  // Statically imported on every platform by dsh-subprocess-local, so it stays.
  add('host', '@deepseek-ai/dsh-win32-process', {}, { 'lib/index.js': 100 });
  add('profile-trading', '@trycua/cua-driver-darwin-arm64', darwinArm64, { 'lib/driver.node': 1000 });
  add('profile-trading', '@trycua/cua-driver-darwin-x64', darwinX64, { 'lib/driver.node': 1000 });
  packageFixture(root, 'node/lib/node_modules/pnpm/dist', '@reflink/reflink-win32-x64-msvc', win32X64, { 'lib/reflink.node': 100 });
  fs.writeFileSync(path.join(root, 'VERSION.json'), '{"node":"node@24","host":"dsh@0.2.1"}\n');
  return { root, bytes };
}

/** Remove a fixture tree; every case owns one. */
function dropFixture(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

/** The removed paths of a report, sorted. */
function removedPaths(report) {
  return report.removed.map((item) => item.path).sort();
}

console.log('prune-mygo-payload: fixture cases');

// 1-2. darwin-arm64: exactly the foreign platform packages and the source maps.
{
  const { root, bytes } = makeFixture();
  try {
    const report = plan({ root, platform: 'darwin-arm64' });
    check('the fixture plan raises no problem', report.problems.length === 0, JSON.stringify(report.problems));
    check('the target keeps one tag', report.keep.join(',') === 'darwin-arm64');
    const removed = removedPaths(report);
    const expected = [
      'host/node_modules/@deepseek-ai/libreoffice-kit-darwin-x64',
      'host/node_modules/@deepseek-ai/libreoffice-kit-win32-arm64',
      'host/node_modules/@deepseek-ai/libreoffice-kit-win32-x64',
      'host/node_modules/@img/sharp-win32-x64',
      'host/node_modules/node-addon-require-builtin-win32-x64-msvc',
      'host/node_modules/sherpa-onnx-darwin-x64',
      'host/node_modules/plain-package/lib/index.js.map',
      'profile-trading/node_modules/@trycua/cua-driver-darwin-x64',
    ].sort();
    check('the plan removes the foreign packages and the map', JSON.stringify(removed) === JSON.stringify(expected), JSON.stringify(removed));
    const wantBytes = bytes['@deepseek-ai/libreoffice-kit-darwin-x64'] + bytes['@deepseek-ai/libreoffice-kit-win32-x64']
      + bytes['@deepseek-ai/libreoffice-kit-win32-arm64'] + bytes['@img/sharp-win32-x64']
      + bytes['node-addon-require-builtin-win32-x64-msvc'] + bytes['sherpa-onnx-darwin-x64']
      + bytes['@trycua/cua-driver-darwin-x64'] + 200;
    check('the reported byte total is what is on disk', report.totals.bytes === wantBytes, report.totals.bytes + ' vs ' + wantBytes);
    check('the source maps are counted', report.sourceMaps.count === 1 && report.sourceMaps.bytes === 200);
    check('kept platform packages are sized', report.kept.filter((item) => item.platform !== null).every((item) => typeof item.bytes === 'number' && item.bytes > 0));
    check('packages the table does not map are not sized', report.kept.filter((item) => item.platform === null).every((item) => item.bytes === null));
    check('node/ bindings are out of scope', report.outOfScope.length === 1 && report.outOfScope[0].name === '@reflink/reflink-win32-x64-msvc');

    const maps = prune({ root, platform: 'darwin-arm64', rules: RULES });
    check('a real run applies the plan', maps.totals.entries === report.totals.entries);
    for (const relative of expected) check('removal of ' + relative, fs.existsSync(path.join(root, relative)) === false);
    for (const kept of [
      'host/node_modules/@deepseek-ai/libreoffice-kit-darwin-arm64',
      'host/node_modules/@img/sharp-darwin-arm64',
      'host/node_modules/@deepseek-ai/dsh-win32-process',
      'host/node_modules/plain-package/lib/index.d.ts',
      'host/node_modules/plain-package/lib/index.js',
      'profile-trading/node_modules/@trycua/cua-driver-darwin-arm64',
      'node/lib/node_modules/pnpm/dist/node_modules/@reflink/reflink-win32-x64-msvc',
      'VERSION.json',
    ]) check('kept ' + kept, fs.existsSync(path.join(root, kept)));

    // 4. idempotent: a second run has nothing left to remove.
    const again = plan({ root, platform: 'darwin-arm64' });
    check('a second plan removes nothing', again.totals.entries === 0, String(again.totals.entries));
  } finally {
    dropFixture(root);
  }
}

// 3. darwin/universal keeps both darwin tags.
{
  const { root } = makeFixture();
  try {
    const report = plan({ root, platform: 'darwin/universal' });
    check('universal keeps both darwin tags', report.keep.join(',') === 'darwin-arm64,darwin-x64');
    const removed = report.removed.filter((item) => item.rule === 'platform-packages').map((item) => item.name).sort();
    check('universal still removes win32', JSON.stringify(removed) === JSON.stringify([
      '@deepseek-ai/libreoffice-kit-win32-arm64',
      '@deepseek-ai/libreoffice-kit-win32-x64',
      '@img/sharp-win32-x64',
      'node-addon-require-builtin-win32-x64-msvc',
    ].sort()), JSON.stringify(removed));
  } finally {
    dropFixture(root);
  }
}

// 5. an unknown target refuses to trim.
{
  const { root } = makeFixture();
  try {
    let message = '';
    try {
      plan({ root, platform: 'linux-x64' });
    } catch (error) {
      message = String(error.message);
    }
    check('an unknown target refuses to trim', /no prune rule for platform "linux-x64"/.test(message), message);
  } finally {
    dropFixture(root);
  }
}

// 6. a foreign package the table does not name stops the run before any removal.
{
  const { root } = makeFixture();
  try {
    packageFixture(root, 'host', 'a-linux-only-addon', { os: ['linux'], cpu: ['x64'] }, { 'lib/x.node': 10 });
    const report = plan({ root, platform: 'darwin-arm64' });
    check('an unmapped foreign package is a problem', report.problems.some((problem) => problem.kind === 'unmapped'), JSON.stringify(report.problems));
    let threw = false;
    try {
      prune({ root, platform: 'darwin-arm64' });
    } catch {
      threw = true;
    }
    check('a run with an unmapped package fails closed', threw);
    check('a failed run removes nothing', fs.existsSync(path.join(root, 'host/node_modules/@deepseek-ai/libreoffice-kit-win32-x64')));
  } finally {
    dropFixture(root);
  }
}

// 7. a table entry whose declaration names another platform stops the run.
{
  const { root } = makeFixture();
  try {
    packageFixture(root, 'host', '@koromix/koffi-win32-x64', { os: ['darwin'], cpu: ['arm64'] }, { 'lib/koffi.node': 10 });
    const report = plan({ root, platform: 'darwin-arm64' });
    check('a table entry pinned elsewhere is a problem', report.problems.some((problem) => problem.kind === 'table'), JSON.stringify(report.problems));
  } finally {
    dropFixture(root);
  }
}

// 8. a symlinked package is a store layout, which this trim refuses.
{
  const { root } = makeFixture();
  try {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'prune-mygo-store-'));
    try {
      const target = path.join(outside, 'libreoffice-kit-win32-x64');
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(path.join(target, 'package.json'), JSON.stringify({ name: '@deepseek-ai/libreoffice-kit-win32-x64', os: ['win32'], cpu: ['x64'] }));
      fs.rmSync(path.join(root, 'host/node_modules/@deepseek-ai/libreoffice-kit-win32-x64'), { recursive: true, force: true });
      fs.symlinkSync(target, path.join(root, 'host/node_modules/@deepseek-ai/libreoffice-kit-win32-x64'));
      const report = plan({ root, platform: 'darwin-arm64' });
      check('a symlinked package is a problem', report.problems.some((problem) => problem.kind === 'symlink'), JSON.stringify(report.problems));
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  } finally {
    dropFixture(root);
  }
}

// 9. no rule selected: nothing removed, the mapping still reported.
{
  const { root } = makeFixture();
  try {
    const report = prune({ root, platform: 'darwin-arm64', rules: [] });
    check('keep-all removes nothing', report.totals.entries === 0);
    check('keep-all leaves the foreign packages in place', fs.existsSync(path.join(root, 'host/node_modules/@deepseek-ai/libreoffice-kit-win32-x64')));
    check('keep-all still maps the payload', report.kept.filter((item) => item.platform !== null).length === 10, String(report.kept.length));
  } finally {
    dropFixture(root);
  }
}

// 10. the table itself: exact names, known tags, one row per package.
{
  const names = Object.keys(PLATFORM_PACKAGES);
  check('the table names packages only', names.every((name) => /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name)), names.filter((name) => !/^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name)).join(','));
  check('the table holds no wildcard', names.every((name) => !/[*?[\]]/.test(name)));
  check('every table row names a known tag', names.every((name) => PLATFORM_TAGS.includes(PLATFORM_PACKAGES[name])));
  check('every tag keeps itself', PLATFORM_TAGS.every((tag) => keepTags(tag).join(',') === tag));
  check('the table covers all four tags', PLATFORM_TAGS.every((tag) => names.some((name) => PLATFORM_PACKAGES[name] === tag)));
  check('the win32-process package stays out of the table', PLATFORM_PACKAGES['@deepseek-ai/dsh-win32-process'] === undefined);
}

// 11. the command line: --dry-run succeeds, an unknown target fails.
{
  const { root } = makeFixture();
  try {
    const reportFile = path.join(root, 'prune-report.json');
    const dry = spawnSync(process.execPath, [modulePath, '--platform', 'darwin-arm64', '--root', root, '--dry-run', '--report', reportFile], { encoding: 'utf8' });
    check('--dry-run exits 0', dry.status === 0, dry.stderr);
    check('--dry-run says what it would remove', /platform packages: 39 mapped, 7 removed/.test(dry.stdout), dry.stdout);
    check('--dry-run announces it removed nothing', /dry run: nothing was removed/.test(dry.stdout));
    check('--dry-run writes the report', JSON.parse(fs.readFileSync(reportFile, 'utf8')).totals.entries === 8);
    check('--dry-run leaves the payload alone', fs.existsSync(path.join(root, 'host/node_modules/@deepseek-ai/libreoffice-kit-win32-x64')));
    // The macOS /tmp symlink shape: an entry point reached by an absolute path
    // inside a symlinked directory still has to run.
    const linked = path.join(root, 'linked-scripts');
    fs.symlinkSync(here, linked);
    const throughLink = spawnSync(process.execPath, [path.join(linked, 'prune-mygo-payload.mjs'), '--platform', 'darwin-arm64', '--root', root, '--dry-run'], { encoding: 'utf8' });
    check('a script reached through a symlinked directory runs', throughLink.status === 0 && /platform packages: 39 mapped/.test(throughLink.stdout), throughLink.stdout + throughLink.stderr);
    const bad = spawnSync(process.execPath, [modulePath, '--platform', 'linux-x64', '--root', root, '--dry-run'], { encoding: 'utf8' });
    check('an unknown target exits 1', bad.status === 1, String(bad.status));
    check('an unknown target says why', /no prune rule for platform "linux-x64"/.test(bad.stderr), bad.stderr);
  } finally {
    dropFixture(root);
  }
}

console.log('prune-mygo-payload: ' + checks + ' checks ok');
