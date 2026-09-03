import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  resolveRuntimePaths,
  resolveDshHome,
  profileAction,
  applyProfileSeed,
  parseShasums,
  parseTokenUrlLine,
  SEED_MARKER,
} = require('../src/runtime.cjs');

test('resolveRuntimePaths picks the platform node binary', () => {
  const mac = resolveRuntimePaths('/res', 'darwin', 'arm64');
  assert.equal(mac.nodeBin, path.join('/res', 'runtime', 'node', 'bin', 'node'));
  const win = resolveRuntimePaths('C:\\res', 'win32', 'x64');
  assert.equal(win.nodeBin, path.join('C:\\res', 'runtime', 'node', 'node.exe'));
  assert.ok(mac.hostBin.endsWith(path.join('@deepseek-ai', 'dsh', 'lib', 'bin.js')));
});

test('resolveRuntimePaths keeps the per-platform dir unpackaged', () => {
  const dev = resolveRuntimePaths('/res', 'darwin', 'arm64', false);
  assert.equal(dev.nodeBin, path.join('/res', 'runtime', 'node-darwin-arm64', 'bin', 'node'));
  const devWin = resolveRuntimePaths('/res', 'win32', 'x64', false);
  assert.equal(devWin.nodeBin, path.join('/res', 'runtime', 'node-win32-x64', 'node.exe'));
});

test('resolveDshHome follows the host lookup order', () => {
  assert.equal(resolveDshHome({}, '/home/u'), path.join('/home/u', '.dsh'));
  assert.equal(resolveDshHome({ DSH_HOME: '' }, '/home/u'), path.join('/home/u', '.dsh'));
  assert.equal(resolveDshHome({ DSH_HOME: '~/custom' }, '/home/u'), path.join('/home/u', 'custom'));
  assert.equal(resolveDshHome({ DSH_HOME: '/data/dsh' }, '/home/u'), '/data/dsh');
});

test('profileAction seeds missing, leaves user-managed, reseeds stale', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-profile-action-'));
  const profile = path.join(dir, 'web');
  assert.equal(profileAction(profile, 's1'), 'seed');

  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(path.join(profile, 'package.json'), '{}');
  assert.equal(profileAction(profile, 's1'), 'leave', 'no marker means user-managed');

  fs.writeFileSync(path.join(profile, SEED_MARKER), JSON.stringify({ stamp: 's1' }));
  assert.equal(profileAction(profile, 's1'), 'leave', 'current stamp is up to date');
  assert.equal(profileAction(profile, 's2'), 'reseed', 'moved stamp triggers reseed');
});

test('applyProfileSeed keeps the user patch layer on reseed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-seed-'));
  const seed = path.join(dir, 'seed');
  const profile = path.join(dir, 'web');
  fs.mkdirSync(path.join(seed, 'node_modules', 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(seed, 'package.json'), '{"name":"dsh-profile-web"}');
  fs.writeFileSync(path.join(seed, 'cordis.patch.yml'), '[]\n');
  fs.writeFileSync(path.join(seed, 'node_modules', 'pkg', 'index.js'), 'v1');

  applyProfileSeed(seed, profile, 'seed', 's1', { appVersion: '0.1.0' });
  assert.equal(fs.readFileSync(path.join(profile, 'node_modules', 'pkg', 'index.js'), 'utf8'), 'v1');

  // User edits the patch layer; the seed moves to a new node_modules payload.
  fs.writeFileSync(path.join(profile, 'cordis.patch.yml'), '- insert: []\n');
  fs.writeFileSync(path.join(seed, 'node_modules', 'pkg', 'index.js'), 'v2');

  applyProfileSeed(seed, profile, 'reseed', 's2', { appVersion: '0.1.1' });
  assert.equal(fs.readFileSync(path.join(profile, 'node_modules', 'pkg', 'index.js'), 'utf8'), 'v2');
  assert.equal(fs.readFileSync(path.join(profile, 'cordis.patch.yml'), 'utf8'), '- insert: []\n', 'user patch survives');
  assert.equal(JSON.parse(fs.readFileSync(path.join(profile, SEED_MARKER), 'utf8')).stamp, 's2');
});

test('parseShasums parses SHASUMS256.txt lines', () => {
  const text = 'a'.repeat(64) + '  node-v24.20.0-darwin-arm64.tar.gz\n' + 'b'.repeat(64) + '  node-v24.20.0-win-x64.zip\n';
  const map = parseShasums(text);
  assert.equal(map.get('node-v24.20.0-darwin-arm64.tar.gz'), 'a'.repeat(64));
  assert.equal(map.get('node-v24.20.0-win-x64.zip'), 'b'.repeat(64));
  assert.equal(map.size, 2);
});

test('parseTokenUrlLine extracts the host token URL', () => {
  assert.equal(
    parseTokenUrlLine('dsh web: http://127.0.0.1:34981/?token=abc-DEF_123'),
    'http://127.0.0.1:34981/?token=abc-DEF_123');
  assert.equal(parseTokenUrlLine('[desktop] boot failed'), undefined);
});
