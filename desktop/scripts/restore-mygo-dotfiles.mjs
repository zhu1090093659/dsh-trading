#!/usr/bin/env node
'use strict';

/**
 * Put back the dotfiles `mygo build` leaves out of the app bundle.
 *
 * mygo v0.7.4 assembles Contents/Resources from the staged payload but skips
 * every name that starts with a dot (cmd/mygo/resources.go:551 hiddenName, used
 * at :380 while collecting and :643 while copying), so a payload that needs one
 * of them breaks at run time: the 2026-10-21 payload carries
 * @earendil-works/pi-ai/dist/providers/data/.manifest.json, which
 * @deepseek-ai/dsh-llm-pi-ai imports, and the host then logs
 * "dsh: warning: 1 entry did not activate / Cannot find module".
 *
 * The list is never written by hand. This script walks the staged payload and
 * the bundle's runtime directory and the difference is what it restores; it
 * refuses to run when the difference holds anything but dotfiles (a build that
 * drops other files needs a human decision), when the bundle holds files the
 * payload does not, and it re-checks the result before it reports success.
 *
 * The shell's own signing is not drift: `mygo build -sign` re-signs every Mach-O
 * it ships, and a signature is appended to the file, so the bundle copy is larger
 * than the one staged. Those entries are reported as re-signed; any other
 * difference still stops the build.
 *
 * The app's seal is stale the moment a file lands in the bundle, so the caller
 * restores first and then signs: nothing else may run in between.
 *
 * Usage:
 *   node scripts/restore-mygo-dotfiles.mjs --source <staged runtime>
 *                                          --bundle <app runtime>
 *                                          [--check] [--report <file>]
 *
 * --check writes nothing and exits 1 while anything is missing, which is the
 * gate the build runs after the restore.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));

/** Render a byte count the way du -sh does. */
function human(bytes) {
  const units = ['B', 'K', 'M', 'G', 'T'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return (unit === 0 ? String(value) : value.toFixed(value < 10 ? 1 : 0)) + units[unit];
}

/** Whether any segment of a relative path starts with a dot. */
function isHidden(relative) {
  return relative.split('/').some((segment) => segment.startsWith('.'));
}

/**
 * Every entry under root, relative to it, without following symlinks:
 * { type: 'file' | 'dir' | 'link', size, mode, link }.
 */
function manifest(root) {
  const entries = new Map();
  const walk = (dir, prefix) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const target = path.join(dir, name);
      const relative = prefix === '' ? name : prefix + '/' + name;
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink()) {
        entries.set(relative, { type: 'link', size: 0, mode: 0, link: fs.readlinkSync(target) });
      } else if (stat.isDirectory()) {
        entries.set(relative, { type: 'dir', size: 0, mode: stat.mode & 0o7777, link: null });
        walk(target, relative);
      } else {
        entries.set(relative, { type: 'file', size: stat.size, mode: stat.mode & 0o7777, link: null, mtime: stat.mtime });
      }
    }
  };
  walk(root, '');
  return entries;
}

/** The entries a tree holds that the other does not, sorted. */
function difference(left, right) {
  return [...left.keys()].filter((key) => !right.has(key)).sort();
}

/** Whether two entries describe the same thing. */
function same(a, b) {
  if (a.type !== b.type) return false;
  if (a.type === 'link') return a.link === b.link;
  if (a.type === 'file') return a.size === b.size;
  return true;
}

/** The magic numbers a Mach-O image starts with, thin and fat, either byte order. */
const MACHO_MAGICS = new Set([0xfeedface, 0xfeedfacf, 0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca]);

/** Whether the file starts with a Mach-O magic number. */
function isMachO(file) {
  const buffer = Buffer.alloc(4);
  const fd = fs.openSync(file, 'r');
  let read = 0;
  try {
    read = fs.readSync(fd, buffer, 0, 4, 0);
  } finally {
    fs.closeSync(fd);
  }
  if (read !== 4) return false;
  return MACHO_MAGICS.has(buffer.readUInt32BE(0)) || MACHO_MAGICS.has(buffer.readUInt32LE(0));
}

/**
 * Whether the bundle entry is the staged binary the shell re-signed: both sides
 * are Mach-O, the shipped copy is larger (codesign appends its signature), and
 * codesign reads it as signed. On a host without codesign nothing counts as
 * re-signed, so that comparison stays strict there.
 */
