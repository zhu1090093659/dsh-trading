#!/usr/bin/env node
'use strict';

/**
 * Verify the Windows half of the payload staging, on fixtures, without building.
 *
 * Two scripts decide whether a Windows installer ships an app that can start, and
 * both fail the same silent way — an installed app that cannot start:
 * stage-mygo-payload.mjs picks the node distribution of the target and trims the
 * platforms it does not ship, and stage-mygo-dotfiles.mjs puts back the files mygo
 * leaves out (every name that starts with a dot) in the app directory and in the
 * installer macro. What both do is checked here against synthetic payloads:
 *
 *   1. --platform windows/amd64 stages node-win32-x64 as runtime/node/node.exe, with
 *      the npm.cmd and npx.cmd wrappers the Windows shell runs;
 *   2. --platform windows-amd64 produces the same tree: the two spellings agree;
 *   3. a payload without npm.cmd stops the staging, naming the file (negative);
 *   4. a payload that holds only the node of another platform stops it instead of
 *      shipping a macOS node in a Windows app (negative: an installed app carries
 *      the node of the machine it runs on, not every target);
 *   5. a Windows staging keeps the win32-x64 packages and drops the darwin ones;
 *   6. a darwin staging keeps the darwin ones and drops the win32 ones, so the
 *      existing behaviour is unchanged and a win32 package never stays in a darwin
 *      payload (negative);
 *   7. the dotfiles macro holds a CreateDirectory per dotted directory and a
 *      SetOutPath + File pair per dotted file, at the path the app installs them;
 *   8. a payload with no dotted entry writes an empty macro and succeeds;
 *   9. copying the dotted entries into an app directory makes it whole, and the
 *      check refuses an app that lacks them (negative);
 *  10. the check refuses an app whose copy differs in content (negative);
 *  11. makensis, on a fixture layout of installer/windows.nsh, compiles an installer
 *      with the macro in place (the File commands resolve) and fails on the message
 *      of the script when the macro is deleted, which is the gate a direct mygo
 *      build runs into;
 *  12. the command lines: a missing --source, an unknown flag, --check without --app
 *      and a target the payload cannot serve all exit 1.
 *
 * Case 11 needs makensis, and its listing 7z; a case whose tool is not installed is
 * skipped and counted (build-mygo-win.sh requires both anyway).
 *
 * Run it whenever the staging, the dotfile macro or the installer include change:
 *   node desktop/scripts/verify-windows-payload.mjs
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const stageScript = path.join(here, 'stage-mygo-payload.mjs');
const dotfilesScript = path.join(here, 'stage-mygo-dotfiles.mjs');
const installerInclude = path.join(here, '..', 'mygo', 'installer', 'windows.nsh');

let checks = 0;
let skipped = 0;

/** Assert one property of the staging and say so. */
function check(what, condition, detail) {
  checks += 1;
  assert.ok(condition, what + (detail === undefined ? '' : ' (' + detail + ')'));
  console.log('  ok  ' + what);
}

/** Say that a case needs a tool this machine does not have, and count it. */
function skip(what, why) {
  skipped += 1;
  console.log('  skip  ' + what + ' (' + why + ')');
}

/** The program when it runs here at all, else ''. */
function have(program) {
  return spawnSync(program, ['-VERSION'], { encoding: 'utf8' }).error === undefined ? program : '';
}

/** Write one file, with the directories above it. */
function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

