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
 *    extraResources;
 * 6. write the dsh CLI shims back into the staged host tree (the plugin-manager
 *    gateway resolves the official CLI through node_modules/.bin, which step 5
 *    strips as pnpm symlinks).
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
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { hostCliShimPath, writeHostCliShims, profileSeedFingerprint } = require('../src/runtime.cjs');

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(desktopDir, '..');
const packagesDir = path.join(repoRoot, 'packages');
const runtimeSrc = path.join(desktopDir, 'runtime');
const stagingRoot = path.join(desktopDir, 'resources', 'runtime');

/** Direct profile dependencies mirroring the live trading-web profile. */
const DIRECT_TRADING_PACKAGES = [
  '@dshtrading/base',
  '@dshtrading/gui',
  // '@dshtrading/bot-api'、'@dshtrading/bot'、'@dshtrading/tradectl' 等由私有卫星仓
  // 提供（见 SATELLITE_OWNED_PACKAGES）：产物放进 satellite-vendor/ 才装配，缺席跳过。
  '@dshtrading/crypto',
  '@dshtrading/us',
  '@dshtrading/cn',
  '@dshtrading/hk',
  '@dshtrading/futures',
  '@dshtrading/global',
  '@dshtrading/indicator-supertrend',
  '@dshtrading/dsh-i18n',
  '@dshtrading/client-ui-updater',
  '@dshtrading/client-ui-special-indicators',
];
/**
 * Local-only private packages still carried in the desktop vendor closure:
 * private: true guards npm publication, not installer distribution (2026-09-17
 * special-indicators desktop wiring — the package ships as a packed tarball
 * like every other workspace plugin, credentials stay out of the repo).
 */
const PRIVATE_VENDOR_PACKAGES = new Set([
  '@dshtrading/client-ui-special-indicators',
]);
/**
 * 卫星仓拥有的包（自动交易平面）：源码在私有仓 dsh-trading-bot，不随主仓发布。
 * 主仓只在构建时装配它们提供的 vendor tarball——缺席即跳过，不视为错误。
 *
 * 部署接缝：把卫星仓 `pnpm pack` 出的 tgz 放进 desktop/satellite-vendor/ 即可被
 * 自动装上（也可用 DSH_SATELLITE_VENDOR 指向别处）。目录本身是 gitignore 的生成物，
 * 所以公开仓任何时候都不含自动交易源码。
 */
const SATELLITE_OWNED_PACKAGES = new Set([
  '@dshtrading/bot',
  '@dshtrading/bot-api',
  '@dshtrading/tradectl',
  '@dshtrading/cockpit',
  '@dshtrading/contract',
]);

/** 其中带 cordis.patch.yml 的才是 profile bundle；其余是纯库依赖。 */
const SATELLITE_BUNDLES = new Set([
  '@dshtrading/bot',
  '@dshtrading/bot-api',
]);

/** 卫星产物投放槽位。 */
function satelliteVendorDir() {
  return process.env.DSH_SATELLITE_VENDOR ?? path.join(desktopDir, 'satellite-vendor');
}

/**
 * 把卫星槽位里现成的 tgz 收进 vendor 目录，并登记到 tarballs。
 * 只收本仓没有的包（卫星包），不覆盖主仓自己打包的产物。
 */
function adoptSatelliteTarballs(vendorDir, tarballs) {
  const src = satelliteVendorDir();
  if (!fs.existsSync(src)) return;
  const files = fs.readdirSync(src).filter((f) => f.endsWith('.tgz') || f.endsWith('.tar.gz'));
  // 降序匹配：`dshtrading-bot-api-*.tgz` 也以 `dshtrading-bot-` 开头，按短名先匹会认错包
  const byLength = [...SATELLITE_OWNED_PACKAGES].sort((a, b) => b.length - a.length);
  for (const file of files) {
    // 文件名形如 dshtrading-bot-api-0.5.0.tgz：反查它属于哪个卫星包
    const name = byLength.find((pkg) =>
      file.startsWith('dshtrading-' + pkg.split('/')[1] + '-'));
    if (name === undefined) continue;
    if (tarballs.has(name)) continue;
    fs.copyFileSync(path.join(src, file), path.join(vendorDir, file));
    tarballs.set(name, file);
    console.log('[build-runtime] adopt satellite ' + name + ' <- ' + file);
  }
}

