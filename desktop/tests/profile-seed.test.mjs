import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  PROFILE_SEED_FILES,
  PROFILE_SEED_BUILD_HOST_STATE,
  pruneProfileSeedBuildHostState,
  assertProfileSeedSelfContained,
  applyProfileSeed,
} = require('../src/runtime.cjs');

/**
 * The packaged profile seed is installed for real here: build-runtime.mjs ships
 * node_modules/vendor into a user's $DSH_HOME, and the plugin manager then runs
 * pnpm inside it. Issue #105 was exactly this tree failing on a Windows
 * machine — the seed carried the build machine's absolute pnpm state and never
 * shipped the vendor tarballs its manifest points at.
 */

/** Run pnpm for real, reporting status instead of throwing on failure. */
function pnpm(args, cwd) {
  try {
    const output = execFileSync('pnpm', args, {
      cwd,
      env: { ...process.env, CI: 'true' },
      encoding: 'utf8',
      // Windows resolves pnpm through a .cmd shim, which spawnSync cannot
      // execute without a shell (mirrors build-runtime.mjs).
      shell: process.platform === 'win32',
      maxBuffer: 32 * 1024 * 1024,
    });
    return { status: 0, output: String(output) };
  } catch (error) {
    return { status: error.status ?? 1, output: String(error.stdout ?? '') + String(error.stderr ?? '') };
  }
}

