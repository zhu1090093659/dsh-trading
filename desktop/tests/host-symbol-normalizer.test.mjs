import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { normalizeScopeSymbol } from '../src/host-symbol-normalizer.mjs';

test('normalizeScopeSymbol rewrites the per-instance scope tag', () => {
  const source = 'const kScope = Symbol("dsh.scope");\nexport function scopeOf(ctx) { return ctx[kScope]; }';
  assert.match(
    normalizeScopeSymbol(source),
    /const kScope = Symbol\.for\("dsh\.scope"\);/,
  );
});

test('normalizeScopeSymbol rewrites every occurrence', () => {
  const source = 'Symbol("dsh.scope"); Symbol("dsh.scope");';
  assert.equal(normalizeScopeSymbol(source).match(/Symbol\.for\("dsh\.scope"\)/g).length, 2);
});

test('normalizeScopeSymbol leaves unrelated sources untouched', () => {
  const untouched = 'const other = Symbol("dsh.other"); export {};';
  assert.equal(normalizeScopeSymbol(untouched), untouched);
});

test('the loader ships next to main.cjs and is unpacked by electron-builder', () => {
  const loaderPath = path.join(import.meta.dirname, '..', 'src', 'host-symbol-normalizer.mjs');
  assert.ok(fs.existsSync(loaderPath), 'loader file must exist in src/');
  const builderConfig = fs.readFileSync(path.join(import.meta.dirname, '..', 'electron-builder.yml'), 'utf8');
  assert.ok(
    builderConfig.includes('src/host-symbol-normalizer.mjs'),
    'asarUnpack must list the loader so the external Node runtime can import it',
  );
});

test('the loader can be loaded by Node via --import using a file:// specifier', async () => {
  const { spawnSync } = await import('node:child_process');
  const { pathToFileURL } = await import('node:url');
  const loaderPath = path.join(import.meta.dirname, '..', 'src', 'host-symbol-normalizer.mjs');
  const importSpecifier = pathToFileURL(loaderPath).href;

  const result = spawnSync(process.execPath, ['--import', importSpecifier, '-e', 'console.log("loader-ok")'], {
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, 'process should exit with 0, stderr: ' + result.stderr);
  assert.match(result.stdout, /loader-ok/);
});

