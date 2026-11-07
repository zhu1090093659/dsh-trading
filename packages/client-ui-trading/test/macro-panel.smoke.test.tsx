/**
 * MacroPanel 双数据源编排冒烟（2026-09-15 评审 M3/L1 回归）：经济数据（MCP 日历）与
 * 央行利率（网页版）各自记账——任一源失败只在自己那个页签出错误提示，绝不把「一个源
 * 挂了」画成「没有数据」；上游给负星号也不许炸掉整块面板。纯函数单测覆盖不到这层编排。
 *
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MarketLocaleKey } from '../src/client/contract.ts'

/** 桥面桩：null = 该源不可用（fetchMacro* 的真实失败语义）。 */
const net = vi.hoisted(() => ({
  calendar: null as Array<Record<string, unknown>> | null,
  rates: null as Array<Record<string, unknown>> | null,
}))

vi.mock('../src/client/api.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/client/api.ts')>()
  return {
    ...actual,
    fetchMacroCalendar: async () => net.calendar as never,
    fetchMacroRates: async () => net.rates as never,
  }
})

import { MacroPanel } from '../src/client/MacroPanel.tsx'

/** key 直出翻译（断言用 key 而非文案，与词典解耦）。 */
const t = (key: MarketLocaleKey): string => key

const cal = (region: string, title: string, extra: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ publishedAt: '2026-09-14T12:30:00.000Z', star: 3, region, title, ...extra })
const rate = (region: string, bankName: string): Record<string, unknown> =>
  ({ region, bankName, rate: '3.75', publishedAt: '2026-09-10' })

/** 两个 describe 共用：每例前清空桥面桩，每例后卸载（否则下一例 getByText 撞多份 DOM）。 */
beforeEach(() => {
  net.calendar = null
  net.rates = null
})
afterEach(() => cleanup())

describe('MacroPanel 双源状态与地区筛选', () => {
  it('默认只看美日中：日历与利率都按地区过滤，页签可切', async () => {
    net.calendar = [cal('美国', '美国9月核心CPI年率'), cal('德国', '德国8月CPI年率')]
    net.rates = [rate('日本', '日本央行'), rate('巴西', '巴西央行')]
    render(<MacroPanel t={t} onClose={() => {}} />)

    await waitFor(() => { expect(screen.queryByText('美国9月核心CPI年率')).not.toBeNull() })
    expect(screen.queryByText('德国8月CPI年率')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'macro.tab.rates' }))
    expect(screen.queryByText('日本央行')).not.toBeNull()
    expect(screen.queryByText('巴西央行')).toBeNull()
  })

  it('切到「全部」后放开地区过滤', async () => {
    net.calendar = [cal('美国', '美国9月核心CPI年率'), cal('德国', '德国8月CPI年率')]
    net.rates = []
    render(<MacroPanel t={t} onClose={() => {}} />)
    await waitFor(() => { expect(screen.queryByText('美国9月核心CPI年率')).not.toBeNull() })

    fireEvent.click(screen.getByRole('button', { name: 'macro.regionAll' }))
    expect(screen.queryByText('德国8月CPI年率')).not.toBeNull()
  })

  it('只有利率失败：利率页签出错误提示、不冒充空数据；日历页签照常', async () => {
    net.calendar = [cal('美国', '美国9月核心CPI年率')]
    net.rates = null
    render(<MacroPanel t={t} onClose={() => {}} />)
    await waitFor(() => { expect(screen.queryByText('美国9月核心CPI年率')).not.toBeNull() })
    expect(screen.queryByText('macro.error')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'macro.tab.rates' }))
    await waitFor(() => { expect(screen.queryByText('macro.error')).not.toBeNull() })
    expect(screen.queryByText('macro.empty')).toBeNull()
  })

  it('只有日历失败：日历页签出错误提示，利率页签照常出数据', async () => {
    net.calendar = null
    net.rates = [rate('美国', '美国联邦储备局')]
    render(<MacroPanel t={t} onClose={() => {}} />)

    await waitFor(() => { expect(screen.queryByText('macro.error')).not.toBeNull() })
    fireEvent.click(screen.getByRole('button', { name: 'macro.tab.rates' }))
    await waitFor(() => { expect(screen.queryByText('美国联邦储备局')).not.toBeNull() })
    expect(screen.queryByText('macro.error')).toBeNull()
  })

  it('两源都可用但过滤后为空 → 空态文案（不是错误）', async () => {
    net.calendar = [cal('德国', '德国8月CPI年率')]
    net.rates = []
    render(<MacroPanel t={t} onClose={() => {}} />)
    await waitFor(() => { expect(screen.queryByText('macro.empty')).not.toBeNull() })
    expect(screen.queryByText('macro.error')).toBeNull()
  })

  it('负星号不炸面板（repeat 前夹到 [0,5]）', async () => {
    net.calendar = [cal('美国', '美国9月核心CPI年率', { star: -1 })]
    net.rates = []
    render(<MacroPanel t={t} onClose={() => {}} />)
    await waitFor(() => { expect(screen.queryByText('美国9月核心CPI年率')).not.toBeNull() })
    expect(screen.queryByText('macro.error')).toBeNull()
  })
})

describe('日历排序（2026-11-07 用户裁决：最新日期在最上）', () => {
  /** 面板列表容器的文本（列表 = 「本周」提示的父元素，行序即该串里的先后）。 */
  const listText = (): string => screen.getByText('macro.weekHint').parentElement?.textContent ?? ''

  it('上游乱序到达也按公布时间倒序铺开：跨日整体倒序，不是按天分组', async () => {
    net.calendar = [
      cal('美国', '周一数据', { publishedAt: '2026-11-02T00:30:00.000Z' }),
      cal('美国', '周日数据', { publishedAt: '2026-11-08T01:00:00.000Z' }),
      cal('美国', '周六数据', { publishedAt: '2026-11-07T22:00:00.000Z' }),
      cal('美国', '周中数据', { publishedAt: '2026-11-05T12:00:00.000Z' }),
    ]
    net.rates = []
    render(<MacroPanel t={t} onClose={() => {}} />)
    await waitFor(() => { expect(screen.queryByText('周一数据')).not.toBeNull() })

    const text = listText()
    const at = (title: string): number => text.indexOf(title)
    expect(at('周日数据')).toBeLessThan(at('周六数据'))
    expect(at('周六数据')).toBeLessThan(at('周中数据'))
    expect(at('周中数据')).toBeLessThan(at('周一数据'))
  })

  it('倒序不受地区过滤影响：过滤后仍按公布时间倒序', async () => {
    net.calendar = [
      cal('美国', '美国早', { publishedAt: '2026-11-02T00:30:00.000Z' }),
      cal('德国', '德国晚', { publishedAt: '2026-11-09T00:30:00.000Z' }),
      cal('美国', '美国晚', { publishedAt: '2026-11-06T00:30:00.000Z' }),
    ]
    net.rates = []
    render(<MacroPanel t={t} onClose={() => {}} />)
    await waitFor(() => { expect(screen.queryByText('美国晚')).not.toBeNull() })

    const text = listText()
    expect(text).not.toContain('德国晚')
    expect(text.indexOf('美国晚')).toBeLessThan(text.indexOf('美国早'))
  })
})
