/**
 * 缺省 home 告警（B 方案）：解析到 ~/.dsh 且本机存在 ~/.dsh-trading 时告警一次，
 * **返回值与优先级完全不变**（改默认值属架构决策，另议）。
 */
import { describe, expect, it } from 'vitest'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { defaultDshHome, dshHomeDir } from '../src/index.ts'

/** 本机是否存在 trading home（决定告警是否应当出现）。 */
const tradingHome = resolve(homedir(), '.dsh-trading')
const hasTradingHome = existsSync(tradingHome)

describe('缺省 home 告警', () => {
  it('管理员：未设 DSH_HOME 且本机有 trading home 时告警，且返回值不变', () => {
    // Given 一个收集器与一个没设 DSH_HOME 的环境
    const messages: string[] = []
    // When 解析两次
    const first = dshHomeDir({}, { warn: (message) => messages.push(message) })
    const second = dshHomeDir({}, { warn: (message) => messages.push(message) })
    // Then 返回值仍是缺省 home（**语义不变**）
    expect(first).toBe(defaultDshHome())
    expect(second).toBe(first)
    if (hasTradingHome) {
      // 且每次都通知注入的出口（去重只发生在 stderr 默认出口）
      expect(messages).toHaveLength(2)
      expect(messages[0]).toContain('交易数据可能正被写到宿主 home')
      expect(messages[0]).toContain('不影响返回值')
    } else {
      // 本机没有 trading home 就不该告警（不制造噪音）
      expect(messages).toHaveLength(0)
    }
  })

  it('管理员：显式 DSH_HOME 指向 trading home 时不告警（正常路径必须安静）', () => {
    // Given 显式指向 trading home 的环境
    const messages: string[] = []
    // When 解析
    const resolved = dshHomeDir({ DSH_HOME: '~/.dsh-trading' }, { warn: (message) => messages.push(message) })
    // Then 解析正确且无告警
    expect(resolved).toBe(tradingHome)
    expect(messages).toHaveLength(0)
  })

  it('管理员：显式 DSH_HOME 指向别的目录时不告警（那是用户的选择，不是误用）', () => {
    // Given 显式指向临时目录
    const messages: string[] = []
    // When 解析
    const resolved = dshHomeDir({ DSH_HOME: '/tmp/some-other-home' }, { warn: (message) => messages.push(message) })
    // Then 尊重该值且不告警
    expect(resolved).toBe('/tmp/some-other-home')
    expect(messages).toHaveLength(0)
  })

  it('管理员：空白 DSH_HOME 视为未设（与既有语义一致，仍走告警判定）', () => {
    // Given 一个只有空白的 DSH_HOME
    const messages: string[] = []
    // When 解析
    const resolved = dshHomeDir({ DSH_HOME: '   ' }, { warn: (message) => messages.push(message) })
    // Then 视为未设 ⇒ 缺省 home，且告警判定照旧
    expect(resolved).toBe(defaultDshHome())
    expect(messages.length).toBe(hasTradingHome ? 1 : 0)
  })
})
