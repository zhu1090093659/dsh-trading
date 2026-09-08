import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  resolveRuntimePaths,
  hostCliShimPath,
  writeHostCliShims,
  resolveDshHome,
  profileAction,
  applyProfileSeed,
  parseShasums,
  parseTokenUrlLine,
  formatHostExitDiagnostic,
  toNodeImportSpecifier,
  normalizeProfileCohort,
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

test('resolveDshHome: explicit env wins, default is the trading home', () => {
  assert.equal(resolveDshHome({}, '/home/u'), path.join('/home/u', '.dsh-trading'));
  assert.equal(resolveDshHome({ DSH_HOME: '' }, '/home/u'), path.join('/home/u', '.dsh-trading'));
  assert.equal(resolveDshHome({ DSH_HOME: '~/custom' }, '/home/u'), path.join('/home/u', 'custom'));
  assert.equal(resolveDshHome({ DSH_HOME: '/data/dsh' }, '/home/u'), path.resolve('/data/dsh'));
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

test('normalizeProfileCohort relinks core packages onto the bundled runtime', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cohort-'));
  const bundled = path.join(dir, 'runtime', 'node_modules');
  const foreign = path.join(dir, 'foreign');
  const profile = path.join(dir, 'profiles', 'trading-web');
  const core = path.join(profile, 'node_modules', '@deepseek-ai');
  const writePackage = (pkgDir) => {
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, 'package.json'), '{}');
  };
  for (const name of ['dsh-scope', 'dsh-tools', 'dsh-agent-presets']) writePackage(path.join(bundled, '@deepseek-ai', name));
  writePackage(path.join(foreign, 'dsh-scope'));
  fs.mkdirSync(core, { recursive: true });
  // already single-instance: must stay untouched
  fs.symlinkSync(path.join(bundled, '@deepseek-ai', 'dsh-scope'), path.join(core, 'dsh-scope'), 'dir');
  // a foreign install's link and a materialized copy: both must be relinked
  fs.symlinkSync(path.join(foreign, 'dsh-scope'), path.join(core, 'dsh-tools'), 'dir');
  writePackage(path.join(core, 'dsh-agent-presets'));
  // a package the bundled runtime does not ship: must survive
  writePackage(path.join(core, 'dsh-future'));
  // nested shadow copy under a real package tree: must be relinked too
  writePackage(path.join(profile, 'node_modules', '@dshtrading', 'knowledge', 'node_modules', '@deepseek-ai', 'dsh-tools'));
  // a symlinked package tree belongs to another install: must be left alone
  const linkedTree = path.join(dir, 'linked-package');
  writePackage(path.join(linkedTree, 'node_modules', '@deepseek-ai', 'dsh-tools'));
  fs.symlinkSync(linkedTree, path.join(profile, 'node_modules', '@dshtrading', 'linked'), 'dir');

  const result = normalizeProfileCohort(profile, bundled);
  assert.equal(result.failed.length, 0);
  assert.equal(result.relinked.length, 3);
  const bundledReal = (name) => fs.realpathSync(path.join(bundled, '@deepseek-ai', name));
  assert.equal(fs.realpathSync(path.join(core, 'dsh-tools')), bundledReal('dsh-tools'));
  assert.equal(fs.realpathSync(path.join(core, 'dsh-agent-presets')), bundledReal('dsh-agent-presets'));
  assert.equal(fs.realpathSync(path.join(core, 'dsh-scope')), bundledReal('dsh-scope'));
  assert.ok(fs.existsSync(path.join(core, 'dsh-future', 'package.json')), 'unknown package survives');
  assert.equal(
    fs.realpathSync(path.join(profile, 'node_modules', '@dshtrading', 'knowledge', 'node_modules', '@deepseek-ai', 'dsh-tools')),
    bundledReal('dsh-tools'),
    'nested shadow copy is relinked',
  );
  const linkedShadow = path.join(linkedTree, 'node_modules', '@deepseek-ai', 'dsh-tools');
  assert.ok(fs.lstatSync(linkedShadow).isDirectory() && !fs.lstatSync(linkedShadow).isSymbolicLink(), 'a symlinked package tree is never rewritten');
  assert.deepEqual(normalizeProfileCohort(profile, bundled).relinked, [], 'second pass is a no-op');
  fs.rmSync(dir, { recursive: true, force: true });
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

test('formatHostExitDiagnostic detects missing VC++ redistributable on Windows', () => {
  const winUnsigned = formatHostExitDiagnostic(3221225781, null, 'win32');
  assert.equal(winUnsigned.isMissingVCRedist, true);
  assert.ok(winUnsigned.message.includes('0xC0000135'));
  assert.ok(winUnsigned.message.includes('Visual C++'));

  const winSigned = formatHostExitDiagnostic(-1073741515, null, 'win32');
  assert.equal(winSigned.isMissingVCRedist, true);

  const macExit = formatHostExitDiagnostic(3221225781, null, 'darwin');
  assert.equal(macExit.isMissingVCRedist, false);

  const normalExit = formatHostExitDiagnostic(1, null, 'win32');
  assert.equal(normalExit.isMissingVCRedist, false);
  assert.ok(normalExit.message.includes('退出码: 1'));

  const signalExit = formatHostExitDiagnostic(null, 'SIGTERM', 'darwin');
  assert.equal(signalExit.isMissingVCRedist, false);
  assert.ok(signalExit.message.includes('SIGTERM'));
});

test('writeHostCliShims drops a runnable dsh shim into the staged host', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cli-shim-'));
  const host = path.join(dir, 'runtime', 'host');
  const entry = path.join(host, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.writeFileSync(entry, "process.stdout.write(JSON.stringify(process.argv.slice(2)) + '\\n');\n");
  const nodeBin = path.join(dir, 'runtime', 'node', 'bin');
  fs.mkdirSync(nodeBin, { recursive: true });
  fs.symlinkSync(process.execPath, path.join(nodeBin, 'node'));

  const written = writeHostCliShims(host);
  assert.equal(written.posix, hostCliShimPath(host, 'darwin'));
  assert.equal(written.windows, hostCliShimPath(host, 'win32'));
  assert.ok(written.posix.endsWith(path.join('.bin', 'dsh')), 'gateway probes .bin/dsh');
  assert.ok(written.windows.endsWith(path.join('.bin', 'dsh.cmd')), 'gateway probes .bin/dsh.cmd on Windows');
  assert.ok(fs.existsSync(written.posix) && fs.existsSync(written.windows));
  assert.ok(fs.readFileSync(written.posix, 'utf8').includes('@deepseek-ai/dsh/lib/bin.js'));
  assert.ok(fs.readFileSync(written.windows, 'utf8').includes('@deepseek-ai\\dsh\\lib\\bin.js'));

  if (process.platform !== 'win32') {
    assert.ok((fs.statSync(written.posix).mode & 0o111) !== 0, 'the POSIX shim is executable');
    const out = execFileSync(written.posix, ['plugin', '--profile', 'trading-web', 'list'], { encoding: 'utf8' });
    assert.deepEqual(JSON.parse(out), ['plugin', '--profile', 'trading-web', 'list']);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('toNodeImportSpecifier converts paths to valid file URLs safe for --import', () => {
  assert.equal(toNodeImportSpecifier(undefined), undefined);

  const localFile = path.resolve('src', 'host-symbol-normalizer.mjs');
  const specifier = toNodeImportSpecifier(localFile);
  assert.ok(specifier.startsWith('file://'));
  assert.ok(specifier.includes('host-symbol-normalizer.mjs'));

  if (process.platform === 'win32') {
    const winSpec = toNodeImportSpecifier('C:\\Program Files\\App\\loader.mjs');
    assert.equal(winSpec, 'file:///C:/Program%20Files/App/loader.mjs');
  } else {
    const posixSpec = toNodeImportSpecifier('/Applications/App/loader.mjs');
    assert.equal(posixSpec, 'file:///Applications/App/loader.mjs');
  }
});

