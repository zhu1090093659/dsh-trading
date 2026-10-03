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
  resolvePrimaryRuntime,
  profileSeedFingerprint,
  runtimeSeedStamp,
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

test('bundled plugin updates reseed managed profiles without changing the host version', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-plugin-seed-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const seed = path.join(dir, 'seed');
  const profile = path.join(dir, 'profile');
  const plugin = path.join(seed, 'node_modules', '@linxin666', 'dsh-client-ui-plugin-manager');
  fs.mkdirSync(plugin, { recursive: true });
  fs.writeFileSync(path.join(seed, 'package.json'), '{"name":"dsh-profile-trading-web"}');
  fs.writeFileSync(path.join(seed, 'cordis.patch.yml'), '[]\n');
  fs.writeFileSync(path.join(plugin, 'package.json'), '{"version":"0.3.17"}');
  fs.writeFileSync(path.join(plugin, 'index.js'), 'old plugin');
  const runtime = { node: 'node@24', host: 'dsh@0.1.5-rc.1' };
  const initialHash = profileSeedFingerprint(seed);
  const initial = runtimeSeedStamp({ ...runtime, profileHash: initialHash });
  applyProfileSeed(seed, profile, 'seed', initial, {});
  fs.writeFileSync(path.join(profile, 'cordis.patch.yml'), '- id: user-setting\n');

  const copy = path.join(dir, 'copy');
  fs.cpSync(seed, copy, { recursive: true });
  fs.utimesSync(path.join(copy, 'package.json'), new Date(0), new Date(0));
  assert.equal(profileSeedFingerprint(copy), initialHash, 'copy location and timestamps do not affect identity');
  assert.equal(runtimeSeedStamp({ ...runtime, profileHash: initialHash, builtAt: 'later' }), initial);
  assert.equal(profileAction(profile, initial), 'leave');

  fs.writeFileSync(path.join(plugin, 'package.json'), '{"version":"0.3.20"}');
  fs.writeFileSync(path.join(plugin, 'index.js'), 'bundle children supported');
  const updated = runtimeSeedStamp({ ...runtime, profileHash: profileSeedFingerprint(seed) });
  assert.notEqual(updated, initial);
  assert.equal(profileAction(profile, updated), 'reseed');
  applyProfileSeed(seed, profile, 'reseed', updated, {});
  assert.equal(fs.readFileSync(path.join(profile, 'node_modules', '@linxin666', 'dsh-client-ui-plugin-manager', 'package.json'), 'utf8'), '{"version":"0.3.20"}');
  assert.equal(fs.readFileSync(path.join(profile, 'cordis.patch.yml'), 'utf8'), '- id: user-setting\n');
  assert.equal(profileAction(profile, updated), 'leave');

  fs.writeFileSync(path.join(plugin, 'index.js'), 'same-version rebuild');
  assert.notEqual(runtimeSeedStamp({ ...runtime, profileHash: profileSeedFingerprint(seed) }), updated);
  fs.rmSync(path.join(profile, SEED_MARKER));
  assert.equal(profileAction(profile, initial), 'leave', 'user-managed profiles remain untouched');
});

