/**
 * i18n-audit.mjs 纯函数单测（PR #56 评审 L5）：stripComments / scanCjk /
 * deriveNamespace / diffKeySets / diffPlaceholders 是门禁引擎的核心，此前
 * 零覆盖——状态机回归会静默放行坏键位。CLI 冒烟（--check exit 0）由 CI 的
 * pnpm i18n:check 步骤兜底，这里只测纯函数。
 */
import { describe, expect, it } from 'vitest'
import { stripComments, scanCjk, deriveNamespace, diffKeySets, diffPlaceholders } from './i18n-audit.mjs'

describe('stripComments', () => {
  it('行注释/块注释清空，字符串内容保留', () => {
    const { code, comments } = stripComments('// i18n-allow: 注释\nconst a = "中文"; /* 注 */')
    expect(code).not.toContain('i18n-allow')
    expect(code).toContain('"中文"')
    expect(comments).toHaveLength(2)
  })

  it('字符串内的引号/斜杠不开假注释（状态机）', () => {
    const { code } = stripComments(`const re = /a"b/; const s = "中文//x";`)
    expect(code).toContain('"中文//x"')
  })

  it('模板插值恢复 code 状态', () => {
    const { code } = stripComments('const s = `${a} 中文 ${b}`;')
    expect(code).toContain('中文')
  })

  it('正则字面量内的 \\/\\/ 不再被误读为行注释（评审 L5 复现例）', () => {
    // /x\/\/y/ 曾让状态机把第二个 \/ 当 //，把行内后续真字符串注释掉 → CJK 漏检
    const src = 'const re = /x\\/\\/y/; const s = "中文";'
    expect(scanCjk(src).hits).toHaveLength(1)
    // 除号不受影响
    expect(scanCjk('const d = a / b; const s = "中文";').hits).toHaveLength(1)
  })
})

describe('scanCjk', () => {
  it('代码内 CJK 命中，注释内不命中', () => {
    const { hits } = scanCjk('const a = "中文"; // 注释中文\nconst b = 1;')
    expect(hits).toEqual([{ line: 1, text: expect.stringContaining('中文') }])
  })

  it('行级豁免只认注释内的 i18n-allow（评审 L5：字符串内标记不再生效）', () => {
    const inComment = scanCjk('const a = "工具"; // i18n-allow: 数据谓词')
    expect(inComment.allowedLines).toEqual([1])
    expect(inComment.hits).toEqual([])

    const inString = scanCjk('const el = <div title="i18n-allow: 工具提示">x</div>;')
    expect(inString.allowedLines).toEqual([])
    expect(inString.hits).toHaveLength(1)
  })

  it('头部注释块 i18n-allow → 整文件豁免；代码行后的标记不算', () => {
    const leading = scanCjk('/** i18n-allow: 纯数据 */\nconst a = "中文";')
    expect(leading.fileExempt).toBe(true)

    const afterCode = scanCjk('const a = 1; /** i18n-allow: 晚了 */\nconst b = "中文";')
    expect(afterCode.fileExempt).toBe(false)
    expect(afterCode.hits).toHaveLength(1)
  })
})

describe('deriveNamespace', () => {
  it('单引号字面量、双引号字面量（评审 L5 崩溃例）、const 标识符三种形式', () => {
    expect(deriveNamespace(`ctx.locale.register('dshtrading.a', dict)`)).toBe('dshtrading.a')
    expect(deriveNamespace(`ctx.locale.register("dshtrading.b", dict)`)).toBe('dshtrading.b')
    expect(deriveNamespace("const NS = 'dshtrading.c'\nctx.locale.register(NS, dict)")).toBe('dshtrading.c')
  })

  it('无法解析 → undefined（loadPackages fail-closed）', () => {
    expect(deriveNamespace('ctx.locale.register(someExpr, dict)')).toBeUndefined()
  })
})

describe('diffKeySets / diffPlaceholders', () => {
  it('键位差集双向报告', () => {
    const d = diffKeySets({ a: '1', b: '2' }, { b: '2', c: '3' })
    expect(d.missingInB).toEqual(['a'])
    expect(d.missingInA).toEqual(['c'])
  })

  it('占位符差集捕获 {name} 不对齐', () => {
    const d = diffPlaceholders({ k: 'Hi {name}' }, { k: 'Hi {nome}' })
    expect(d).toEqual([{ key: 'k', onlyA: ['name'], onlyB: ['nome'] }])
  })
})