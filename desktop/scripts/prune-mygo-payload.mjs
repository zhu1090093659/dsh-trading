#!/usr/bin/env node
'use strict';

/**
 * Trim a staged mygo payload to the one platform the build ships.
 *
 * The desktop payload is installed for every target the desktop release covers:
 * desktop/runtime/host/pnpm-workspace.yaml pins supportedArchitectures
 * darwin + win32 on x64 + arm64, because the Electron payload serves both a
 * mac (arm64 and x64) and a win32 app. A mygo build ships exactly one platform,
 * so the per-platform packages of the other three are dead weight — measured on
 * the 2026-10-21 payload, 823 MB of the 1824 MB the runtime payload holds.
 *
 * This script only ever trims a payload being staged, never a source payload:
 * the caller copies first (stage-mygo-payload.mjs, build-mygo-mac.sh) and calls
 * this with the copy's root. The source keeps every platform, so a win32 build
 * stages it again and trims the other way.
 *
 * What is removed, and nothing else:
 *
 *   - packages named in PLATFORM_PACKAGES whose platform tag the target does
 *     not keep. Every entry is an exact package name — a wildcard (\*win32\*)
 *     is never matched, so a package that merely mentions a platform in its
 *     name is never a candidate;
 *   - *.map source maps, when the source-maps rule is on: node reads a map only
 *     under --enable-source-maps, and nothing in the launch path
 *     (desktop/mygo/internal/launch/hostcmd.go) sets it.
 *
 * The payload's own os/cpu declarations, not this table, are the authority:
 * every package in scope is read and its declaration checked against the table.
 * A package that declares itself foreign to the target but has no table entry
 * fails the run ("unmapped platform package"), and so does a table entry whose
 * declaration names another platform. A payload change therefore cannot make
 * this trim silently wrong: it makes the build stop until the table is updated.
 *
 * Deliberately not in the table, with the evidence:
 *
 *   - @deepseek-ai/dsh-win32-process (0.1 MB). Its name says win32, but
 *     @deepseek-ai/dsh-subprocess-local/lib/index.js:12 imports it statically
 *     on every platform, so removing it breaks the host on darwin too. It also
 *     declares no os/cpu, which is exactly why the audit cannot judge it.
 *   - @reflink/reflink-{darwin-x64,win32-arm64-msvc,win32-x64-msvc} (1.0 MB),
 *     pnpm's own optional reflink bindings inside node/lib/node_modules. The
 *     node distribution is shipped whole (it is the toolchain the app hands a
 *     plugin install), so node/ is out of scope; the audit prints what it holds.
 *   - @tencent-qqmail/agently-cli, a wrapper that declares every operating
 *     system and both cpu architectures, and carries no native code of its own.
 *
 * Not removed, measured (desktop/scripts/verify-prune-mygo-payload.mjs keeps
 * these numbers honest, desktop/README.md records the reasoning):
 *   - *.d.ts (about 48 MB): node never loads a declaration at runtime, but they
 *     are the type surface of the profile a plugin author develops against, and
 *     the saving is small next to the per-platform packages;
 *   - package test/ and docs/ directories (about 9 MB, 24 directories): a
 *     package may read its own fixtures, and the saving is smaller still.
 *
 * Usage:
 *   node scripts/prune-mygo-payload.mjs --platform darwin-arm64 [--root <dir>]
 *                                      [--rules platform-packages,source-maps]
 *                                      [--keep-all-platforms] [--dry-run]
 *                                      [--report <file>] [--verbose]
 *
 * --dry-run plans and audits without removing anything; it exits 1 when the
 * table and the payload disagree. --keep-all-platforms selects no rule at all
 * (every platform stays) and still audits.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const defaultRoot = path.join(scriptsDir, '..', 'mygo', 'resources', 'runtime');

/** The payload trees this trim may touch; node/ is shipped whole. */
export const PRUNED_TREES = ['host', 'profile-trading'];

/** The platform tags per-platform packages are keyed by. */
export const PLATFORM_TAGS = ['darwin-arm64', 'darwin-x64', 'win32-arm64', 'win32-x64'];

