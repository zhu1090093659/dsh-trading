/**
 * scripts/test-audit.mjs 自测：门禁引擎的解析与棘轮比较此前零覆盖——解析漏报
 * 等于门禁静默失效（放行坏用例还报绿）。这里只测导出的纯逻辑 auditRepo /
 * compare；CLI 的 --check exit code 由 CI 的 pnpm test:audit 步骤兜底。
 *
 * 本文件是 scripts/test-audit.mjs 唯一豁免扫描的测试文件：夹具必须内联真实违规
 * 样本，否则无法证明规则能命中。
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { auditRepo, compare } from './test-audit.mjs'

const roots = []

/** 在临时根下铺一个 packages/demo/test/*.ts 夹具仓。 */
function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'test-audit-'))
  roots.push(root)
  for (const [rel, src] of Object.entries(files)) {
    const full = join(root, rel)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, src)
  }
  return root
}

function rulesOf(root) {
  return auditRepo(root).rules
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('test-audit 规则解析', () => {
  it('operator 通用 mock 工具调用计入 mock 规则', () => {
    // Given: 一个用 vi.fn 打桩的测试文件
    const root = fixture({
      'packages/demo/test/mock.test.ts': "import { vi } from 'vitest'\nconst a = vi.fn()\nconst b = vi.fn()\n",
    })

    // When: 跑审计
    const rules = rulesOf(root)

    // Then: 两次调用都被计数
    expect(rules.mock).toBe(2)
  })

  it('operator 定时器推迟计入 sleep 规则，setImmediate 不计入', () => {
    // Given: 一个同时用 setTimeout 与 setImmediate 的测试文件
    const root = fixture({
      'packages/demo/test/sleep.test.ts':
        "await new Promise(r => setTimeout(r, 10))\nawait new Promise(r => setImmediate(r))\n",
    })

    // When: 跑审计
    const rules = rulesOf(root)

    // Then: 只有按时间等待被计数（setImmediate 只是让出事件循环，不是等待）
    expect(rules.sleep).toBe(1)
  })

  it('operator 标题缺角色前缀与正文缺 Given/When/Then 分别计数', () => {
    // Given: 一条既无角色前缀、正文也无 BDD 标记的无断言用例
    const root = fixture({ 'packages/demo/test/bad.test.ts': "it('returns 42', () => { const x = 42 })\n" })

    // When: 跑审计
    const rules = rulesOf(root)

    // Then: 三条结构规则各命中一次
    expect(rules['bdd-title']).toBe(1)
    expect(rules['bdd-gwt']).toBe(1)
    expect(rules['weak-assert']).toBe(1)
  })

  it('operator 标题带角色前缀、正文含 Given/When/Then 且有断言时全部通过', () => {
    // Given: 一条完全合规的用例（角色前缀 + 三段标记 + 断言）
    const root = fixture({
      'packages/demo/test/good.test.ts':
        "it('user 下单成功', () => {\n  // Given: 余额充足\n  // When: 下单\n  // Then: 余额扣减\n  expect(1).toBe(1)\n})\n",
    })

    // When: 跑审计
    const rules = rulesOf(root)

    // Then: 无任何规则命中
    expect(rules).toEqual({ mock: 0, sleep: 0, 'bdd-title': 0, 'bdd-gwt': 0, 'weak-assert': 0 })
  })

  it('operator it.each 的第二组括号标题也能被解析', () => {
    // Given: 一个 it.each 形态的合规用例
    const root = fixture({
      'packages/demo/test/each.test.ts':
        "it.each(['a'])(\"operator %s 场景\", () => {\n  // Given/When/Then\n  expect(1).toBe(1)\n})\n",
    })

    // When: 跑审计
    const rules = rulesOf(root)

    // Then: 标题被正确识别为合规，不产生 bdd-title 计数
    expect(rules['bdd-title']).toBe(0)
  })

  it('operator 断言封装在 expect 前缀辅助函数里不被误报为无用例断言', () => {
    // Given: 断言封装在 expect* 辅助函数里的用例
    const root = fixture({
      'packages/demo/test/helper.test.ts':
        "it('operator 辅助断言', () => {\n  // Given/When/Then\n  expectParity(a, b)\n})\n",
    })

    // When: 跑审计
    const rules = rulesOf(root)

    // Then: 不误报为 weak-assert
    expect(rules['weak-assert']).toBe(0)
  })
})

describe('test-audit 棘轮比较', () => {
  it('operator 规则总量上升被判为回归', () => {
    // Given: 基线 mock=1，现状 mock=2
    const baseline = { rules: { mock: 1, sleep: 0, 'bdd-title': 0, 'bdd-gwt': 0, 'weak-assert': 0 }, files: {} }
    const current = { rules: { mock: 2 }, files: {} }

    // When: 比较
    const regressions = compare(current, baseline)

    // Then: 报一条规则上升
    expect(regressions).toEqual([{ kind: 'rule', rule: 'mock', now: 2, was: 1 }])
  })

  it('operator 基线未记录的新文件带债被判为回归', () => {
    // Given: 基线无该文件，现状该文件有一条 mock
    const baseline = { rules: { mock: 0 }, files: {} }
    const current = { rules: { mock: 1 }, files: { 'packages/demo/test/new.test.ts': { mock: 1 } } }

    // When: 比较
    const regressions = compare(current, baseline)

    // Then: 规则上升与新文件带债各报一条
    expect(regressions).toContainEqual({ kind: 'new-file', file: 'packages/demo/test/new.test.ts', counts: { mock: 1 } })
  })

  it('operator 同一文件在清债后总量不变仍被判为回归', () => {
    // Given: 基线里 A 文件有 2 条、B 文件有 0 条；现状 A 清到 1 条、B 新增 1 条（总量持平）
    const baseline = {
      rules: { mock: 2 },
      files: { 'packages/demo/test/a.test.ts': { mock: 2 }, 'packages/demo/test/b.test.ts': { mock: 0 } },
    }
    const current = {
      rules: { mock: 2 },
      files: { 'packages/demo/test/a.test.ts': { mock: 1 }, 'packages/demo/test/b.test.ts': { mock: 1 } },
    }

    // When: 比较
    const regressions = compare(current, baseline)

    // Then: 总量持平掩盖不了单文件上升，必须精确报出该文件
    expect(regressions).toEqual([{ kind: 'file', file: 'packages/demo/test/b.test.ts', rule: 'mock', now: 1, was: 0 }])
  })
})

describe('test-audit 扫描树容错', () => {
  it('operator 扫描树里的悬空符号链接被跳过而不是让门禁崩溃', () => {
    // Given: 扫描根下一个指向不存在目标的符号链接（git-ignored 暂存物的常见形态）
    const root = fixture({
      'packages/demo/test/good.test.ts':
        "it('user 下单成功', () => {\n  // Given: 余额充足\n  // When: 下单\n  // Then: 余额扣减\n  expect(1).toBe(1)\n})\n",
    })
    symlinkSync(join(root, 'missing-target'), join(root, 'packages/demo/test/dangling.test.ts'))

    // When: 跑审计
    const report = auditRepo(root)

    // Then: 审计完成且只统计真实存在的用例文件，悬空链接被跳过
    expect(report.tests).toBe(1)
  })
})
