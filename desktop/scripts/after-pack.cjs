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
    } else if (path.basename(source).startsWith('node-')) {
      // The Node distribution keeps official RELATIVE bin symlinks; cpSync
      // would rewrite them to absolute build-machine paths (dangling inside
      // the app), so copy the tree verbatim instead.
      copyTreePreservingSymlinks(source, dest);
      console.log('  • afterPack copied ' + path.basename(source) + ' (' + duKb(dest) + ' MB)');
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
  // The node dir is allowed to carry symlinks, but only RELATIVE ones that
  // resolve inside the packed app (the official dist layout).
  const nodeDir = path.join(destRoot, 'node');
  if (fs.existsSync(nodeDir)) {
    const walkLinks = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isSymbolicLink()) {
          const target = fs.readlinkSync(full);
          if (path.isAbsolute(target) || !fs.existsSync(path.resolve(path.dirname(full), target))) {
            offenders.push(path.relative(destRoot, full) + ' -> ' + target);
          }
        } else if (entry.isDirectory()) walkLinks(full);
      }
    };
    walkLinks(nodeDir);
  }
  if (offenders.length > 0) throw new Error('afterPack: packed runtime has broken/absolute symlinks: ' + offenders.slice(0, 5).join(', '));
};

function copyTreePreservingSymlinks(src, dest) {
  const stat = fs.lstatSync(src);
  if (stat.isSymbolicLink()) {
    fs.symlinkSync(fs.readlinkSync(src), dest);
    return;
  }
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) copyTreePreservingSymlinks(path.join(src, entry), path.join(dest, entry));
    return;
  }
  fs.copyFileSync(src, dest);
}

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
