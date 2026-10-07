/**
 * @vitest-environment jsdom
 * 卡片组件渲染断言测试：不可操作态、字段值格式化、新鲜度文本。
 */
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { CardView, fieldValueText, freshnessText } from '../src/client/blocks.tsx'
import { zh } from '../src/client/locales.ts'
import type { CockpitCard } from '../src/client/blocks.tsx'

function t(key: string, params?: Record<string, unknown>): string {
  let str = (zh as Record<string, string>)[key] ?? key
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      str = str.replace(new RegExp('\\{' + k + '\\}', 'g'), String(v))
    }
  }
  return str
}

describe('卡片渲染与文本格式化', () => {
  it('用户查看卡片字段格式化时正确处理布尔值与数值单位', () => {
    // Given: 不同类型的卡片字段
    const fBoolTrue = { key: 'a', label: '开', kind: 'bool' as const, value: true }
    const fBoolFalse = { key: 'b', label: '关', kind: 'bool' as const, value: false }
    const fCurrency = { key: 'c', label: '金额', kind: 'currency' as const, value: 100, unit: ' USD' }
    const fPercent = { key: 'd', label: '比例', kind: 'percent' as const, value: 5.2 }

    // When: 调用 fieldValueText
    const resBoolTrue = fieldValueText(fBoolTrue, t)
    const resBoolFalse = fieldValueText(fBoolFalse, t)
    const resCurrency = fieldValueText(fCurrency, t)
    const resPercent = fieldValueText(fPercent, t)

    // Then: 格式化结果符合预期
    expect(resBoolTrue).toBe('是')
    expect(resBoolFalse).toBe('否')
    expect(resCurrency).toBe('100 USD')
    expect(resPercent).toBe('5.2%')
  })

  it('用户观察卡片新鲜度时正确反映时间跨度', () => {
    // Given: 基准当前时间
    const now = 1000000000000

    // When: 计算不同落差的新鲜度文本
    const resNone = freshnessText(undefined, now, t)
    const resFresh = freshnessText(now - 2000, now, t)
    const resRecent = freshnessText(now - 30000, now, t)
    const resStale = freshnessText(now - 180000, now, t)

    // Then: 文案准确分级
    expect(resNone).toBe('尚未取到数据')
    expect(resFresh).toBe('数据是新的（2 秒前）')
    expect(resRecent).toBe('数据 30 秒前')
    expect(resStale).toBe('数据已陈旧：3 分钟前')
  })

  it('用户遇到更高版本协议卡片时显示不可操作样式并禁用按钮', () => {
    // Given: operable = false 的卡片
    const card: CockpitCard = {
      cardId: 'c-inop',
      cardType: 'decision',
      revision: 1,
      fallbackText: 'Future Decision Card',
      fields: [],
      actions: [{ kind: 'approve', label: '通过' }],
      operable: false,
    }

    // When: 渲染 CardView
    render(<CardView card={card} t={t} />)

    // Then: 禁用按钮并显示升级提示
    const btn = screen.getByText('通过') as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    expect(screen.getByText(zh['bot.upgradePrompt'])).toBeDefined()
  })
})
