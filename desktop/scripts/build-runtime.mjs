#!/usr/bin/env node
'use strict';

/**
 * Build and stage the desktop runtime payload:
 *
 * 1. build every workspace package of this repository (the trading plugins
 *    are not published to npm, the installer carries them as packed tarballs);
 * 2. pack every workspace package into runtime/profile-trading/vendor/;
 * 3. generate the profile manifest (direct dependencies point at the local
 *    tarballs, overrides pin the whole @dshtrading/* closure to them) and
 *    pnpm-install it with a hoisted, multi-platform layout;
 * 4. pnpm-install the pinned @deepseek-ai/dsh host closure;
 * 5. stage both trees into desktop/resources/runtime/ for electron-builder's
 *    extraResources.
 *
 * The profile manifest and lockfile are generated, not committed: the tarball
 * payload changes with every workspace build, and reproducibility comes from
 * this repository's own versions.
 *
 * Usage: node scripts/build-runtime.mjs
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(desktopDir, '..');
const packagesDir = path.join(repoRoot, 'packages');
const runtimeSrc = path.join(desktopDir, 'runtime');
const stagingRoot = path.join(desktopDir, 'resources', 'runtime');

/** Direct profile dependencies mirroring the live trading-web profile. */
const DIRECT_TRADING_PACKAGES = [
  '@dshtrading/base',
  '@dshtrading/crypto',
  '@dshtrading/us',
  '@dshtrading/cn',
  '@dshtrading/hk',
  '@dshtrading/indicator-supertrend',
  '@dshtrading/dsh-i18n',
  '@dshtrading/client-ui-updater',
];
/** Registry package carried alongside the trading bundles. */
const REGISTRY_DEPENDENCIES = {
  '@deepseek-ai/dsh-web-search-exa': '0.1.2-rc.1',
};
/** Profile bundles: the official web surface plus the trading market bundles. */
const PROFILE_BUNDLES = [
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  '@dshtrading/base',
  '@dshtrading/crypto',
  '@dshtrading/us',
  '@dshtrading/cn',
  '@dshtrading/hk',
];

const HOST_PACKAGE = '@deepseek-ai/dsh';
/** Files copied from runtime/host into the staged payload. */
const HOST_FILES = ['package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml', 'node_modules'];

function readPackageManifest(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
}

// Windows resolves pnpm through a .cmd shim, which spawnSync cannot execute
// without a shell (ENOENT). shell:true is only needed there; args are all
// fixed constants or space-free absolute paths on CI, never user input.
const spawnOptions = { env: { ...process.env }, shell: process.platform === 'win32' };

function run(command, args, cwd) {
  // stdio is piped and relayed: inheriting a non-TTY stdout can stall pnpm's
  // progress renderer in background job contexts.
  const output = execFileSync(command, args, { cwd, ...spawnOptions, maxBuffer: 64 * 1024 * 1024 });
  const text = String(output);
  console.log(text.split('\n').slice(-4).join('\n'));
}

function buildWorkspace() {
  console.log('[build-runtime] pnpm -r build in repository root');
  run('pnpm', ['-r', 'build'], repoRoot);
}

function packWorkspacePackages(vendorDir) {
  fs.rmSync(vendorDir, { recursive: true, force: true });
  fs.mkdirSync(vendorDir, { recursive: true });
  const tarballs = new Map();
  for (const entry of fs.readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(packagesDir, entry.name);
    const manifest = readPackageManifest(dir);
    if (manifest.private === true || manifest.name === undefined) continue;
    console.log('[build-runtime] pnpm pack ' + manifest.name);
    const output = execFileSync('pnpm', ['pack', '--pack-destination', vendorDir], {
      cwd: dir,
      ...spawnOptions,
      maxBuffer: 16 * 1024 * 1024,
    });
    // pnpm pack prints the absolute tarball path; keep the basename only.
    const file = path.basename(String(output).trim().split('\n').pop());
    tarballs.set(manifest.name, file);
  }
  return tarballs;
}

function tarballSpec(file) {
  return 'file:./vendor/' + file;
}

