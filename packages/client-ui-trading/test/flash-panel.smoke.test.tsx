/**
 * FlashPanel 热度筛选冒烟（2026-09-13）：把面板 mount 进 jsdom，用 api 模块桩断言
 * 「默认只看 沸+爆 → 桥收到 hot=['沸','爆'] → 点选/恢复默认重发」的接线，以及
 * 热度徽标落到条目上。纯函数单测覆盖不到这层编排。
 *
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MarketLocaleKey } from '../src/client/contract.ts'

const net = vi.hoisted(() => ({
  calls: [] as Array<{ hot?: readonly string[]; keyword?: string; cursor?: string }>,
  items: [
    { source: 'jin10', title: '热度标题', url: 'https://flash.jin10.com/detail/1', publishedAt: '2026-09-13T01:00:00.000Z', hot: '爆' },
    { source: 'jin10', title: '无热度标题', url: 'https://flash.jin10.com/detail/2', publishedAt: '2026-09-13T00:50:00.000Z' },
  ],
}))

vi.mock('../src/client/api.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/client/api.ts')>()
  return {
    ...actual,
    fetchFlash: async (options: { hot?: readonly string[]; keyword?: string; cursor?: string; limit?: number }) => {
      const record: { hot?: readonly string[]; keyword?: string; cursor?: string } = {}
      if (options.hot !== undefined) record.hot = options.hot
      if (options.keyword !== undefined) record.keyword = options.keyword
      if (options.cursor !== undefined) record.cursor = options.cursor
      net.calls.push(record)
      return { items: net.items as never, hasMore: false }
    },
  }
})

import { FlashPanel } from '../src/client/FlashPanel.tsx'

const t = (key: MarketLocaleKey): string => key

function pressed(label: string): string | null {
  return screen.getByRole('button', { name: label }).getAttribute('aria-pressed')
}

describe('FlashPanel 热度筛选（金十网页版 火/热/沸/爆）', () => {
  beforeEach(() => {
    net.calls.length = 0
  })
  afterEach(() => cleanup())

  it('默认只看 沸+爆，并把 hot 传给桥；徽标跟随条目 hot', async () => {
    const { container } = render(<FlashPanel t={t} onClose={() => {}} />)
    await waitFor(() => { expect(net.calls.length).toBeGreaterThan(0) })
    expect(net.calls[0]?.hot).toEqual(['沸', '爆'])
    expect(pressed('沸')).toBe('true')
    expect(pressed('爆')).toBe('true')
    expect(pressed('火')).toBe('false')
    expect(pressed('热')).toBe('false')
    await waitFor(() => { expect(container.querySelector('[data-hot="爆"]')).not.toBeNull() })
  })

  it('点选 热 → 重发 hot 含 热；恢复默认 → 回到 沸+爆', async () => {
    render(<FlashPanel t={t} onClose={() => {}} />)
    await waitFor(() => { expect(net.calls.length).toBeGreaterThan(0) })
    fireEvent.click(screen.getByRole('button', { name: '热' }))
    await waitFor(() => { expect(net.calls.at(-1)?.hot).toEqual(['沸', '爆', '热']) })
    fireEvent.click(screen.getByRole('button', { name: 'flash.heatReset' }))
    await waitFor(() => { expect(net.calls.at(-1)?.hot).toEqual(['沸', '爆']) })
  })

  it('全选 → 四个等级齐发', async () => {
    render(<FlashPanel t={t} onClose={() => {}} />)
    await waitFor(() => { expect(net.calls.length).toBeGreaterThan(0) })
    fireEvent.click(screen.getByRole('button', { name: 'flash.heatAll' }))
    await waitFor(() => { expect(net.calls.at(-1)?.hot).toEqual(['火', '热', '沸', '爆']) })
  })
})
