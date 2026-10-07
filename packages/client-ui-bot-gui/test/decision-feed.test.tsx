/**
 * @vitest-environment jsdom
 * 策略决策动态分页与运行模式徽章测试：
 * - 决策记录每页最多 5 条，翻页看其余
 * - 运行模式由卡片协议的通道字段推导（paper / dry-run / 未知），不发明事实
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { DecisionFeed, detectRunMode, DECISION_PAGE_SIZE, type CockpitCard } from '../src/client/blocks.tsx'
import { zh } from '../src/client/locales.ts'
import type { Card } from '../src/client/contract.ts'

function t(key: string, params?: Record<string, unknown>): string {
  let str = (zh as Record<string, string>)[key] ?? key
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      str = str.replace(new RegExp('\\{' + k + '\\}', 'g'), String(v))
    }
  }
  return str
}

/** 造一张决策/触发卡片（字段形状与卫星仓投影器一致）。 */
function cardOf(id: string, cardType: 'decision' | 'trigger-trace', fields: Card['fields'] = []): CockpitCard {
  return {
    cardId: id,
    cardType,
    revision: 1,
    fallbackText: id,
    fields,
    actions: [],
  }
}

afterEach(() => {
  cleanup()
})

describe('决策记录分页', () => {
  it('运营查看决策记录时每页最多展示 5 条且最新在前', () => {
    // Given: 7 条决策记录（数组顺序 = 服务端下发顺序，旧 → 新）
    const feed: CockpitCard[] = Array.from({ length: 7 }, (_v, i) => cardOf('card-' + String(i), 'decision'))
    render(<DecisionFeed cards={feed} t={t} />)

    // When: 读第 1 页
    const shown = screen.getAllByText(/^card-/)
    // Then: 只渲染 5 条，且是最新 5 条（card-6…card-2），第 6 页码状态可见
    expect(shown).toHaveLength(5)
    expect(screen.getByText('card-6')).toBeDefined()
    expect(screen.getByText('card-2')).toBeDefined()
    expect(screen.queryByText('card-1')).toBeNull()
    expect(screen.getByText(t('bot.page.status', { page: 1, total: 2 }))).toBeDefined()
  })

  it('运营翻到下一页时看到剩余的更早记录', () => {
    // Given: 7 条决策记录
    const feed: CockpitCard[] = Array.from({ length: 7 }, (_v, i) => cardOf('card-' + String(i), 'decision'))
    render(<DecisionFeed cards={feed} t={t} />)

    // When: 点下一页
    fireEvent.click(screen.getByRole('button', { name: zh['bot.page.next'] }))

    // Then: 显示最早 2 条，下一页按钮变为不可用
    expect(screen.getByText('card-1')).toBeDefined()
    expect(screen.getByText('card-0')).toBeDefined()
    expect(screen.queryByText('card-2')).toBeNull()
    const next = screen.getByRole('button', { name: zh['bot.page.next'] }) as HTMLButtonElement
    expect(next.disabled).toBe(true)
    expect(screen.getByText(t('bot.page.status', { page: 2, total: 2 }))).toBeDefined()
  })

  it('运营在记录不超过每页上限时不显示翻页器', () => {
    // Given: 恰好 5 条（单页）
    const feed: CockpitCard[] = Array.from({ length: DECISION_PAGE_SIZE }, (_v, i) => cardOf('only-' + String(i), 'decision'))
    render(<DecisionFeed cards={feed} t={t} />)

    // Then: 全部渲染且没有翻页器
    expect(screen.getAllByText(/^only-/)).toHaveLength(5)
    expect(screen.queryByRole('button', { name: zh['bot.page.next'] })).toBeNull()
  })

  it('运营在数据变少时页码自动回缩不越界', () => {
    // Given: 12 条记录，先翻到第 3 页（最后一页）
    const feed: CockpitCard[] = Array.from({ length: 12 }, (_v, i) => cardOf('card-' + String(i), 'decision'))
    const view = render(<DecisionFeed cards={feed} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: zh['bot.page.next'] }))
    fireEvent.click(screen.getByRole('button', { name: zh['bot.page.next'] }))
    expect(screen.getByText(t('bot.page.status', { page: 3, total: 3 }))).toBeDefined()

    // When: 刷新后记录只剩 3 条（rerender 同一组件实例）
    view.rerender(<DecisionFeed cards={[cardOf('card-2', 'decision'), cardOf('card-1', 'decision'), cardOf('card-0', 'decision')]} t={t} />)

    // Then: 无翻页器，3 条全部展示
    expect(screen.getAllByText(/^card-/)).toHaveLength(3)
    expect(screen.queryByRole('button', { name: zh['bot.page.next'] })).toBeNull()
  })

  it('运营在决策与触发轨迹混排时看到同一分页器共同计数', () => {
    // Given: 4 条 decision + 3 条 trigger-trace
    const feed: CockpitCard[] = [
      cardOf('d-1', 'decision'),
      cardOf('t-1', 'trigger-trace', [{ key: 'channel', label: '通道', kind: 'text', value: 'demo' }]),
      cardOf('d-2', 'decision'),
      cardOf('t-2', 'trigger-trace', [{ key: 'channel', label: '通道', kind: 'text', value: 'demo' }]),
      cardOf('d-3', 'decision'),
      cardOf('t-3', 'trigger-trace', [{ key: 'channel', label: '通道', kind: 'text', value: 'demo' }]),
      cardOf('d-4', 'decision'),
    ]
    render(<DecisionFeed cards={feed} t={t} />)

    // Then: 第 1 页恰好 5 条（最新 5 条：d-4 t-3 d-3 t-2 d-2）
    const shown = screen.getAllByText(/^(d|t)-/)
    expect(shown).toHaveLength(5)
    expect(screen.queryByText('d-1')).toBeNull()
  })
})