/** Registry package carried alongside the trading bundles. */
const REGISTRY_DEPENDENCIES = {
  '@deepseek-ai/dsh-web-search-exa': '0.2.0-rc.2',
};
/** Profile bundles: the official web surface plus the trading market bundles. */
const PROFILE_BUNDLES = [
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  '@dshtrading/base',
  '@dshtrading/gui',
  // '@dshtrading/bot-api' 由私有卫星仓提供（见 SATELLITE_OWNED_PACKAGES）：
  // 装配时若 vendor/ 里带上了它，下面的 filter 会自动把它接回 bundles 列表。
  '@dshtrading/crypto',
  '@dshtrading/us',
  '@dshtrading/cn',
  '@dshtrading/hk',
  '@dshtrading/futures',
  '@dshtrading/global',
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
    if (manifest.name === undefined) continue;
    if (manifest.private === true && !PRIVATE_VENDOR_PACKAGES.has(manifest.name)) continue;
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
    if (file === undefined) {
      // 自动交易实现已迁往私有卫星仓（dsh-trading-bot）。主仓只保留部署接缝：
      // 卫星仓把它的 tgz 放进 vendor/ 时这里照常装配；缺席即跳过，主仓仍可独立构建。
      if (SATELLITE_OWNED_PACKAGES.has(name)) continue;
      throw new Error('no packed tarball for direct dependency ' + name);
    }
    dependencies[name] = tarballSpec(file);
  }
  // 卫星仓的产物一旦被采纳，就直接进 dependencies（它们不在 DIRECT_TRADING_PACKAGES 里）。
  for (const name of SATELLITE_OWNED_PACKAGES) {
    const file = tarballs.get(name);
    if (file !== undefined && dependencies[name] === undefined) dependencies[name] = tarballSpec(file);
  }
  Object.assign(dependencies, REGISTRY_DEPENDENCIES);

  // 卫星仓拥有的 bundle 只有真装配上了才进 bundles 列表：否则 profile 启动会
  // 因解析不到该 bundle 而失败（issue #60 同款 ERR_MODULE_NOT_FOUND 语义）。
  const bundles = PROFILE_BUNDLES
    .concat([...SATELLITE_BUNDLES].filter((name) => dependencies[name] !== undefined));

  const overrides = {};
  for (const [name, file] of tarballs) {
    overrides[name] = tarballSpec(file);
  }

  fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-trading-web',
    private: true,
    dependencies,
    dsh: { profile: { bundles, patchReload: 'live' } },
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
  for (const platform of ['darwin', 'win32']) {
    const shim = hostCliShimPath(path.join(stagingRoot, 'host'), platform);
    if (!fs.existsSync(shim)) throw new Error('staged host is missing the CLI shim ' + path.relative(desktopDir, shim));
  }
  for (const bundle of PROFILE_BUNDLES.filter((name) => name.startsWith('@dshtrading/'))) {
    const patch = path.join(stagingRoot, 'profile-trading', 'node_modules', ...bundle.split('/'), 'cordis.patch.yml');
    if (!fs.existsSync(patch)) throw new Error('staged profile is missing the ' + bundle + ' bundle patch');
  }
}

/**
 * Report the pnpm version staged into the current platform's node
 * distribution by stage-pnpm.mjs; informational only (best effort, undefined
 * when the toolchain was not staged in a development checkout).
 */
function readBundledPnpmVersion() {
  const candidates = process.platform === 'win32'
    ? [path.join(stagingRoot, 'node-win32-x64', 'node_modules', 'pnpm')]
    : [
        path.join(stagingRoot, 'node-darwin-arm64', 'lib', 'node_modules', 'pnpm'),
        path.join(stagingRoot, 'node-darwin-x64', 'lib', 'node_modules', 'pnpm'),
      ];
  const dir = candidates.find((candidate) => fs.existsSync(path.join(candidate, 'package.json')));
  if (dir === undefined) return undefined;
  try {
    return 'pnpm@' + JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version;
  } catch {
    return undefined;
  }
}