function writeProfileManifest(profileDir, tarballs) {
  const dependencies = {};
  for (const name of DIRECT_TRADING_PACKAGES) {
    const file = tarballs.get(name);
    if (file === undefined) throw new Error('no packed tarball for direct dependency ' + name);
    dependencies[name] = tarballSpec(file);
  }
  Object.assign(dependencies, REGISTRY_DEPENDENCIES);

  const overrides = {};
  for (const [name, file] of tarballs) {
    overrides[name] = tarballSpec(file);
  }

  fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-trading-web',
    private: true,
    dependencies,
    dsh: { profile: { bundles: PROFILE_BUNDLES, patchReload: 'live' } },
  }, null, 2) + '\n');

  fs.writeFileSync(path.join(profileDir, 'pnpm-workspace.yaml'), [
    'packages:',
    '  - .',
    '',
    'nodeLinker: hoisted',
    'autoInstallPeers: false',
    'ignoreWorkspaceRootCheck: true',
    '',
    '# Real-file layout: the staged node_modules must survive being shipped',
    '# inside an installer and copied into $DSH_HOME, so pnpm symlinks are not',
    '# allowed. Optional native dependencies resolve for every shipped target.',
    'supportedArchitectures:',
    '  os:',
    '    - darwin',
    '    - win32',
    '  cpu:',
    '    - x64',
    '    - arm64',
    '',
    '# Every @dshtrading/* package resolves to the packed workspace tarball;',
    '# registry dependencies install from npm.',
    'overrides:',
    ...Object.entries(overrides).map(([name, spec]) => '  \'' + name + '\': \'' + spec + '\''),
    '',
  ].join('\n'));
}

function removeBinDirs(root) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const full = path.join(root, entry.name);
    if (entry.name === '.bin') fs.rmSync(full, { recursive: true, force: true });
    else removeBinDirs(full);
  }
}

function assertNoSymlinks(root) {
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) offenders.push(path.relative(root, full));
      else if (entry.isDirectory()) walk(full);
    }
  };
  walk(root);
  if (offenders.length > 0) {
    throw new Error('staged payload contains symlinks (would break inside installers): ' + offenders.slice(0, 5).join(', '));
  }
}

function pnpmInstall(dir) {
  console.log('[build-runtime] pnpm install in ' + path.relative(desktopDir, dir));
  run('pnpm', ['install'], dir);
}

function stage(sourceDir, destDir, names, nodeModules = true) {
  fs.rmSync(destDir, { recursive: true, force: true });
  fs.mkdirSync(destDir, { recursive: true });
  for (const name of names) {
    const source = path.join(sourceDir, name);
    if (!fs.existsSync(source)) throw new Error('expected ' + source + ' after install');
    fs.cpSync(source, path.join(destDir, name), { recursive: true, dereference: true });
  }
  if (nodeModules) {
    // node_modules/.bin holds pnpm's command shims (symlinks) at any depth;
    // nothing at runtime resolves through them, and symlinks must not enter
    // the installer.
    removeBinDirs(path.join(destDir, 'node_modules'));
    assertNoSymlinks(path.join(destDir, 'node_modules'));
  }
  console.log('[build-runtime] staged ' + path.basename(destDir) + ' -> ' + path.relative(desktopDir, destDir));
}

function assertRuntimeEntrypoints() {
  const hostBin = path.join(stagingRoot, 'host', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  if (!fs.existsSync(hostBin)) throw new Error('staged host is missing ' + path.relative(desktopDir, hostBin));
  for (const bundle of PROFILE_BUNDLES.filter((name) => name.startsWith('@dshtrading/'))) {
    const patch = path.join(stagingRoot, 'profile-trading', 'node_modules', ...bundle.split('/'), 'cordis.patch.yml');
    if (!fs.existsSync(patch)) throw new Error('staged profile is missing the ' + bundle + ' bundle patch');
  }
}

function main() {
  const hostVersion = readPackageManifest(path.join(runtimeSrc, 'host')).dependencies[HOST_PACKAGE];
  buildWorkspace();
  const vendorDir = path.join(runtimeSrc, 'profile-trading', 'vendor');
  const tarballs = packWorkspacePackages(vendorDir);
  writeProfileManifest(path.join(runtimeSrc, 'profile-trading'), tarballs);

  pnpmInstall(path.join(runtimeSrc, 'profile-trading'));
  pnpmInstall(path.join(runtimeSrc, 'host'));

  stage(path.join(runtimeSrc, 'profile-trading'), path.join(stagingRoot, 'profile-trading'), [
    'package.json', 'pnpm-workspace.yaml', 'cordis.patch.yml', 'node_modules',
  ]);
  stage(path.join(runtimeSrc, 'host'), path.join(stagingRoot, 'host'), HOST_FILES);
  assertRuntimeEntrypoints();

  const stamp = {
    node: 'see .node-version markers under node-<os>-<cpu>',
    host: HOST_PACKAGE + '@' + hostVersion,
    trading: DIRECT_TRADING_PACKAGES.join(', '),
    builtAt: new Date().toISOString(),
  };
  fs.mkdirSync(stagingRoot, { recursive: true });
  fs.writeFileSync(path.join(stagingRoot, 'VERSION.json'), JSON.stringify(stamp, null, 2) + '\n');
  console.log('[build-runtime] runtime payload ready: ' + stamp.host);
}

main();
