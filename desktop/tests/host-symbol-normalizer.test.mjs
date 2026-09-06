import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { normalizeHostSymbols } from '../src/host-symbol-normalizer.mjs';

test('normalizeHostSymbols rewrites the per-instance scope tag', () => {
  const source = 'const kScope = Symbol("dsh.scope");\nexport function scopeOf(ctx) { return ctx[kScope]; }';
  assert.match(
    normalizeHostSymbols(source),
    /const kScope = Symbol\.for\("dsh\.scope"\);/,
  );
});

test('normalizeHostSymbols rewrites the dsh-tools scheduler tag', () => {
  const source = 'const TOOL_RUNTIME_SCHEDULER = Symbol("@deepseek-ai/dsh-tools.scheduler");';
  assert.equal(
    normalizeHostSymbols(source),
    'const TOOL_RUNTIME_SCHEDULER = Symbol.for("@deepseek-ai/dsh-tools.scheduler");',
  );
});

test('normalizeHostSymbols rewrites every occurrence', () => {
  const source = 'Symbol("dsh.scope"); Symbol("dsh.scope");';
  assert.equal(normalizeHostSymbols(source).match(/Symbol\.for\("dsh\.scope"\)/g).length, 2);
});

test('normalizeHostSymbols leaves unrelated sources untouched', () => {
  const untouched = 'const other = Symbol("dsh.other"); export {};';
  assert.equal(normalizeHostSymbols(untouched), untouched);
});

test('normalizeHostSymbols leaves the per-call execution token untouched', () => {
  // dsh-tools mints this fresh per call as a correlation token whose identity
  // is its value; a registry rewrite would wrongly unify concurrent calls.
  const untouched = 'function createExecutionToken() {\n\treturn Symbol("dsh.tool.execution");\n}';
  assert.equal(normalizeHostSymbols(untouched), untouched);
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

test('two module copies minting a normalized tag share one symbol under the hook', async () => {
  // Faithful mini-reproduction of the split-instance incident: without the
  // hook each copy's Symbol(...) is unique, so a registry keyed under one
  // copy is invisible to the other; the hook routes both through the global
  // registry. Uses the dsh-tools scheduler literal as shipped.
  const { spawnSync } = await import('node:child_process');
  const { pathToFileURL } = await import('node:url');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-symbol-split-'));
  const fixture = 'export const TAG = Symbol("@deepseek-ai/dsh-tools.scheduler");\n';
  const copyA = path.join(dir, 'copy-a.mjs');
  const copyB = path.join(dir, 'copy-b.mjs');
  fs.writeFileSync(copyA, fixture);
  fs.writeFileSync(copyB, fixture);

  const probe = `
    const [{ TAG: a }, { TAG: b }] = await Promise.all([
      import(${JSON.stringify(pathToFileURL(copyA).href)}),
      import(${JSON.stringify(pathToFileURL(copyB).href)}),
    ]);
    console.log(a === b ? 'shared' : 'split');
  `;
  const loaderPath = path.join(import.meta.dirname, '..', 'src', 'host-symbol-normalizer.mjs');

  const withoutHook = spawnSync(process.execPath, ['--input-type=module', '-e', probe], { encoding: 'utf8' });
  assert.equal(withoutHook.stdout.trim(), 'split', 'unhooked copies must mint distinct symbols');

  const withHook = spawnSync(
    process.execPath,
    ['--import', pathToFileURL(loaderPath).href, '--input-type=module', '-e', probe],
    { encoding: 'utf8' },
  );
  assert.equal(withHook.status, 0, 'hooked process should exit 0, stderr: ' + withHook.stderr);
  assert.equal(withHook.stdout.trim(), 'shared', 'hook must route both copies through the registry');

  fs.rmSync(dir, { recursive: true, force: true });
});