/** Write one fixture package, with the os and cpu the trim reads. */
function packageFixture(root, name, os, cpu) {
  const dir = path.join(root, 'host', 'node_modules', ...name.split('/'));
  write(path.join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0', os: [os], cpu: [cpu] }, null, 2));
  write(path.join(dir, 'index.js'), 'module.exports = 1;');
}

/**
 * A payload shaped like desktop/resources/runtime: the staged trees, a
 * VERSION.json, and whichever node distributions the case needs.
 */
function makePayload(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'windows-payload-'));
  const withWindows = options.withWindows ?? true;
  const withDarwin = options.withDarwin ?? false;
  const withMappedNode = options.withMappedNode ?? false;
  const withWrappers = options.withWrappers ?? true;
  if (withWindows) {
    const dir = path.join(root, 'node-win32-x64');
    write(path.join(dir, 'node.exe'), 'MZ windows node');
    if (withWrappers) {
      write(path.join(dir, 'npm.cmd'), '@echo off');
      write(path.join(dir, 'npx.cmd'), '@echo off');
    }
    write(path.join(dir, 'nodevars.bat'), '@echo off');
  }
  if (withDarwin) {
    const dir = path.join(root, 'node-darwin-arm64');
    write(path.join(dir, 'bin', 'node'), 'mac node');
    write(path.join(dir, 'bin', 'npm'), '#!/bin/sh');
    write(path.join(dir, 'bin', 'npx'), '#!/bin/sh');
  }
  if (withMappedNode) {
    // What an installed app carries: its own platform, already renamed to node/.
    const dir = path.join(root, 'node');
    write(path.join(dir, 'bin', 'node'), 'mac node');
    write(path.join(dir, 'bin', 'npm'), '#!/bin/sh');
    write(path.join(dir, 'bin', 'npx'), '#!/bin/sh');
  }
  write(path.join(root, 'host', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), '// host');
  packageFixture(root, '@img/sharp-win32-x64', 'win32', 'x64');
  packageFixture(root, '@img/sharp-darwin-arm64', 'darwin', 'arm64');
  write(path.join(root, 'profile-trading', 'package.json'), '{"name":"profile-trading"}');
  write(path.join(root, 'profile-trading', 'cordis.patch.yml'), 'plugins: []');
  write(path.join(root, 'VERSION.json'), '{"host":"fixture"}');
  if (options.dotEntries) {
    write(path.join(root, 'host', 'node_modules', '@earendil-works', 'pi-ai', 'dist', 'providers', 'data', '.manifest.json'), '{"providers":[]}');
    write(path.join(root, 'host', '.cache', 'inside.bin'), 'cache bytes');
    fs.mkdirSync(path.join(root, 'host', '.empty'), { recursive: true });
    write(path.join(root, 'host', '.hidden.txt'), 'hidden');
  }
  return root;
}

/** The files of a tree, relative to it, sorted. */
function treeFiles(root) {
  const out = [];
  const walk = (dir, prefix) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const absolute = path.join(dir, name);
      const relative = prefix === '' ? name : prefix + '/' + name;
      const stat = fs.lstatSync(absolute);
      if (stat.isDirectory()) walk(absolute, relative);
      else out.push(relative);
    }
  };
  walk(root, '');
  return out;
}

/** Run the payload staging, as the build script does. */
function stage(payload, platform, out) {
  return spawnSync(process.execPath, [stageScript, '--platform', platform, '--from', payload, '--to', out], { encoding: 'utf8' });
}

/** Run the dotfile staging, as the build script does. */
function dotfiles(args) {
  return spawnSync(process.execPath, [dotfilesScript, ...args], { encoding: 'utf8' });
}

/** A temporary directory. */
function temp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Read a file as text, without its byte order mark. */
function text(file) {
  return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
}

/**
 * Whether every SetOutPath that goes somewhere is followed by a File: the pair is
 * what copies a file into the folder the app needs it in.
 */
function pairsFileAfterFolder(script) {
  const lines = script.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.startsWith('  SetOutPath "$INSTDIR\\')) continue;
    if (!(lines[i + 1] ?? '').startsWith('  File ')) return false;
  }
  return true;
}

/** Drop a temporary tree, whatever happened. */
function drop(...roots) {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
}

