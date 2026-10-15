import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

/** 启动期页面：由主进程以 file:// 加载，各自带 CSP meta。 */
const PAGES = ['splash.html', 'error.html'];

function readPage(page) {
  return fs.readFileSync(path.join(SOURCE_DIR, page), 'utf8');
}

test('管理员改启动页时不会重新引入被 CSP 拦掉的 inline 脚本', () => {
  // Given the two shell pages and the CSP they ship with
  // When their markup is scanned for executable inline code
  const offenders = [];
  for (const page of PAGES) {
    const html = readPage(page);
    for (const tag of html.match(/<script\b[^>]*>/gi) ?? []) {
      if (!/\bsrc\s*=/.test(tag)) offenders.push(page + ' inline <script>');
    }
    for (const attr of html.match(/\son[a-z]+\s*=/gi) ?? []) offenders.push(page + ' inline handler ' + attr.trim());
  }

  // Then nothing on these pages needs inline script execution, which their CSP never allows
  assert.deepEqual(offenders, []);
  for (const page of PAGES) {
    assert.match(readPage(page), /http-equiv="Content-Security-Policy"/);
  }
});

test('用户看到的状态与报错文案来自随包分发的页面脚本文件', () => {
  // Given both pages load their behaviour from an external script
  // When the referenced files are resolved next to the page
  const resolved = PAGES.map((page) => {
    const match = /<script\s+src="\.\/([^"]+)"/.exec(readPage(page));
    return match === null ? undefined : path.join(SOURCE_DIR, match[1]);
  });

  // Then each file exists, is non-empty, and talks to the preload bridge
  assert.deepEqual(resolved.filter((file) => file === undefined), []);
  for (const file of resolved) {
    assert.ok(fs.existsSync(file), file + ' must exist');
    assert.ok(fs.statSync(file).size > 0, file + ' must not be empty');
    assert.match(fs.readFileSync(file, 'utf8'), /window\.desktop/);
  }
});