function isResigned(stagedPath, shippedPath) {
  if (fs.statSync(shippedPath).size <= fs.statSync(stagedPath).size) return false;
  if (!isMachO(stagedPath) || !isMachO(shippedPath)) return false;
  try {
    execFileSync('codesign', ['-dv', '--verbose=2', shippedPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    return true;
  } catch {
    return false;
  }
}

/** Plan and, unless it is a check, perform the restore. */
export function restore(options) {
  const source = path.resolve(options.source);
  const bundle = path.resolve(options.bundle);
  for (const [label, dir] of [['staged payload', source], ['bundle runtime', bundle]]) {
    if (!fs.existsSync(dir) || !fs.lstatSync(dir).isDirectory()) {
      throw new Error('no ' + label + ' at ' + dir);
    }
  }

  const staged = manifest(source);
  const shipped = manifest(bundle);
  const missing = difference(staged, shipped);
  const extra = difference(shipped, staged);
  const report = {
    source,
    bundle,
    missing: missing.length,
    extra: extra.length,
    copied: 0,
    bytes: 0,
    entries: [],
  };

  for (const relative of missing) {
    const entry = staged.get(relative);
    if (entry.type === 'file') report.bytes += entry.size;
    report.entries.push({ path: relative, type: entry.type, bytes: entry.type === 'file' ? entry.size : 0 });
  }

  const notHidden = missing.filter((relative) => !isHidden(relative));
  console.log('[restore-mygo-dotfiles] staged payload ' + source);
  console.log('[restore-mygo-dotfiles] bundle runtime ' + bundle);
  console.log(
    '[restore-mygo-dotfiles] missing ' + missing.length + ' entries (' + human(report.bytes) + '), '
    + (missing.length === 0 ? 'nothing to restore' : notHidden.length === 0 ? 'all dotfiles' : notHidden.length + ' of them not dotfiles')
    + '; extra ' + extra.length,
  );

  if (extra.length > 0) {
    throw new Error(
      'the bundle holds ' + extra.length + ' entr' + (extra.length === 1 ? 'y' : 'ies')
      + ' the staged payload does not, so this is not a copy that only lost dotfiles: '
      + extra.slice(0, 5).join(', '),
    );
  }
  if (notHidden.length > 0) {
    throw new Error(
      'the bundle is missing ' + notHidden.length + ' entr' + (notHidden.length === 1 ? 'y' : 'ies')
      + ' that ' + (notHidden.length === 1 ? 'is' : 'are') + ' not dotfiles, which mygo build is not known to drop: '
      + notHidden.slice(0, 5).join(', '),
    );
  }
  const differing = [...staged.keys()].filter(
    (relative) => shipped.has(relative) && !same(staged.get(relative), shipped.get(relative)),
  );
  const resigned = differing.filter(
    (relative) => isResigned(path.join(source, relative), path.join(bundle, relative)),
  );
  const drifted = differing.filter((relative) => !resigned.includes(relative));
  if (drifted.length > 0) {
    throw new Error('the bundle holds different content for ' + drifted.slice(0, 5).join(', '));
  }
  report.resigned = resigned;
  if (resigned.length > 0) {
    console.log('[restore-mygo-dotfiles] ' + resigned.length + ' Mach-O entries re-signed by the shell, not drift');
  }

  if (options.check === true) {
    return report;
  }

  for (const entry of report.entries) {
    const sourcePath = path.join(source, entry.path);
    const target = path.join(bundle, entry.path);
    const meta = staged.get(entry.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (meta.type === 'dir') {
      fs.mkdirSync(target, { recursive: true });
      fs.chmodSync(target, meta.mode);
    } else if (meta.type === 'link') {
      fs.symlinkSync(meta.link, target);
    } else {
      fs.copyFileSync(sourcePath, target);
      fs.chmodSync(target, meta.mode);
      if (meta.mtime instanceof Date) fs.utimesSync(target, meta.mtime, meta.mtime);
    }
    report.copied += 1;
  }

  const after = manifest(bundle);
  const wrong = [...staged.keys()].filter((relative) => {
    if (resigned.includes(relative)) return false;
    const now = after.get(relative);
    return now === undefined || !same(staged.get(relative), now);
  });
  if (wrong.length > 0) {
    throw new Error('the restore left ' + wrong.length + ' entries out of step with the payload: ' + wrong.slice(0, 5).join(', '));
  }

  console.log(
    '[restore-mygo-dotfiles] restored ' + report.copied + ' entries (' + human(report.bytes) + '); '
    + 'the app signature is stale and must be redone',
  );
  return report;
}

/** Parse the command line. */
function parseArgs(argv) {
  const options = { source: undefined, bundle: undefined, check: false, report: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--check') {
      options.check = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined) throw new Error(flag + ' needs a value');
    if (flag === '--source') options.source = path.resolve(value);
    else if (flag === '--bundle') options.bundle = path.resolve(value);
    else if (flag === '--report') options.report = path.resolve(value);
    else throw new Error('unknown flag ' + flag);
    i += 1;
  }
  if (options.source === undefined || options.bundle === undefined) {
    throw new Error('--source and --bundle are required (see the header)');
  }
  return options;
}

/**
 * Whether this module is the process's entry point, resolved through realpath
 * so that a build calling it by an absolute path under /tmp (a symlink to
 * /private/tmp on macOS) still runs.
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
    const options = parseArgs(process.argv.slice(2));
    const report = restore(options);
    if (options.report !== undefined) {
      fs.writeFileSync(options.report, JSON.stringify(report, null, 2) + '\n');
      console.log('[restore-mygo-dotfiles] report: ' + options.report);
    }
    if (options.check === true && report.missing > 0) {
      console.error('[restore-mygo-dotfiles] the bundle is missing ' + report.missing + ' entries the payload holds');
      process.exitCode = 1;
    }
  } catch (error) {
    console.error('[restore-mygo-dotfiles] ' + String(error && error.message ? error.message : error));
    process.exitCode = 1;
  }
}