/** Pack a throwaway workspace package into a seed's vendor directory. */
function packVendored(workDir, seedDir, name) {
  const dir = path.join(workDir, name);
  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0', main: 'lib/index.js' }));
  fs.writeFileSync(path.join(dir, 'lib', 'index.js'), 'module.exports = ' + JSON.stringify(name) + ';\n');
  // A relative destination keeps the absolute temp path (which may contain
  // spaces) off the command line on Windows, where pnpm needs a shell.
  const printed = execFileSync('pnpm', ['pack', '--pack-destination', path.relative(dir, path.join(seedDir, 'vendor'))], {
    cwd: dir,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  return path.basename(String(printed).trim().split('\n').pop());
}

const ALPHA = 'fixture-alpha';
const BETA = 'fixture-beta';
let workDir;
let pristine;
let alphaTarball;
let betaTarball;

before(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-profile-seed-'));
  pristine = path.join(workDir, 'pristine');
  fs.mkdirSync(path.join(pristine, 'vendor'), { recursive: true });
  alphaTarball = packVendored(workDir, pristine, ALPHA);
  betaTarball = packVendored(workDir, pristine, BETA);

  // The generated manifest and workspace overrides mirror build-runtime.mjs:
  // every workspace package resolves to file:./vendor/<tarball>.
  fs.writeFileSync(path.join(pristine, 'package.json'), JSON.stringify({
    name: 'dsh-profile-trading-web',
    private: true,
    dependencies: { [ALPHA]: 'file:./vendor/' + alphaTarball },
    dsh: { profile: { bundles: [ALPHA], patchReload: 'live' } },
  }, null, 2) + '\n');
  fs.writeFileSync(path.join(pristine, 'pnpm-workspace.yaml'), [
    'packages:', '  - .', '',
    'nodeLinker: hoisted',
    'autoInstallPeers: false',
    'ignoreWorkspaceRootCheck: true', '',
    'overrides:',
    "  '" + ALPHA + "': 'file:./vendor/" + alphaTarball + "'", '',
  ].join('\n'));
  const installed = pnpm(['install'], pristine);
  assert.equal(installed.status, 0, 'the pristine seed installs: ' + installed.output);
});

after(() => {
  if (workDir !== undefined) fs.rmSync(workDir, { recursive: true, force: true });
});

/** Copy the installed seed so a case can mutate it without leaking state. */
function stagedCopy(name) {
  const dir = path.join(workDir, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.cpSync(pristine, dir, { recursive: true, dereference: true });
  // The seed records the project it installed; a copy has to name itself, or
  // pnpm reads the pristine project's state in place of its own.
  const stateFile = path.join(dir, 'node_modules', '.pnpm-workspace-state-v1.json');
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  state.projects = { [dir]: Object.values(state.projects)[0] };
  fs.writeFileSync(stateFile, JSON.stringify(state));
  return dir;
}

/**
 * An absolute path as a YAML double-quoted scalar. JSON's string escapes are a
 * subset of YAML's, so a Windows path's backslashes survive the round trip
 * instead of being read back as \U and rejected as an illegal escape.
 */
function yamlDoubleQuoted(value) {
  return JSON.stringify(value);
}

/** Rewrite the seed's pnpm state the way a build machine leaves it behind. */
function poisonBuildHostState(dir, buildMachineDir) {
  const modulesYaml = path.join(dir, 'node_modules', '.modules.yaml');
  fs.writeFileSync(modulesYaml, fs.readFileSync(modulesYaml, 'utf8')
    .replace(/"storeDir": "[^"]*"/, '"storeDir": ' + yamlDoubleQuoted(path.join(buildMachineDir, 'store', 'v11')))
    .replace(/"virtualStoreDir": "[^"]*"/, '"virtualStoreDir": ' + yamlDoubleQuoted(path.join(buildMachineDir, 'seeded', 'node_modules', '.pnpm'))));
  const stateFile = path.join(dir, 'node_modules', '.pnpm-workspace-state-v1.json');
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  // pnpm records the project path in its own spelling (separators differ on
  // Windows), so swap the whole single-project map instead of one key.
  assert.equal(Object.keys(state.projects).length, 1, 'the fixture seed records exactly one project');
  state.projects = { [path.join(buildMachineDir, 'seeded')]: Object.values(state.projects)[0] };
  fs.writeFileSync(stateFile, JSON.stringify(state));
}

/** Every file under dir whose contents contain the given absolute path. */
function filesMentioning(dir, needle) {
  const hits = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (fs.readFileSync(full).includes(needle)) hits.push(path.relative(dir, full));
    }
  };
  walk(dir);
  return hits;
}

test('operator ships the vendored tarballs in the packaged profile seed', () => {
  // Given the seed entries build-runtime.mjs stages into the installer
  // Then the tarballs the generated manifest points at travel with it
  assert.ok(PROFILE_SEED_FILES.includes('vendor'), 'vendor carries the packed workspace tarballs');
  assert.ok(PROFILE_SEED_FILES.includes('node_modules'), 'the seed ships preinstalled plugins');
  assert.deepEqual(
    [...PROFILE_SEED_FILES].sort(),
    ['cordis.patch.yml', 'node_modules', 'package.json', 'pnpm-workspace.yaml', 'vendor'],
  );
  // And the build machine's pnpm bookkeeping is the set the stager drops
  assert.deepEqual([...PROFILE_SEED_BUILD_HOST_STATE], [
    '.modules.yaml', '.pnpm-workspace-state-v1.json', '.package-map.json', '.pnpm',
  ]);
});

test('operator drops the build machine pnpm state from a staged seed', () => {
  // Given a staged seed carrying the pnpm state of the machine that built it
  const dir = stagedCopy('prune');
  for (const relative of PROFILE_SEED_BUILD_HOST_STATE) {
    assert.ok(fs.existsSync(path.join(dir, 'node_modules', relative)), relative + ' is present before pruning');
  }
  const installedPlugin = path.join(dir, 'node_modules', ALPHA, 'lib', 'index.js');

  // When the staged seed is pruned for shipping
  const removed = pruneProfileSeedBuildHostState(dir);

  // Then every build-host entry is gone and the installed plugins stay put
  assert.deepEqual(removed, [...PROFILE_SEED_BUILD_HOST_STATE]);
  for (const relative of PROFILE_SEED_BUILD_HOST_STATE) {
    assert.equal(fs.existsSync(path.join(dir, 'node_modules', relative)), false, relative + ' must not ship');
  }
  assert.equal(fs.readFileSync(installedPlugin, 'utf8'), 'module.exports = "fixture-alpha";\n');
});

test('operator still hits the build machine store after deleting only the store keys', () => {
  // Given a seed that records a build machine's absolute store and virtual store
  const dir = stagedCopy('poisoned');
  const buildMachine = path.join(workDir, 'build-machine');
  const modulesYaml = path.join(dir, 'node_modules', '.modules.yaml');
  const pristineState = fs.readFileSync(modulesYaml, 'utf8');
  poisonBuildHostState(dir, buildMachine);
  const poisoned = fs.readFileSync(modulesYaml, 'utf8');

  // When the plugin manager adds a package, Then pnpm refuses the build store
  const viaStore = pnpm(['add', 'file:./vendor/' + betaTarball], dir);
  assert.notEqual(viaStore.status, 0, 'a seeded profile must not silently reuse the build store');
  assert.match(viaStore.output, /ERR_PNPM_UNEXPECTED_STORE/);
  assert.ok(viaStore.output.includes(path.join(buildMachine, 'store', 'v11')), 'the build store path is what pnpm reports');

  // And When only the storeDir/virtualStoreDir keys are dropped, Then pnpm still
  // refuses: the leftover undefined store is the trap issue #105 hit.
  fs.writeFileSync(modulesYaml, poisoned.replace(/^\s*"storeDir".*$\n/m, '').replace(/^\s*"virtualStoreDir".*$\n/m, ''));
  const withoutKeys = pnpm(['add', 'file:./vendor/' + betaTarball], dir);
  assert.notEqual(withoutKeys.status, 0, 'deleting the keys is not a fix');
  assert.match(withoutKeys.output, /ERR_PNPM_UNEXPECTED_STORE/);
  assert.ok(withoutKeys.output.includes('linked from the store at "undefined"'), 'the leftover undefined store still trips the check');

  // And When the store matches this machine but the virtual store does not,
  // Then pnpm reports the virtual store instead
  fs.writeFileSync(modulesYaml, pristineState
    .replace(/"virtualStoreDir": "[^"]*"/, '"virtualStoreDir": ' + yamlDoubleQuoted(path.join(buildMachine, 'seeded', 'node_modules', '.pnpm'))));
  const viaVirtualStore = pnpm(['add', 'file:./vendor/' + betaTarball], dir);
  assert.notEqual(viaVirtualStore.status, 0);
  assert.match(viaVirtualStore.output, /ERR_PNPM_UNEXPECTED_VIRTUAL_STORE/);
});

test('operator installs plugins in a seeded profile without the build machine paths', () => {
  // Given the staged seed whose pnpm state was poisoned on the build machine
  const dir = stagedCopy('shipped');
  const buildMachine = path.join(workDir, 'build-machine');
  poisonBuildHostState(dir, buildMachine);
  pruneProfileSeedBuildHostState(dir);

  // When the plugin manager installs and then adds a plugin inside $DSH_HOME
  const installed = pnpm(['install'], dir);
  const added = pnpm(['add', 'file:./vendor/' + betaTarball], dir);

  // Then both succeed against the shipped tarballs...
  assert.equal(installed.status, 0, 'pnpm install must work in the shipped seed: ' + installed.output);
  assert.equal(added.status, 0, 'pnpm add must work in the shipped seed: ' + added.output);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(dir, 'node_modules', BETA, 'package.json'), 'utf8')).name,
    BETA,
  );
  assert.equal(fs.readFileSync(path.join(dir, 'node_modules', ALPHA, 'lib', 'index.js'), 'utf8'), 'module.exports = "fixture-alpha";\n');

  // And pnpm regenerates its own state, free of the build machine's paths
  const regenerated = fs.readFileSync(path.join(dir, 'node_modules', '.modules.yaml'), 'utf8');
  assert.ok(!regenerated.includes(buildMachine), 'the regenerated pnpm state names this machine, not the build machine');
  assert.equal(fs.readFileSync(path.join(dir, 'node_modules', '.pnpm-workspace-state-v1.json'), 'utf8').includes(buildMachine), false);
});

