#!/usr/bin/env node
'use strict';

/**
 * Download the official Microsoft Visual C++ 2015-2022 Redistributable (x64)
 * installer for Windows packaging, saved under desktop/resources/redist/vc_redist.x64.exe.
 *
 * Usage: node scripts/fetch-redist.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VC_REDIST_URL = 'https://aka.ms/vs/17/release/vc_redist.x64.exe';
const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(desktopDir, 'resources', 'redist');
const targetFile = path.join(outDir, 'vc_redist.x64.exe');

async function main() {
  if (process.env.SKIP_FETCH_REDIST === '1') {
    console.log('[fetch-redist] SKIP_FETCH_REDIST is set, skipping download.');
    return;
  }

  // If already exists and valid size (> 10MB), skip download
  if (fs.existsSync(targetFile)) {
    const stats = fs.statSync(targetFile);
    if (stats.size > 10 * 1024 * 1024) {
      console.log(`[fetch-redist] vc_redist.x64.exe already present (${Math.round(stats.size / (1024 * 1024))} MB), skipping.`);
      return;
    }
  }

  fs.mkdirSync(outDir, { recursive: true });
  console.log(`[fetch-redist] downloading ${VC_REDIST_URL} ...`);
  try {
    const response = await fetch(VC_REDIST_URL, { redirect: 'follow' });
    if (!response.ok) {
      throw new Error(`HTTP error ${response.status} ${response.statusText}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length < 5 * 1024 * 1024) {
      throw new Error(`Downloaded file seems too small (${buffer.length} bytes)`);
    }
    fs.writeFileSync(targetFile, buffer);
    console.log(`[fetch-redist] successfully saved to ${path.relative(desktopDir, targetFile)} (${Math.round(buffer.length / (1024 * 1024))} MB)`);
  } catch (error) {
    if (fs.existsSync(targetFile)) {
      console.warn(`[fetch-redist] download failed (${error.message}), but an existing file is present. Keeping existing file.`);
    } else {
      console.error(`[fetch-redist] error downloading VC++ redistributable: ${error.message}`);
      if (process.env.STRICT_FETCH_REDIST === '1') {
        process.exitCode = 1;
      } else {
        console.warn('[fetch-redist] continuing build without bundled redist. NSIS will skip redist if not found.');
      }
    }
  }
}

main();
