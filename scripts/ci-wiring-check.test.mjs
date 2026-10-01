/**
 * ci-wiring-check 自测（进 test:scripts，纯 JS）：夹具驱动，验证它**真的会报错**、
 * 且**按 working-directory 解析文件路径**（第一版没做，误报过 desktop-release.yml）。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const dirs = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** 造一个夹具目录：files 的键是相对路径、值是内容。 */
function fixture(files) {
  const dir = mkdtempSync(join(tmpdir(), 'ci-wiring-'))
  dirs.push(dir)
  for (const [relative, content] of Object.entries(files)) {
    const target = join(dir, relative)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, content)
  }
  return dir
}

function check(dir, workflow) {
  return spawnSync(process.execPath, ['scripts/ci-wiring-check.mjs', '--package', join(dir, 'package.json'), '--workflow', join(dir, workflow)], {
    cwd: ROOT,
    encoding: "utf8",
  })
}

/** 用真实换行拼 YAML（不能用 String.raw：里面的 \\n 是两个字面字符）。 */
function yaml(rows) {
  return rows.join(String.fromCharCode(10)) + String.fromCharCode(10)
}

describe('CI 接线检查', () => {
  it('管理员：引用不存在的 pnpm 脚本 ⇒ 报错并非零退出', () => {
    // Given 一个引用了不存在脚本的 workflow
    const dir = fixture({
      'package.json': JSON.stringify({ scripts: { 'test:audit': 'vitest run' } }),
      'ci.yml': yaml(['jobs:', '  a:', '    steps:', '      - run: pnpm test:audit', '      - run: pnpm no-such-script']),
    })
    // When 检查
    const result = check(dir, 'ci.yml')
    // Then 明确指出断在哪
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('no-such-script')
  })

  it('管理员：node 脚本按 working-directory 解析（子目录里的脚本不算断裂）', () => {
    // Given 在子目录工作、脚本也在子目录
    const dir = fixture({
      'package.json': JSON.stringify({ scripts: {} }),
      'desktop/scripts/verify-runtime-toolchain.mjs': '// 存在即可\n',
      'release.yml': yaml(['jobs:', '  a:', '    steps:', '      - name: verify', '        working-directory: desktop', '        run: node scripts/verify-runtime-toolchain.mjs']),
    })
    // When 检查
    const result = check(dir, 'release.yml')
    // Then 不报错（这是第一版误报过的形态）
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('接线完整')
  })

  it('管理员：working-directory 下的缺失脚本仍要报错（别把守卫修成永真）', () => {
    // Given 子目录工作但脚本不存在
    const dir = fixture({
      'package.json': JSON.stringify({ scripts: {} }),
      'release.yml': yaml(['jobs:', '  a:', '    steps:', '      - name: verify', '        working-directory: desktop', '        run: node scripts/missing-script.mjs']),
    })
    // When 检查
    const result = check(dir, 'release.yml')
    // Then 仍然报错，且路径按子目录拼出来
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('desktop/scripts/missing-script.mjs')
  })
})
