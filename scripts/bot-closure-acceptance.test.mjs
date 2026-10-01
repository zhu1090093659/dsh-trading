/**
 * bot-closure-acceptance.mjs 纯函数自测。
 *
 * 这条验收的对象是「装出来的 node_modules」——本机没有安装态时它会 exit 2（不可跑），
 * 所以至少要证明判据本身会红：AC1/AC2/AC3 各一条反例 + 一条干净通过 + 真实目录读取。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { checkClosure, directorySize, installedPackages } from './bot-closure-acceptance.mjs'

const tempDirs = []
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'bot-closure-test-'))
  tempDirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('installedPackages', () => {
  it('管理员：作用域包展开为 @scope/name，点目录与文件被忽略', () => {
    // Given 一个含作用域目录、普通目录与一个文件的 node_modules
    const dir = tempDir()
    mkdirSync(join(dir, 'node_modules/@dshtrading/base'), { recursive: true })
    mkdirSync(join(dir, 'node_modules/@dshtrading/client-ui-trading'), { recursive: true })
    mkdirSync(join(dir, 'node_modules/yaml'), { recursive: true })
    mkdirSync(join(dir, 'node_modules/.bin'), { recursive: true })
    writeFileSync(join(dir, 'node_modules/.package-lock.json'), '{}')
    // When 列出安装包
    const packages = installedPackages(dir)
    // Then 只得到作用域展开后的两个包名与普通包名
    expect(packages).toEqual(['@dshtrading/base', '@dshtrading/client-ui-trading', 'yaml'])
  })
})

describe('checkClosure（AC1 / AC2 / AC3）', () => {
  it('管理员：闭包里出现 client-ui-* 时报 AC1 与 AC3', () => {
    // Given 一个被 GUI 平面污染的安装集合
    const { problems } = checkClosure(['@dshtrading/base', '@dshtrading/client-ui-trading'])
    // When 检查
    // Then 同时命中 AC1（前缀）与 AC3（@dshtrading 集合里出现 GUI 平面包）
    expect(problems.map((p) => p.rule).sort()).toEqual(['AC1', 'AC3'])
  })

  it('管理员：闭包里出现 UI 重依赖时报 AC2', () => {
    // Given 一个拖了渲染栈的安装集合
    const { problems } = checkClosure(['@dshtrading/bot-api', 'lightweight-charts', 'react'])
    // When 检查
    const rules = problems.map((p) => p.rule)
    // Then 两条 AC2（react-dom 不在集合里，所以只有两条）
    expect(rules).toEqual(['AC2', 'AC2'])
    expect(problems.map((p) => p.detail).join(' ')).toContain('lightweight-charts')
  })

  it('管理员：干净闭包不报红', () => {
    // Given 只有 host/bot 平面包与普通依赖
    const { problems } = checkClosure(['@dshtrading/base', '@dshtrading/bot-api', '@dshtrading/bot', 'yaml', 'undici'])
    // When 检查
    // Then 零问题
    expect(problems).toEqual([])
  })
})

describe('directorySize', () => {
  it('管理员：递归统计常规文件字节，符号链接不计入', () => {
    // Given 两层目录与一个指向外部的符号链接
    const dir = tempDir()
    mkdirSync(join(dir, 'nested'), { recursive: true })
    writeFileSync(join(dir, 'a.txt'), 'x'.repeat(100))
    writeFileSync(join(dir, 'nested/b.txt'), 'y'.repeat(50))
    // When 统计体积
    const size = directorySize(dir)
    // Then 恰好等于两个文件之和
    expect(size).toBe(150)
  })
})
