/**
 * 「发给 Agent」链路单测（离线，fake ISessions）：
 * send-to-agent 编排（echo → prompt('queue') → 失败 abandon）与
 * compose-quote 文案组装。
 */
import { describe, expect, it, vi } from 'vitest'
import { composeQuoteMessage } from '../src/client/compose-quote.ts'
import { sendQuoteToAgent, stripDataUrlPrefix } from '../src/client/send-to-agent.ts'
import type { SendToAgentDeps } from '../src/client/send-to-agent.ts'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'

const PNG_URL = 'data:image/png;base64,QUJD' // 'ABC'

interface PromptCall {
  content: Array<{ type: string; text?: string; data?: string; name?: string }>
  mode: string
  requestId?: string
}

function makeSessions(options: {
  current?: string
  beginAbandon?: ReturnType<typeof vi.fn>
  promptResult?: { ok: true } | { ok: false; error: { code: string } }
}) {
  const beginCalls: Array<{ text: string; images: unknown[] }> = []
  const promptCalls: PromptCall[] = []
  let current = options.current
  const face = {
    beginSubmission(input: { text: string; images: unknown[] }) {
      beginCalls.push(input)
      return { requestId: 'req-1', abandon: options.beginAbandon ?? vi.fn() }
    },
    async prompt(content: PromptCall['content'], mode: PromptCall['mode'], _signal: unknown, requestId?: string) {
      promptCalls.push({ content, mode, requestId })
      return options.promptResult ?? { ok: true as const, value: { accepted: true as const } }
    },
  }
  const sessions = {
    list: {
      getSnapshot: () => ({ current }),
      subscribe: () => () => {},
    },
    binding: (id: string) => (id === current ? { session: face } : undefined),
  } as unknown as ISessions
  return { sessions, beginCalls, promptCalls, setCurrent: (next?: string) => { current = next } }
}

describe('sendQuoteToAgent', () => {
  it('有当前会话：echo 携带文本，prompt 以 queue + echo requestId 投递', async () => {
    const { sessions, beginCalls, promptCalls } = makeSessions({ current: 'sess-1' })
    const deps: SendToAgentDeps = { sessions }
    await sendQuoteToAgent(deps, '看一下苹果', undefined)
    expect(beginCalls).toHaveLength(1)
    expect(beginCalls[0].text).toBe('看一下苹果')
    expect(beginCalls[0].images).toEqual([])
    expect(promptCalls).toEqual([
      { content: [{ type: 'text', text: '看一下苹果' }], mode: 'queue', requestId: 'req-1' },
    ])
  })

  it('附图：image part 剥掉 data URL 前缀只留 base64，echo 预览保留原 dataUrl', async () => {
    const { sessions, beginCalls, promptCalls } = makeSessions({ current: 'sess-1' })
    await sendQuoteToAgent(
      { sessions },
      '看图',
      { dataUrl: PNG_URL, name: 'AAPL-1d.png', width: 800, height: 420 },
    )
    const images = beginCalls[0].images as Array<{ previewUrl: string; name?: string; width?: number; height?: number }>
    expect(images).toEqual([{ previewUrl: PNG_URL, name: 'AAPL-1d.png', width: 800, height: 420 }])
    expect(promptCalls[0].content).toEqual([
      { type: 'text', text: '看图' },
      { type: 'image', mediaType: 'image/png', data: 'QUJD', name: 'AAPL-1d.png' },
    ])
  })

  it('prompt 被拒：abandon 撤回 echo 并抛错', async () => {
    const abandon = vi.fn()
    const { sessions } = makeSessions({
      current: 'sess-1',
      beginAbandon: abandon,
      promptResult: { ok: false, error: { code: 'gateway/bad-request' } },
    })
    await expect(sendQuoteToAgent({ sessions }, 'hi')).rejects.toThrow(/prompt rejected/)
    expect(abandon).toHaveBeenCalledTimes(1)
  })

  it('无当前会话：startSession 后轮询到 list.current 落地再投递', async () => {
    const { sessions, promptCalls, setCurrent } = makeSessions({})
    const startSession = vi.fn(() => { setCurrent('sess-new') })
    await sendQuoteToAgent({ sessions, startSession, pollMs: 1, pollMax: 5 }, 'hello')
    expect(startSession).toHaveBeenCalledTimes(1)
    expect(promptCalls).toHaveLength(1)
  })

  it('始终无会话：抛错（不触发 beginSubmission）', async () => {
    const { sessions, beginCalls } = makeSessions({})
    await expect(sendQuoteToAgent({ sessions, pollMs: 1, pollMax: 2 }, 'hello')).rejects.toThrow(/no session available/)
    expect(beginCalls).toHaveLength(0)
  })
})

describe('stripDataUrlPrefix', () => {
  it('剥离 base64 前缀；无前缀原样返回', () => {
    expect(stripDataUrlPrefix(PNG_URL)).toBe('QUJD')
    expect(stripDataUrlPrefix('QUJD')).toBe('QUJD')
  })
})

describe('composeQuoteMessage', () => {
  it('全量输入：标题行 + 现价行 + K线行 + 指标行 + 截图尾注', () => {
    const text = composeQuoteMessage({
      name: '苹果',
      symbol: 'AAPL',
      marketLabel: '美股',
      intervalLabel: '日K',
      price: 325.13,
      change: 8.28,
      pct: 2.61,
      prevClose: 316.85,
      candle: { openTime: 0, open: 316.98, high: 327.3, low: 314.74, close: 325.13, volume: 52432400, closeTime: 86400000 },
      indicatorTitles: ['EMA', 'MACD'],
      withScreenshot: true,
    })
    expect(text).toContain('看一下我正在看的行情：苹果 · AAPL · 美股 · 日K')
    expect(text).toContain('现价 325.13（+8.28 / +2.61%），昨收 316.85')
    expect(text).toContain('开 316.98 高 327.30 低 314.74 收 325.13 量 5243.24万')
    expect(text).toContain('已开启指标：EMA、MACD')
    expect(text.endsWith('随消息附当前图表截图，请结合分析。')).toBe(true)
  })

  it('缺省输入：无统计行也不出空段，尾注回落纯文本', () => {
    const text = composeQuoteMessage({
      symbol: 'BTCUSDT',
      marketLabel: '加密货币',
      intervalLabel: '5分',
      indicatorTitles: [],
      withScreenshot: false,
    })
    expect(text).toBe('看一下我正在看的行情：BTCUSDT · 加密货币 · 5分\n请结合当前行情继续分析。')
  })
})
