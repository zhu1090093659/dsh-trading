#!/usr/bin/env node
'use strict';

/**
 * Download the Microsoft Edge WebView2 Evergreen Bootstrapper the mygo Windows
 * installer ships.
 *
 * desktop/mygo/installer/windows.nsh embeds it in the installer and runs it
 * (/silent /install) when the runtime is missing, so the file has to be in place
 * before `mygo build -platform windows/amd64`; makensis stops with the message
 * this script prints when it is not, and scripts/build-mygo-win.sh runs this
 * script first.
 *
 * The bootstrapper is a Microsoft download, not a build output, and it is pinned
 * by SHA-256 here: a swapped or truncated file never reaches an installer, and a
 * file that already matches the pin is never downloaded again (the second run
 * prints the pin and does not touch the network).
 *
 * Microsoft republishes the bootstrapper behind the same fwlink as the runtime
 * changes, so a mismatch is told apart from a truncated download: the measured
 * hash is printed together with the line to change, and nothing is installed
 * over a file that does not match.
 *
 * Usage:
 *   node scripts/fetch-webview2.mjs [--verify-only]
 *
 * --verify-only never downloads: it checks the file in place and fails when it
 * is missing or does not match the pin, which is what a build that must not
 * reach the network runs.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BOOTSTRAPPER_URL = 'https://go.microsoft.com/fwlink/p/?LinkId=2124703';

/**
 * The SHA-256 of the bootstrapper the installer embeds, measured on the file
 * Microsoft served on 2026-11-06 (1,897,688 bytes, PE32 i386). The fwlink serves
 * a newer bootstrapper when the runtime moves on: re-measure, then change this
 * line, which is the only place the expectation lives.
 */
const BOOTSTRAPPER_SHA256 = 'cf2f2445fef0c5c14e372045f84998771eeb8bb01d59be4afd00692fa160082e';

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const targetFile = path.join(desktopDir, 'mygo', 'resources', 'windows-amd64', 'MicrosoftEdgeWebview2Setup.exe');

/** The SHA-256 of a buffer, in lower case hex. */
function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/** The SHA-256 of a file, in lower case hex. */
function hashFile(file) {
  return sha256(fs.readFileSync(file));
}

/** The path as the repository prints it. */
function relative(target) {
  const rel = path.relative(desktopDir, target);
  return rel.startsWith('..') ? target : rel;
}

/**
 * Why the file at target is not the pinned bootstrapper, or "" when it is. A
 * missing file is not an error to read: the caller decides whether to download.
 */
function mismatch(target) {
  if (!fs.existsSync(target)) return 'it is not there';
  const actual = hashFile(target);
  if (actual === BOOTSTRAPPER_SHA256) return '';
  return 'its SHA-256 is ' + actual + ', not the pinned ' + BOOTSTRAPPER_SHA256;
}

/**
 * The bytes at url: Node's fetch first, which is what the other fetch-*.mjs
 * scripts use, and curl otherwise.
 *
 * The fallback is not symmetry: on the machine this was written on,
 * go.microsoft.com resolves to an unreachable IPv6 address and to a working IPv4
 * one, fetch answers "fetch failed" from Node's connection setup (ETIMEDOUT after
 * 253 ms, which no retry changes), and curl reaches the same URL. curl is on
 * macOS, on Windows 10 1803 and later, and on every Linux CI image.
 */
async function fetchBytes(url) {
  try {
    const response = await fetch(url, { redirect: 'follow' });
    if (!response.ok) throw new Error('download failed: ' + response.status + ' ' + response.statusText);
    return Buffer.from(await response.arrayBuffer());
  } catch (error) {
    console.log('[fetch-webview2] fetch could not download it (' + String(error && error.message ? error.message : error)
      + '), retrying with curl');
    return execFileSync('curl', ['-fsSL', '--max-time', '600', url], { maxBuffer: 64 * 1024 * 1024 });
  }
}

/**
 * Download the bootstrapper into target, through a temporary file beside it:
 * a download that fails or does not match the pin leaves neither a partial file
 * nor a wrong one behind.
 */
async function download(target) {
  const body = Buffer.from(await fetchBytes(BOOTSTRAPPER_URL));
  const actual = sha256(body);
  if (actual !== BOOTSTRAPPER_SHA256) {
    throw new Error(
      'the download does not match the pinned bootstrapper: its SHA-256 is ' + actual
      + ' (' + body.length + ' bytes), not ' + BOOTSTRAPPER_SHA256 + '. Microsoft has published a new one, '
      + 'or the transfer was cut: if the file is a complete PE32 executable, measure it again and set '
      + 'BOOTSTRAPPER_SHA256 in ' + relative(fileURLToPath(import.meta.url)) + ' to that value; nothing was written.',
    );
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const partial = target + '.download';
  fs.writeFileSync(partial, body);
  fs.renameSync(partial, target);
  return body.length;
}

async function main() {
  const argv = process.argv.slice(2);
  let verifyOnly = false;
  for (const flag of argv) {
    if (flag === '--verify-only') verifyOnly = true;
    else throw new Error('unknown flag ' + flag + ' (usage: fetch-webview2.mjs [--verify-only])');
  }

  const problem = mismatch(targetFile);
  if (problem === '') {
    console.log('[fetch-webview2] the pinned bootstrapper is in place: ' + relative(targetFile)
      + ' (' + fs.statSync(targetFile).size + ' bytes, sha256 ' + BOOTSTRAPPER_SHA256 + ')');
    return;
  }
  if (verifyOnly) {
    throw new Error(relative(targetFile) + ' is not the pinned bootstrapper: ' + problem
      + ' (run scripts/fetch-webview2.mjs to download it)');
  }

  console.log('[fetch-webview2] ' + relative(targetFile) + ' cannot be used: ' + problem);
  console.log('[fetch-webview2] downloading ' + BOOTSTRAPPER_URL);
  const bytes = await download(targetFile);
  console.log('[fetch-webview2] saved ' + relative(targetFile) + ' (' + bytes + ' bytes, sha256 ' + BOOTSTRAPPER_SHA256 + ')');
}

try {
  await main();
} catch (error) {
  console.error('[fetch-webview2] ' + String(error && error.message ? error.message : error));
  process.exitCode = 1;
}