describe('运行模式推导', () => {
  it('管理员在通道字段是 demo 时看到档位判为 paper', () => {
    // Given: 最新 trigger-trace 卡的通道 = demo（paper 档投影器的真实取值）
    const cards: CockpitCard[] = [
      cardOf('t-old', 'trigger-trace', [{ key: 'channel', label: '通道', kind: 'text', value: 'demo' }]),
    ]
    // Then: paper
    expect(detectRunMode(cards)).toBe('paper')
  })

  it('管理员在通道字段是 dry-run 时看到档位判为 dry-run', () => {
    // Given: dry-run 档投影的通道字段
    const cards: CockpitCard[] = [
      cardOf('t-1', 'trigger-trace', [{ key: 'channel', label: '通道', kind: 'text', value: 'dry-run' }]),
    ]
    expect(detectRunMode(cards)).toBe('dry-run')
  })

  it('管理员在没有 trigger-trace 卡时看到档位不猜返回 unknown', () => {
    // Given: 只有 decision 卡
    const cards: CockpitCard[] = [cardOf('d-1', 'decision')]
    expect(detectRunMode(cards)).toBe('unknown')
  })

  it('管理员在多张触发卡时看到档位以最新的为准（freshness 更小者胜）', () => {
    // Given: 旧卡是 paper（freshness 大），新卡是 dry-run（freshness 小）
    const oldPaper = { ...cardOf('t-old', 'trigger-trace', [{ key: 'channel', label: '通道', kind: 'text', value: 'demo' }]), freshnessMs: 50_000 }
    const newDry = { ...cardOf('t-new', 'trigger-trace', [{ key: 'mode', label: '通道', kind: 'text', value: 'dry-run' }]), freshnessMs: 2_000 }
    // When: 按服务端顺序（旧 → 新）下发
    // Then: 读出新卡的 dry-run
    expect(detectRunMode([oldPaper, newDry])).toBe('dry-run')
  })
})