test('runtimeSeedStamp accepts legacy stamps and upgrades their managed profiles', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-legacy-seed-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(runtimeSeedStamp(undefined), 'unknown');
  assert.equal(runtimeSeedStamp({ node: 'n', host: 'h', webAll: 'legacy' }), 'n / h / legacy');
  const legacy = runtimeSeedStamp({ node: 'n', host: 'h', trading: 'base' });
  assert.equal(legacy, 'n / h / ');
  fs.writeFileSync(path.join(dir, 'package.json'), '{}');
  fs.writeFileSync(path.join(dir, SEED_MARKER), JSON.stringify({ stamp: legacy }));
  const current = runtimeSeedStamp({ node: 'n', host: 'h', profileHash: 'profile-content' });
  assert.equal(profileAction(dir, current), 'reseed');
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
  fs.writeFileSync(path.join(seed, 'node_modules', 'pkg', 'cordis.patch.yml'), '- insert: [{ id: bundled-v1 }]\n');

  applyProfileSeed(seed, profile, 'seed', 's1', { appVersion: '0.1.0' });
  assert.equal(fs.readFileSync(path.join(profile, 'node_modules', 'pkg', 'index.js'), 'utf8'), 'v1');

  // User edits the patch layer; the seed moves to a new node_modules payload.
  fs.writeFileSync(path.join(profile, 'cordis.patch.yml'), '- insert: []\n');
  fs.writeFileSync(path.join(seed, 'node_modules', 'pkg', 'index.js'), 'v2');
  fs.writeFileSync(path.join(seed, 'node_modules', 'pkg', 'cordis.patch.yml'), '- insert: [{ id: bundled-v2 }]\n');

  applyProfileSeed(seed, profile, 'reseed', 's2', { appVersion: '0.1.1' });
  assert.equal(fs.readFileSync(path.join(profile, 'node_modules', 'pkg', 'index.js'), 'utf8'), 'v2');
  assert.equal(fs.readFileSync(path.join(profile, 'cordis.patch.yml'), 'utf8'), '- insert: []\n', 'user patch survives');
  assert.equal(fs.readFileSync(path.join(profile, 'node_modules', 'pkg', 'cordis.patch.yml'), 'utf8'), '- insert: [{ id: bundled-v2 }]\n', 'bundled patches must be copied on reseed');
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

test('operator gets an absolute payload from the app resources when one is staged', (t) => {
  // Given a staged payload carrying runtime.json inside the app runtime resources
  const resources = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-primary-app-'));
  t.after(() => fs.rmSync(resources, { recursive: true, force: true }));
  const runtimeRoot = path.join(resources, 'runtime');
  const payload = path.join(runtimeRoot, 'primary-runtime');
  fs.mkdirSync(payload, { recursive: true });
  fs.writeFileSync(path.join(payload, 'runtime.json'), '{}');

  // When the primary runtime is resolved
  const resolved = resolvePrimaryRuntime(runtimeRoot, path.join(resources, 'home'));

  // Then the staged directory is returned.
  assert.equal(resolved, payload);
});

test('operator falls back to the trading home payload when the app stages none', (t) => {
  // Given no app payload but a home payload under dsh-runtimes/dsh-primary-runtime
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-primary-home-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const payload = path.join(home, 'dsh-runtimes', 'dsh-primary-runtime');
  fs.mkdirSync(payload, { recursive: true });
  fs.writeFileSync(path.join(payload, 'runtime.json'), '{}');

  // When the primary runtime is resolved
  const resolved = resolvePrimaryRuntime(path.join(root, 'runtime'), home);

  // Then the home payload is returned.
  assert.equal(resolved, payload);
});

test('operator keeps the capability absent when no payload carries runtime.json', (t) => {
  // Given an app directory and a home directory without a valid payload
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-primary-none-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const empty = path.join(root, 'runtime', 'primary-runtime');
  fs.mkdirSync(empty, { recursive: true });
  fs.writeFileSync(path.join(empty, 'not-runtime.json'), '{}');

  // When the primary runtime is resolved
  const resolved = resolvePrimaryRuntime(path.join(root, 'runtime'), home);

  // Then nothing is returned: the rows stay explicitly disabled and never fall back to a system Python.
  assert.equal(resolved, undefined);
});

test('operator never reaches across to the host ~/.dsh payload', (t) => {
  // Given a home whose sibling dsh home holds a payload (the host instance)
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-primary-cross-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home', '.dsh-trading');
  const hostPayload = path.join(root, 'home', '.dsh', 'dsh-runtimes', 'dsh-primary-runtime');
  fs.mkdirSync(hostPayload, { recursive: true });
  fs.writeFileSync(path.join(hostPayload, 'runtime.json'), '{}');

  // When the primary runtime is resolved for the trading home
  const resolved = resolvePrimaryRuntime(path.join(root, 'runtime'), home);

  // Then the cross-home payload is not used.
  assert.equal(resolved, undefined);
});