test('operator seeds a profile that carries no build machine paths', (t) => {
  // Given a staged seed that still holds the build machine's store, virtual
  // store and project path
  const dir = stagedCopy('seeded');
  const buildMachine = path.join(workDir, 'build-machine');
  poisonBuildHostState(dir, buildMachine);
  pruneProfileSeedBuildHostState(dir);
  const profile = path.join(workDir, 'home', 'profiles', 'trading-web');
  t.after(() => fs.rmSync(path.join(workDir, 'home'), { recursive: true, force: true }));

  // When the app seeds the user's profile from it
  applyProfileSeed(dir, profile, 'seed', 'stamp-1', { appVersion: '0.6.2' });

  // Then the seeded profile carries the plugins and the vendor tarballs...
  assert.ok(fs.existsSync(path.join(profile, 'vendor', alphaTarball)), 'the vendored tarball is seeded too');
  assert.ok(fs.existsSync(path.join(profile, 'node_modules', ALPHA, 'lib', 'index.js')));

  // And no build machine state or absolute build path survives the seed
  for (const relative of PROFILE_SEED_BUILD_HOST_STATE) {
    assert.equal(fs.existsSync(path.join(profile, 'node_modules', relative)), false, relative + ' must not reach $DSH_HOME');
  }
  assert.deepEqual(filesMentioning(profile, buildMachine), [], 'no seeded file names the build machine');
});