// 1 and 2. the two spellings of the target, and what they stage.
{
  const payload = makePayload();
  const out = temp('windows-stage-');
  try {
    const first = stage(payload, 'windows/amd64', path.join(out, 'slash'));
    check('windows/amd64 stages', first.status === 0, first.stderr);
    check('it maps node-win32-x64 to node/node.exe', fs.existsSync(path.join(out, 'slash', 'node', 'node.exe')));
    check('it keeps the npm.cmd and npx.cmd wrappers',
      fs.existsSync(path.join(out, 'slash', 'node', 'npm.cmd')) && fs.existsSync(path.join(out, 'slash', 'node', 'npx.cmd')));
    check('it stages the host, the profile seed and VERSION.json',
      fs.existsSync(path.join(out, 'slash', 'host', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
      && fs.existsSync(path.join(out, 'slash', 'profile-trading', 'cordis.patch.yml'))
      && fs.existsSync(path.join(out, 'slash', 'VERSION.json')));
    check('it says which target it trimmed for', /windows\/amd64 is win32-x64/.test(first.stdout), first.stdout);
    const second = stage(payload, 'windows-amd64', path.join(out, 'dash'));
    check('windows-amd64 stages', second.status === 0, second.stderr);
    check('both spellings stage the same tree',
      treeFiles(path.join(out, 'slash')).join('\n') === treeFiles(path.join(out, 'dash')).join('\n'));
  } finally {
    drop(out, payload);
  }
}

// 3 and 4. what stops the staging.
{
  const noWrappers = makePayload({ withWrappers: false });
  const macOnly = makePayload({ withWindows: false, withMappedNode: true });
  const out = temp('windows-stage-neg-');
  try {
    const missing = stage(noWrappers, 'windows/amd64', path.join(out, 'wrappers'));
    check('a payload without npm.cmd stops the staging', missing.status === 1, String(missing.status));
    check('it names the file it wanted', /missing node\/npm\.cmd/.test(missing.stderr), missing.stderr);
    const wrongNode = stage(macOnly, 'windows/amd64', path.join(out, 'macnode'));
    check('a payload with only the node of another platform stops the staging', wrongNode.status === 1, String(wrongNode.status));
    check('it says which layout it found instead',
      /node holds bin\/node/.test(wrongNode.stderr) && /belongs to another platform/.test(wrongNode.stderr), wrongNode.stderr);
  } finally {
    drop(out, noWrappers, macOnly);
  }
}

// 5 and 6. the trim follows the target, the way prune-mygo-payload.mjs does.
{
  const payload = makePayload({ withDarwin: true });
  const out = temp('windows-trim-');
  const winPackage = path.join('host', 'node_modules', '@img', 'sharp-win32-x64');
  const darwinPackage = path.join('host', 'node_modules', '@img', 'sharp-darwin-arm64');
  try {
    const windows = stage(payload, 'windows/amd64', path.join(out, 'windows'));
    check('a Windows staging keeps the win32-x64 package',
      windows.status === 0 && fs.existsSync(path.join(out, 'windows', winPackage)), windows.stderr);
    check('a Windows staging drops the darwin one', !fs.existsSync(path.join(out, 'windows', darwinPackage)));
    check('a Windows staging keeps the win32 node', fs.existsSync(path.join(out, 'windows', 'node', 'node.exe')));
    check('a Windows staging carries no darwin node', !fs.existsSync(path.join(out, 'windows', 'node', 'bin', 'node')));
    const darwin = stage(payload, 'darwin-arm64', path.join(out, 'darwin'));
    check('a darwin staging still works', darwin.status === 0, darwin.stderr);
    check('it keeps the darwin package', fs.existsSync(path.join(out, 'darwin', darwinPackage)));
    check('it keeps bin/node', fs.existsSync(path.join(out, 'darwin', 'node', 'bin', 'node')));
    check('it drops the win32 package', !fs.existsSync(path.join(out, 'darwin', winPackage)));
    check('it drops the win32 node', !fs.existsSync(path.join(out, 'darwin', 'node', 'node.exe')));
  } finally {
    drop(out, payload);
  }
}

// 7. the macro the installer includes.
{
  const payload = makePayload({ dotEntries: true });
  const out = temp('windows-dotfiles-');
  try {
    const macro = path.join(out, 'installer-dotfiles.nsh');
    const report = path.join(out, 'report.json');
    const run = dotfiles(['--source', payload, '--prefix', 'runtime', '--macro', macro, '--report', report]);
    check('the dotfile staging writes the macro', run.status === 0, run.stderr);
    const written = text(macro);
    check('the macro is a RestoreDotfiles macro',
      written.includes('!macro RestoreDotfiles') && written.trimEnd().endsWith('!macroend'));
    check('the macro starts with a byte order mark', fs.readFileSync(macro)[0] === 0xef);
    check('it creates every dotted directory',
      written.includes('CreateDirectory "$INSTDIR\\runtime\\host\\.cache"')
      && written.includes('CreateDirectory "$INSTDIR\\runtime\\host\\.empty"'), written);
    check('it points the files at the folder the app installs',
      written.includes('SetOutPath "$INSTDIR\\runtime\\host\\node_modules\\@earendil-works\\pi-ai\\dist\\providers\\data"'), written);
    check('it packs every dotted file', (written.match(/^  File /gm) ?? []).length === 3, written);
    check('each folder it copies into is followed by a file', pairsFileAfterFolder(written), written);
    check('it ends back in the app folder', /SetOutPath "\$INSTDIR"\n/.test(written));
    const counted = JSON.parse(fs.readFileSync(report, 'utf8'));
    check('the report counts what was written', counted.files === 3 && counted.dirs === 2 && counted.bytes > 0, JSON.stringify(counted));
    check('it says how many it found', /3 files and 2 directories/.test(run.stdout), run.stdout);
  } finally {
    drop(out, payload);
  }
}

// 8. a payload with no dotted entry: an empty macro, and no error.
{
  const payload = makePayload();
  const out = temp('windows-dotfiles-empty-');
  try {
    const macro = path.join(out, 'installer-dotfiles.nsh');
    const run = dotfiles(['--source', payload, '--prefix', 'runtime', '--macro', macro]);
    check('a payload with no dotted entry succeeds', run.status === 0, run.stderr);
    const written = text(macro);
    check('its macro holds no File command', !/^  File /m.test(written), written);
    check('its macro says there is nothing to restore', /no such entry/.test(written), written);
    check('the staging says it found none', /0 files and 0 directories/.test(run.stdout), run.stdout);
  } finally {
    drop(out, payload);
  }
}

// 9 and 10. the app directory, which runs before any installer does.
{
  const payload = makePayload({ dotEntries: true });
  const out = temp('windows-app-');
  try {
    const app = path.join(out, 'app');
    fs.mkdirSync(path.join(app, 'runtime', 'host', 'node_modules', '@earendil-works', 'pi-ai', 'dist', 'providers', 'data'), { recursive: true });
    const copied = dotfiles(['--source', payload, '--prefix', 'runtime', '--app', app]);
    check('the copy into the app directory succeeds', copied.status === 0, copied.stderr);
    check('it copies every dotted file',
      fs.existsSync(path.join(app, 'runtime', 'host', 'node_modules', '@earendil-works', 'pi-ai', 'dist', 'providers', 'data', '.manifest.json'))
      && fs.existsSync(path.join(app, 'runtime', 'host', '.cache', 'inside.bin'))
      && fs.existsSync(path.join(app, 'runtime', 'host', '.hidden.txt')));
    check('it creates every dotted directory', fs.existsSync(path.join(app, 'runtime', 'host', '.empty')));
    const verified = dotfiles(['--source', payload, '--prefix', 'runtime', '--app', app, '--check']);
    check('a complete app directory passes the check', verified.status === 0, verified.stderr);
    check('the check says what it verified', /3 files, 2 directories, 0 missing, 0 different/.test(verified.stdout), verified.stdout);
    const filesOnly = dotfiles(['--source', payload, '--prefix', 'runtime', '--app', app, '--check', '--files-only']);
    check('a check of files only passes while the files are there', filesOnly.status === 0, filesOnly.stderr);
    check('it counts no directory as checked', /0 directories/.test(filesOnly.stdout), filesOnly.stdout);
    fs.rmSync(path.join(app, 'runtime', 'host', '.hidden.txt'));
    const missing = dotfiles(['--source', payload, '--prefix', 'runtime', '--app', app, '--check']);
    check('an app directory without them fails the check', missing.status === 1, String(missing.status));
    check('it names what is missing', /is missing 1 of them, starting with runtime\/host\/\.hidden\.txt/.test(missing.stderr), missing.stderr);
    fs.copyFileSync(path.join(payload, 'host', '.hidden.txt'), path.join(app, 'runtime', 'host', '.hidden.txt'));
    fs.writeFileSync(path.join(app, 'runtime', 'host', '.cache', 'inside.bin'), 'other bytes');
    const differing = dotfiles(['--source', payload, '--prefix', 'runtime', '--app', app, '--check']);
    check('an app directory with other content fails the check', differing.status === 1, String(differing.status));
    check('it names what differs', /different content, starting with runtime\/host\/\.cache\/inside\.bin/.test(differing.stderr), differing.stderr);
  } finally {
    drop(out, payload);
  }
}

// 11. the installer include: the macro is what puts those files into an installer, so
// deleting it has to stop a build instead of shipping an app without them.
{
  const makensis = have('makensis');
  const sevenzip = have('7z');
  if (!makensis) {
    skip('the include compiles with the macro', 'makensis is not installed');
    skip('a deleted macro stops the installer', 'makensis is not installed');
  } else {
    const payload = makePayload({ dotEntries: true });
    const layout = temp('windows-include-');
    try {
      const app = path.join(layout, 'app');
      fs.mkdirSync(path.join(app, 'installer'), { recursive: true });
      fs.copyFileSync(installerInclude, path.join(app, 'installer', 'windows.nsh'));
      fs.mkdirSync(path.join(app, 'resources', 'windows-amd64'), { recursive: true });
      fs.writeFileSync(path.join(app, 'resources', 'windows-amd64', 'MicrosoftEdgeWebview2Setup.exe'), 'MZ bootstrapper fixture');
      fs.mkdirSync(path.join(app, 'resources', 'redist'), { recursive: true });
      fs.writeFileSync(path.join(app, 'resources', 'redist', 'vc_redist.x64.exe'), 'MZ redist fixture');
      const macro = path.join(app, 'build', 'installer-dotfiles.nsh');
      const prepared = dotfiles(['--source', payload, '--prefix', 'runtime', '--macro', macro]);
      check('the macro for the include is written', prepared.status === 0, prepared.stderr);
      const probe = path.join(layout, 'probe.nsi');
      const script = [
        'Unicode true',
        'SetCompressor zlib',
        'SetCompress off',
        'Name "dotfiles probe"',
        'OutFile ' + JSON.stringify(path.join(layout, 'probe-setup.exe')),
        'InstallDir "$TEMP\\probe"',
        'RequestExecutionLevel user',
        '!include "MUI2.nsh"',
        '!include ' + JSON.stringify(path.join(app, 'installer', 'windows.nsh')),
        'Section',
        '  !insertmacro customInstall',
        'SectionEnd',
        '',
      ].join('\n');
      fs.writeFileSync(probe, script);
      const built = spawnSync('makensis', ['-V1', probe], { encoding: 'utf8' });
      check('the include compiles with the macro', built.status === 0, (built.stdout || '') + (built.stderr || ''));
      if (sevenzip) {
        const listed = spawnSync(sevenzip, ['l', '-slt', path.join(layout, 'probe-setup.exe')], { encoding: 'utf8' });
        const entries = (listed.stdout.match(/^Path = .*$/gm) ?? []).join('\n');
        check('the installer carries every dotted file',
          entries.includes('runtime/host/node_modules/@earendil-works/pi-ai/dist/providers/data/.manifest.json')
          && entries.includes('runtime/host/.cache/inside.bin')
          && entries.includes('runtime/host/.hidden.txt'), entries);
      } else {
        skip('the installer carries every dotted file', '7z is not installed');
      }
      fs.rmSync(macro);
      const without = spawnSync('makensis', ['-V1', probe], { encoding: 'utf8' });
      const said = (without.stdout || '') + (without.stderr || '');
      check('a deleted macro stops the installer', without.status !== 0, String(without.status));
      check('it says the macro is missing, and what writes it',
        /installer-dotfiles\.nsh is missing/.test(said) && /build-mygo-win\.sh/.test(said), said);
    } finally {
      drop(layout, payload);
    }
  }
}

// 12. the command lines.
{
  const payload = makePayload();
  const out = temp('windows-cli-');
  try {
    const noSource = dotfiles(['--prefix', 'runtime']);
    check('the dotfile staging needs --source', noSource.status === 1 && /--source is required/.test(noSource.stderr), noSource.stderr);
    const unknown = dotfiles(['--source', payload, '--nonsense', '1']);
    check('an unknown flag exits 1', unknown.status === 1 && /unknown flag --nonsense/.test(unknown.stderr), unknown.stderr);
    const checkWithoutApp = dotfiles(['--source', payload, '--check']);
    check('--check without --app exits 1', checkWithoutApp.status === 1 && /--check needs --app/.test(checkWithoutApp.stderr), checkWithoutApp.stderr);
    const unknownPlatform = stage(payload, 'linux-x64', path.join(out, 'linux'));
    check('a target the payload cannot serve exits 1', unknownPlatform.status === 1, String(unknownPlatform.status));
  } finally {
    drop(out, payload);
  }
}

console.log('windows-payload: ' + checks + ' checks ok' + (skipped === 0 ? '' : ', ' + skipped + ' skipped'));