/**
 * Package name -> the single platform tag it serves.
 *
 * Read it as the payload's per-platform inventory: every package here is one
 * whose package.json pins os and cpu, so on any other platform it is an
 * installed optional dependency nobody loads. The darwin-arm64 row is listed
 * even though this build keeps it — the table then names the whole family, and
 * the audit checks the kept row's declaration as well.
 */
export const PLATFORM_PACKAGES = Object.freeze({
  // LibreOffice kit, one package per platform triplet. The office capability
  // resolves the running platform's package only; darwin-arm64 stays because
  // DSH_PRIMARY_RUNTIME will point at it once the capability is enabled.
  '@deepseek-ai/libreoffice-kit-darwin-arm64': 'darwin-arm64',
  '@deepseek-ai/libreoffice-kit-darwin-x64': 'darwin-x64',
  '@deepseek-ai/libreoffice-kit-win32-arm64': 'win32-arm64',
  '@deepseek-ai/libreoffice-kit-win32-x64': 'win32-x64',

  // sharp, as a native binding plus a libvips build per platform.
  '@img/sharp-darwin-arm64': 'darwin-arm64',
  '@img/sharp-darwin-x64': 'darwin-x64',
  '@img/sharp-libvips-darwin-arm64': 'darwin-arm64',
  '@img/sharp-libvips-darwin-x64': 'darwin-x64',
  '@img/sharp-win32-arm64': 'win32-arm64',
  '@img/sharp-win32-x64': 'win32-x64',

  // sherpa-onnx speech runtime. The windows packages spell the platform "win".
  'sherpa-onnx-darwin-arm64': 'darwin-arm64',
  'sherpa-onnx-darwin-x64': 'darwin-x64',
  'sherpa-onnx-win-x64': 'win32-x64',

  // koffi FFI prebuilds.
  '@koromix/koffi-darwin-arm64': 'darwin-arm64',
  '@koromix/koffi-darwin-x64': 'darwin-x64',
  '@koromix/koffi-win32-arm64': 'win32-arm64',
  '@koromix/koffi-win32-x64': 'win32-x64',

  // ripgrep binaries.
  '@vscode/ripgrep-darwin-arm64': 'darwin-arm64',
  '@vscode/ripgrep-darwin-x64': 'darwin-x64',
  '@vscode/ripgrep-win32-arm64': 'win32-arm64',
  '@vscode/ripgrep-win32-x64': 'win32-x64',

  // N-API prebuilds of the require-builtin addon.
  'node-addon-require-builtin-darwin-arm64': 'darwin-arm64',
  'node-addon-require-builtin-darwin-x64': 'darwin-x64',
  'node-addon-require-builtin-win32-arm64-msvc': 'win32-arm64',
  'node-addon-require-builtin-win32-x64-msvc': 'win32-x64',

  // The OS bindings dsh's system services load (no win32 build exists yet).
  '@deepseek-ai/node-addon-system-darwin-arm64': 'darwin-arm64',
  '@deepseek-ai/node-addon-system-darwin-x64': 'darwin-x64',

  // trycua's computer-use driver.
  '@trycua/cua-driver-darwin-arm64': 'darwin-arm64',
  '@trycua/cua-driver-darwin-x64': 'darwin-x64',
  '@trycua/cua-driver-win32-arm64-msvc': 'win32-arm64',
  '@trycua/cua-driver-win32-x64-msvc': 'win32-x64',

  // The QQ mail CLI binaries the mail connector shells out to.
  '@tencent-qqmail/agently-cli-darwin-arm64': 'darwin-arm64',
  '@tencent-qqmail/agently-cli-darwin-x64': 'darwin-x64',
  '@tencent-qqmail/agently-cli-win32-arm64': 'win32-arm64',
  '@tencent-qqmail/agently-cli-win32-x64': 'win32-x64',

  // ubjs native node bindings.
  '@ubjs/node-darwin-arm64': 'darwin-arm64',
  '@ubjs/node-darwin-x64': 'darwin-x64',
  '@ubjs/node-win32-arm64-msvc': 'win32-arm64',
  '@ubjs/node-win32-x64-msvc': 'win32-x64',
});