test('operator fails the build when the staged seed cannot install plugins on its own', () => {
  // Given a staged seed pruned for shipping
  const shipped = stagedCopy('shipped-check');
  pruneProfileSeedBuildHostState(shipped);

  // Then the build-time check passes and counts the vendored tarballs
  assert.equal(assertProfileSeedSelfContained(shipped), 1);

  // And Given the same seed missing the tarball its manifest points at
  const noVendor = stagedCopy('self-contained-no-vendor');
  pruneProfileSeedBuildHostState(noVendor);
  fs.rmSync(path.join(noVendor, 'vendor', alphaTarball));

  // Then the build fails instead of shipping an unusable seed
  assert.throws(() => assertProfileSeedSelfContained(noVendor), /missing vendor\//);

  // And Given a seed that still carries the build machine's pnpm state
  const leaked = stagedCopy('self-contained-leaked');

  // Then the build fails there too
  assert.throws(() => assertProfileSeedSelfContained(leaked), /build-host pnpm state/);
});

test('operator fails to add a plugin when the seed shipped without its vendor tarballs', () => {
  // Given a seed staged the pre-fix way: the manifest points at vendor tarballs
  // that never made it into the installer, and the plugin manager installs a
  // plugin from outside the profile
  const dir = stagedCopy('no-vendor');
  // A copy can never be linked from the pristine seed's own pnpm state, and pnpm
  // validates the recorded store before it resolves anything: an older pnpm that
  // records the virtual store as an absolute path dies there instead of on the
  // missing tarball this case is about.
  fs.rmSync(path.join(dir, 'node_modules', '.modules.yaml'));
  const outside = path.join(workDir, 'plugins');
  fs.mkdirSync(outside, { recursive: true });
  fs.copyFileSync(path.join(dir, 'vendor', betaTarball), path.join(outside, betaTarball));
  fs.rmSync(path.join(dir, 'vendor'), { recursive: true, force: true });
  assert.equal(fs.existsSync(path.join(dir, 'vendor')), false);

  // When the plugin manager adds that plugin, Then the resolving pass dies on
  // the vendored tarball the seed is missing
  const added = pnpm(['add', 'file:../plugins/' + betaTarball], dir);
  assert.notEqual(added.status, 0);
  assert.match(added.output, /ENOENT/);
  assert.ok(added.output.includes(alphaTarball), 'pnpm reports the vendored tarball the seed is missing');
});
