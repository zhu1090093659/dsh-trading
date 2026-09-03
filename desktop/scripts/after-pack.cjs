'use strict';

/**
 * electron-builder afterPack hook: copy the staged runtime payload (bundled
 * Node distribution, dsh host closure, preinstalled profile) into the packed
 * app. extraResources is not used for these because electron-builder applies
 * gitignore filtering (node_modules would be silently dropped); this hook
 * copies the trees verbatim with symlinks dereferenced.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** electron-builder arch numbers to the fetch-node directory naming. */
const ARCH_NAMES = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64' };
const PLATFORM_NAMES = { mac: 'darwin', win: 'win32', linux: 'linux' };

exports.default = async function afterPack(context) {
  const platform = context.electronPlatformName;
  const archName = ARCH_NAMES[context.arch] ?? String(context.arch);
  const desktopDir = context.packager.projectDir;
  const runtimeSrc = path.join(desktopDir, 'resources', 'runtime');

  let resourcesDir;
  if (platform === 'darwin') {
    resourcesDir = path.join(context.appOutDir, context.packager.appInfo.productFilename + '.app', 'Contents', 'Resources');
  } else {
    resourcesDir = path.join(context.appOutDir, 'resources');
  }
  const destRoot = path.join(resourcesDir, 'runtime');

  const nodeDirName = 'node-' + (PLATFORM_NAMES[platform] ?? platform) + '-' + archName;
  const copies = [
    [path.join(runtimeSrc, 'host'), path.join(destRoot, 'host')],
    [path.join(runtimeSrc, 'profile-trading'), path.join(destRoot, 'profile-trading')],
    [path.join(runtimeSrc, nodeDirName), path.join(destRoot, 'node')],
    [path.join(runtimeSrc, 'VERSION.json'), path.join(destRoot, 'VERSION.json')],
  ];

  fs.rmSync(destRoot, { recursive: true, force: true });
  for (const [source, dest] of copies) {
    if (!fs.existsSync(source)) throw new Error('afterPack: staged runtime missing ' + source);
    if (fs.statSync(source).isFile()) {
      fs.copyFileSync(source, dest);
      console.log('  • afterPack copied ' + path.basename(source));
    } else {
      fs.cpSync(source, dest, { recursive: true, dereference: true });
      console.log('  • afterPack copied ' + path.basename(source) + ' (' + duKb(dest) + ' MB)');
    }
  }

  // Fail loudly if anything still smuggled pnpm-style symlinks into the
  // payload trees. The Node distribution itself is exempt: its bin/npm,
  // bin/npx and bin/corepack relative links are part of the official
  // archive layout and resolve inside the app on mac/linux; on Windows
  // the distribution ships real files.
  const offenders = [];
  const walk = (rootDir, dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) offenders.push(path.relative(rootDir, full));
      else if (entry.isDirectory()) walk(rootDir, full);
    }
  };
  for (const tree of ['host', 'profile-trading']) {
    walk(path.join(destRoot, tree), path.join(destRoot, tree));
  }
  if (offenders.length > 0) throw new Error('afterPack: packed runtime contains symlinks: ' + offenders.slice(0, 5).join(', '));
};

function duKb(dir) {
  let bytes = 0;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      else if (entry.isDirectory()) walk(full);
      else bytes += fs.statSync(full).size;
    }
  };
  try {
    walk(dir);
  } catch {
    return 0;
  }
  return Math.round(bytes / (1024 * 1024));
}

// os import kept for parity with runtime tooling expectations.
void os;