/**
 * The dsh release family inside the host closure must resolve to a single
 * generation. Refreshing the lockfile in place can silently preserve stale
 * entries: official packages declare wide peer ranges, so an older version
 * that still satisfies the range survives the re-resolution (2026-09-09:
 * 25 packages straggled at 0.1.2-alpha.4/rc.1 beside a 0.1.5-alpha.2 host;
 * every app boot died on ESM export mismatches at plugin load). Census the
 * materialized tree and fail the build on any dsh-* package off the pinned
 * host version.
 */
function assertHostCohort(hostVersion) {
  const scopeDir = path.join(runtimeSrc, 'host', 'node_modules', '@deepseek-ai');
  const offenders = [];
  for (const entry of fs.readdirSync(scopeDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('dsh-')) continue;
    const version = readPackageManifest(path.join(scopeDir, entry.name)).version;
    if (version !== hostVersion) offenders.push(entry.name + '@' + version);
  }
  if (offenders.length > 0) {
    throw new Error(
      'host closure is not single-cohort (expected ' + HOST_PACKAGE + '@' + hostVersion
      + '); delete runtime/host/node_modules + pnpm-lock.yaml and reinstall: '
      + offenders.join(', '));
  }
  console.log('[build-runtime] host cohort census: every dsh-* package is ' + HOST_PACKAGE + '@' + hostVersion);
}

function main() {
  const hostVersion = readPackageManifest(path.join(runtimeSrc, 'host')).dependencies[HOST_PACKAGE];
  buildWorkspace();
  const vendorDir = path.join(runtimeSrc, 'profile-trading', 'vendor');
  const tarballs = packWorkspacePackages(vendorDir);
  adoptSatelliteTarballs(vendorDir, tarballs);
  const profileDir = path.join(runtimeSrc, 'profile-trading');
  writeProfileManifest(profileDir, tarballs);

  // 生成的 pnpm-lock.yaml 会把上一次打包的 tarball 完整性钉住：同一版本号重打包时
  // pnpm install 直接从 store 复用旧内容，新文件静默缺失（2026-09-12 实证：
  // connector-hithink 新增 futures 入口未进载荷）。两者都是 gitignore 的生成物，
  // install 前清掉，保证按当前 tarball 重新解析；host 的 lockfile 是 tracked 输入，
  // 不在此列（其 install 语义不变）。
  fs.rmSync(path.join(profileDir, 'pnpm-lock.yaml'), { force: true });
  fs.rmSync(path.join(profileDir, 'node_modules'), { recursive: true, force: true });

  pnpmInstall(profileDir);
  pnpmInstall(path.join(runtimeSrc, 'host'));
  assertHostCohort(hostVersion);

  stage(path.join(runtimeSrc, 'profile-trading'), path.join(stagingRoot, 'profile-trading'), [
    'package.json', 'pnpm-workspace.yaml', 'cordis.patch.yml', 'node_modules',
  ]);
  stage(path.join(runtimeSrc, 'host'), path.join(stagingRoot, 'host'), HOST_FILES);
  writeHostCliShims(path.join(stagingRoot, 'host'), { log: console.log });
  assertRuntimeEntrypoints();

  const stamp = {
    node: 'see .node-version markers under node-<os>-<cpu>',
    pnpm: readBundledPnpmVersion(),
    host: HOST_PACKAGE + '@' + hostVersion,
    trading: DIRECT_TRADING_PACKAGES.join(', '),
    profileHash: profileSeedFingerprint(path.join(stagingRoot, 'profile-trading')),
    builtAt: new Date().toISOString(),
  };
  fs.mkdirSync(stagingRoot, { recursive: true });
  fs.writeFileSync(path.join(stagingRoot, 'VERSION.json'), JSON.stringify(stamp, null, 2) + '\n');
  console.log('[build-runtime] runtime payload ready: ' + stamp.host);
}

main();