/** The platform tags a build target keeps. */
const TARGET_KEEP = Object.freeze({
  'darwin-arm64': ['darwin-arm64'],
  'darwin-x64': ['darwin-x64'],
  'darwin-universal': ['darwin-arm64', 'darwin-x64'],
  universal: ['darwin-arm64', 'darwin-x64'],
  'win32-arm64': ['win32-arm64'],
  'win32-x64': ['win32-x64'],
});

/** The rules a prune applies, in the order the report lists them. */
export const RULES = Object.freeze(['platform-packages', 'source-maps']);

/** os and cpu of one platform tag. */
function tagParts(tag) {
  const split = tag.lastIndexOf('-');
  return { os: tag.slice(0, split), cpu: tag.slice(split + 1) };
}

/**
 * The platform tags a build target keeps. Throws for a target this payload was
 * never installed for, so an unknown platform can never be trimmed blindly.
 */
export function keepTags(platform) {
  const key = String(platform).trim().toLowerCase().replace(/\//g, '-');
  const tags = TARGET_KEEP[key];
  if (tags === undefined) {
    throw new Error(
      'no prune rule for platform "' + platform + '": known targets are '
      + Object.keys(TARGET_KEEP).join(', ')
      + ' (pass --keep-all-platforms to stage every platform)',
    );
  }
  return [...tags].sort();
}

/** Render a byte count the way du -sh does. */
export function human(bytes) {
  const units = ['B', 'K', 'M', 'G', 'T'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return (unit === 0 ? String(value) : value.toFixed(value < 10 ? 1 : 0)) + units[unit];
}

/** Sum the bytes of a tree, without following symlinks out of it. */
function sizeOf(target) {
  const stat = fs.lstatSync(target);
  if (!stat.isDirectory()) return stat.size;
  let total = 0;
  for (const entry of fs.readdirSync(target)) total += sizeOf(path.join(target, entry));
  return total;
}

/** Read a package manifest, or null when the directory holds none. */
function readManifest(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
}

/** One platform string list of a manifest, or null when it declares none. */
function declared(value) {
  return Array.isArray(value) && value.length > 0 ? value : null;
}

/** Whether a manifest says it runs on the given platform tag. */
function servesTag(manifest, tag) {
  const { os, cpu } = tagParts(tag);
  const osList = declared(manifest.os);
  const cpuList = declared(manifest.cpu);
  if (osList !== null && !osList.includes(os)) return false;
  if (cpuList !== null && !cpuList.includes(cpu)) return false;
  return true;
}

/** The one platform tag a manifest pins, or null when it pins none or several. */
function pinnedTag(manifest) {
  const osList = declared(manifest.os);
  const cpuList = declared(manifest.cpu);
  if (osList === null || cpuList === null || osList.length !== 1 || cpuList.length !== 1) return null;
  return osList[0] + '-' + cpuList[0];
}

/** Whether a path is a directory, following a symlink; a dangling one is not. */
function isDirectory(target) {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

/** The package entries of one node_modules directory, symlinks included. */
function packagesIn(nodeModules) {
  const found = [];
  for (const entry of fs.readdirSync(nodeModules)) {
    // .bin and pnpm's bookkeeping (.pnpm, .modules.yaml, .package-map.json) are
    // not packages; a pnpm store layout is caught by the symlink guard instead.
    if (entry.startsWith('.')) continue;
    const first = path.join(nodeModules, entry);
    if (!isDirectory(first)) continue;
    if (entry.startsWith('@') && !fs.lstatSync(first).isSymbolicLink()) {
      for (const name of fs.readdirSync(first)) {
        const dir = path.join(first, name);
        if (!isDirectory(dir)) continue;
        found.push({ name: entry + '/' + name, dir, symlink: fs.lstatSync(dir).isSymbolicLink() });
      }
      continue;
    }
    found.push({ name: entry, dir: first, symlink: fs.lstatSync(first).isSymbolicLink() });
  }
  return found;
}

/** Walk a tree and collect every package it holds, nested node_modules included. */
function collectPackages(base, into, depth = 0) {
  if (depth > 6) return;
  for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(base, entry.name);
    if (entry.name !== 'node_modules') {
      collectPackages(dir, into, depth + 1);
      continue;
    }
    for (const found of packagesIn(dir)) {
      into.push({
        name: found.name,
        dir: found.dir,
        symlink: found.symlink,
        manifest: found.symlink ? null : readManifest(found.dir),
      });
      if (!found.symlink) collectPackages(found.dir, into, depth + 1);
    }
  }
}

/** Every *.map file under a tree, without following symlinks. */
function collectSourceMaps(base, into) {
  for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
    const file = path.join(base, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      collectSourceMaps(file, into);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.map')) into.push({ file, bytes: fs.lstatSync(file).size });
  }
}

/** Refuse a name that could escape the payload root. */
function assertSafeName(name) {
  if (typeof name !== 'string' || name === '' || name.includes('\\') || name.includes('..')) {
    throw new Error('the package table holds an unusable name: ' + JSON.stringify(name));
  }
  const parts = name.split('/');
  if (parts.length > 2 || (parts.length === 2 && !parts[0].startsWith('@'))) {
    throw new Error('the package table holds a name that is not a package name: ' + JSON.stringify(name));
  }
}

/** Resolve a path and prove it stays inside the staged payload. */
function insideRoot(root, target) {
  const resolvedRoot = path.resolve(root) + path.sep;
  const resolved = path.resolve(target);
  if (!resolved.startsWith(resolvedRoot)) {
    throw new Error('refusing to remove ' + resolved + ': it is outside ' + path.resolve(root));
  }
  return resolved;
}

/**
 * Plan a trim: read the payload, check the table against every declaration and
 * list what the selected rules would remove. Reads only; the filesystem is left
 * as it is, so the same call backs both --dry-run and apply.
 */
export function plan(options) {
  const root = path.resolve(options.root ?? defaultRoot);
  const rules = options.rules ?? RULES;
  const keep = keepTags(options.platform);
  const keepSet = new Set(keep);
  for (const rule of rules) {
    if (!RULES.includes(rule)) throw new Error('unknown prune rule "' + rule + '": known rules are ' + RULES.join(', '));
  }
  if (!fs.existsSync(root)) throw new Error('no staged payload at ' + root);

  const report = {
    root,
    target: String(options.platform).trim().toLowerCase().replace(/\//g, '-'),
    keep,
    rules: [...rules],
    removed: [],
    kept: [],
    mappedAbsent: [],
    unmapped: [],
    sourceMaps: { count: 0, bytes: 0 },
    outOfScope: [],
    problems: [],
    totals: { entries: 0, bytes: 0 },
  };

  const packages = [];
  for (const tree of PRUNED_TREES) {
    const base = path.join(root, tree);
    if (!fs.existsSync(base)) throw new Error('the staged payload at ' + root + ' has no ' + tree + '/');
    collectPackages(base, packages);
  }

  const present = new Map();
  for (const pkg of packages) {
    if (present.has(pkg.name)) present.set(pkg.name, [...present.get(pkg.name), pkg]);
    else present.set(pkg.name, [pkg]);
  }

  for (const [name, entries] of present) {
    const tag = PLATFORM_PACKAGES[name];
    if (tag !== undefined) assertSafeName(name);
    for (const pkg of entries) {
      if (pkg.symlink) {
        report.problems.push({
          kind: 'symlink',
          detail: name + ' at ' + path.relative(root, pkg.dir) + ' is a symlink: the payload must stay on pnpm\'s hoisted layout (desktop/runtime/host/pnpm-workspace.yaml nodeLinker: hoisted)',
        });
        continue;
      }
      const manifest = pkg.manifest ?? {};
      const pinned = pinnedTag(manifest);
      if (tag !== undefined && pinned !== null && pinned !== tag) {
        report.problems.push({
          kind: 'table',
          detail: name + ' is listed as ' + tag + ' but its package.json pins ' + pinned,
        });
      }
      if (tag !== undefined && pinned === null && !servesTag(manifest, tag)) {
        report.problems.push({
          kind: 'table',
          detail: name + ' is listed as ' + tag + ' but its package.json does not declare that platform',
        });
      }
      if (tag === undefined) {
        if (!keep.every((candidate) => servesTag(manifest, candidate))) {
          report.unmapped.push({ name, path: path.relative(root, pkg.dir), os: declared(manifest.os), cpu: declared(manifest.cpu) });
          report.problems.push({
            kind: 'unmapped',
            detail: path.relative(root, pkg.dir) + ' declines the target platform (os ' + JSON.stringify(declared(manifest.os)) + ', cpu ' + JSON.stringify(declared(manifest.cpu)) + ') but has no entry in PLATFORM_PACKAGES',
          });
          continue;
        }
        // Sizes are accounted for the packages the table maps: those are the
        // ones the trim decides about, and sizing every package in the payload
        // would cost more than the whole removal.
        report.kept.push({ name, platform: null, path: path.relative(root, pkg.dir), bytes: null });
        continue;
      }
      const entry = { name, platform: tag, path: path.relative(root, pkg.dir), bytes: sizeOf(pkg.dir) };
      if (keepSet.has(tag)) report.kept.push(entry);
      else if (rules.includes('platform-packages')) report.removed.push({ ...entry, rule: 'platform-packages' });
      else report.kept.push({ ...entry, stayed: true });
    }
  }

  for (const name of Object.keys(PLATFORM_PACKAGES)) {
    if (!present.has(name)) report.mappedAbsent.push({ name, platform: PLATFORM_PACKAGES[name] });
  }

  if (rules.includes('source-maps')) {
    const maps = [];
    for (const tree of PRUNED_TREES) collectSourceMaps(path.join(root, tree), maps);
    report.sourceMaps.count = maps.length;
    report.sourceMaps.bytes = maps.reduce((sum, map) => sum + map.bytes, 0);
    for (const map of maps) {
      report.removed.push({ name: path.relative(root, map.file), platform: null, path: path.relative(root, map.file), bytes: map.bytes, rule: 'source-maps' });
    }
  }

  // What the trim leaves alone outside the pruned trees, named so the scope
  // decision is visible rather than silent.
  const outside = [];
  for (const entry of fs.readdirSync(root)) {
    if (PRUNED_TREES.includes(entry)) continue;
    const dir = path.join(root, entry);
    if (!fs.lstatSync(dir).isDirectory()) continue;
    collectPackages(dir, outside);
  }
  for (const pkg of outside) {
    if (pkg.symlink) continue;
    const manifest = pkg.manifest ?? {};
    // Same criterion as the audit: per-platform and not for this target. The
    // table is no help here — node/ ships its own optional bindings.
    if (keep.every((tag) => servesTag(manifest, tag))) continue;
    report.outOfScope.push({
      name: pkg.name,
      platform: pinnedTag(manifest),
      path: path.relative(root, pkg.dir),
      bytes: sizeOf(pkg.dir),
    });
  }

  report.removed.sort((a, b) => a.path.localeCompare(b.path));
  report.totals.entries = report.removed.length;
  report.totals.bytes = report.removed.reduce((sum, item) => sum + item.bytes, 0);
  return report;
}

/**
 * Apply a plan: remove every listed package directory and source map, then the
 * @scope directories the trim emptied. Every path is proven inside the root
 * first, and a path that is still there after removal fails the run.
 */
export function apply(report) {
  for (const item of report.removed) {
    const target = insideRoot(report.root, path.join(report.root, item.path));
    const stat = fs.lstatSync(target);
    if (stat.isDirectory()) fs.rmSync(target, { recursive: true, force: false });
    else fs.rmSync(target, { force: false });
    if (fs.existsSync(target)) throw new Error('removal left ' + target + ' behind');
    if (item.rule !== 'platform-packages') continue;
    const parent = path.dirname(target);
    if (path.basename(parent).startsWith('@') && fs.readdirSync(parent).length === 0) fs.rmdirSync(parent);
  }
  return report;
}

/** The lines one prune prints; the caller decides where they go. */
export function formatLines(report) {
  const lines = [];
  lines.push('target ' + report.target + ' keeps ' + report.keep.join(' + '));
  if (report.rules.length === 0) {
    lines.push('no rule selected: every platform stays (--keep-all-platforms)');
  } else {
    const packages = report.removed.filter((item) => item.rule === 'platform-packages');
    const mapped = Object.keys(PLATFORM_PACKAGES).length;
    lines.push(
      'platform packages: ' + mapped + ' mapped, ' + packages.length + ' removed ('
      + human(packages.reduce((sum, item) => sum + item.bytes, 0)) + '), '
      + report.kept.filter((item) => item.platform !== null).length + ' kept, '
      + report.mappedAbsent.length + ' absent from this payload',
    );
    for (const item of packages) {
      lines.push('  ' + item.path + '  ' + human(item.bytes) + '  (' + item.platform + ')');
    }
    if (report.rules.includes('source-maps')) {
      const plural = report.sourceMaps.count === 1 ? ' file, ' : ' files, ';
      lines.push('source maps: ' + report.sourceMaps.count + plural + human(report.sourceMaps.bytes));
    }
  }
  if (report.outOfScope.length > 0) {
    lines.push(
      'out of scope: node/ holds ' + report.outOfScope.length + ' more per-platform packages ('
      + human(report.outOfScope.reduce((sum, item) => sum + item.bytes, 0)) + '), shipped whole',
    );
  }
  if (report.problems.length > 0) {
    for (const problem of report.problems) lines.push('problem (' + problem.kind + '): ' + problem.detail);
  }
  lines.push(
    (report.totals.entries === 0 ? 'nothing removed' : 'removed ' + human(report.totals.bytes) + ' in ' + report.totals.entries + ' entries')
    + '; the source payload is untouched',
  );
  return lines;
}

/** Plan, complain, and (unless told otherwise) apply. */
export function prune(options) {
  const report = plan(options);
  const lines = formatLines(report);
  for (const line of lines) console.log('[prune-mygo-payload] ' + line);
  if (report.problems.length > 0) {
    const error = new Error('the package table and the payload disagree (' + report.problems.length + ' problem(s)); nothing was removed');
    error.report = report;
    throw error;
  }
  if (options.apply !== false) apply(report);
  return report;
}

/** Parse the command line of the standalone entry point. */
function parseArgs(argv) {
  const options = { root: defaultRoot, rules: [...RULES], apply: true, platform: undefined, report: undefined, verbose: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--dry-run') {
      options.apply = false;
    } else if (flag === '--keep-all-platforms') {
      options.rules = [];
    } else if (flag === '--verbose') {
      options.verbose = true;
    } else if (flag === '--platform' || flag === '--root' || flag === '--rules' || flag === '--report') {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(flag + ' needs a value');
      if (flag === '--platform') options.platform = value;
      else if (flag === '--root') options.root = path.resolve(value);
      else if (flag === '--report') options.report = path.resolve(value);
      else options.rules = value.split(',').map((rule) => rule.trim()).filter((rule) => rule !== '');
      i += 1;
    } else {
      throw new Error('unknown flag ' + flag);
    }
  }
  if (options.platform === undefined) throw new Error('--platform is required (for example --platform darwin-arm64)');
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = prune(options);
  if (options.report !== undefined) {
    fs.writeFileSync(options.report, JSON.stringify(report, null, 2) + '\n');
    console.log('[prune-mygo-payload] report: ' + options.report);
  }
  if (options.verbose) {
    for (const item of report.removed) console.log('[prune-mygo-payload]   ' + item.rule + '  ' + item.path + '  ' + human(item.bytes));
  }
  if (!options.apply) console.log('[prune-mygo-payload] dry run: nothing was removed');
}

/**
 * Whether this module is the process's entry point. Both sides are resolved
 * through realpath: /tmp is a symlink to /private/tmp on macOS, and a build that
 * calls the script by an absolute staged path must not fall through to a silent
 * no-op.
 */
function isEntryPoint() {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return fs.realpathSync(entry) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  try {
    main();
  } catch (error) {
    console.error('[prune-mygo-payload] ' + String(error && error.message ? error.message : error));
    process.exitCode = 1;
  }
}
