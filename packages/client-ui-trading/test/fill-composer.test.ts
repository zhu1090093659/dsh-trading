/**
 * 「发给 Agent → 填入输入框」链路单测（离线，fake sessions/conversation）：
 * fill-composer 编排（草稿拼接、截图 File 摄取、busy 拒写、无会话建会话）
 * 与 compose-quote 文案组装。核心断言：**绝不触发 submit**。
 */
import { describe, expect, it, vi } from 'vitest'
import { composeQuoteMessage } from '../src/client/compose-quote.ts'
import { dataUrlToFile, fillComposerWithQuote, stripDataUrlPrefix } from '../src/client/fill-composer.ts'
import type { ConversationDraftFace, FillComposerDeps } from '../src/client/fill-composer.ts'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'

const PNG_URL = 'data:image/png;base64,QUJD' // 'ABC'

function makeSessions(options: { current?: string }) {
  let current = options.current
  const sessions = {
    list: {
      getSnapshot: () => ({ current }),
      subscribe: () => () => {},
    },
    binding: (id: string) => (id === current ? { sessionId: id } : undefined),
  } as unknown as ISessions
  return { sessions, setCurrent: (next?: string) => { current = next } }
}

function makeConversation(options: { phase?: string; draft?: string; addImagesOk?: boolean } = {}) {
  const calls: { setDraft: string[]; addImages: string[][]; created: File[][]; released: string[]; submit: number } = {
    setDraft: [], addImages: [], created: [], released: [], submit: 0,
  }
  let nextId = 0
  const facade = {
    state: {
      getSnapshot: () => ({ phase: options.phase ?? 'plain', draft: options.draft ?? '', imageIds: [] }),
    },
    setDraft(text: string) { calls.setDraft.push(text) },
    addImages(ids: readonly string[]) {
      calls.addImages.push([...ids])
      return options.addImagesOk ?? true
    },
  }
  const conversation: ConversationDraftFace = {
    createDraftImages(files: readonly File[]) {
      calls.created.push([...files])
      return files.map((file) => ({ id: `draft-${nextId++}-${file.name}` }))
    },
    releaseDraftImage(id: string) { calls.released.push(id) },
    input: {
      shell(id: string) {
        void id
        return facade as never
      },
    },
  }
  return { conversation, calls }
}

describe('fillComposerWithQuote', () => {
  it('有当前会话：setDraft 写入文本，不触发 submit', async () => {
    const { sessions } = makeSessions({ current: 'sess-1' })
    const { conversation, calls } = makeConversation()
    await fillComposerWithQuote({ sessions, conversation }, '看一下苹果', undefined)
    expect(calls.setDraft).toEqual(['看一下苹果'])
    expect(calls.addImages).toEqual([])
    expect(calls.submit).toBe(0)
  })

  it('非空草稿：空行拼接追加，不覆盖用户已打内容', async () => {
    const { sessions } = makeSessions({ current: 'sess-1' })
    const { conversation, calls } = makeConversation({ draft: '帮我看下' })
    await fillComposerWithQuote({ sessions, conversation }, '看一下苹果')
    expect(calls.setDraft).toEqual(['帮我看下\n\n看一下苹果'])
  })

  it('附图：dataUrl 转 PNG File 摄取后 addImages 挂 id', async () => {
    const { sessions } = makeSessions({ current: 'sess-1' })
    const { conversation, calls } = makeConversation()
    await fillComposerWithQuote({ sessions, conversation }, '看图', { dataUrl: PNG_URL, name: 'AAPL-1d.png' })
    expect(calls.created).toHaveLength(1)
    expect(calls.created[0][0].name).toBe('AAPL-1d.png')
    expect(calls.created[0][0].type).toBe('image/png')
    expect(calls.addImages).toEqual([['draft-0-AAPL-1d.png']])
    expect(calls.released).toEqual([])
  })

  it('composer 提交中（phase ≠ plain）：拒绝写入并抛错', async () => {
    const { sessions } = makeSessions({ current: 'sess-1' })
    const { conversation, calls } = makeConversation({ phase: 'submitting' })
    await expect(fillComposerWithQuote({ sessions, conversation }, 'hello')).rejects.toThrow(/composer is busy/)
    expect(calls.setDraft).toEqual([])
    expect(calls.addImages).toEqual([])
  })

  it('addImages 被拒（busy）：回收草稿图，文本照填', async () => {
    const { sessions } = makeSessions({ current: 'sess-1' })
    const { conversation, calls } = makeConversation({ addImagesOk: false })
    await fillComposerWithQuote({ sessions, conversation }, 'hello', { dataUrl: PNG_URL, name: 'a.png' })
    expect(calls.released).toHaveLength(1)
    expect(calls.setDraft).toEqual(['hello'])
  })

  it('无当前会话：startSession 后轮询到 list.current 落地再填入', async () => {
    const { sessions, setCurrent } = makeSessions({})
    const { conversation, calls } = makeConversation()
    const startSession = vi.fn(() => { setCurrent('sess-new') })
    await fillComposerWithQuote({ sessions, conversation, startSession, pollMs: 1, pollMax: 5 }, 'hello')
    expect(startSession).toHaveBeenCalledTimes(1)
    expect(calls.setDraft).toEqual(['hello'])
  })

  it('始终无会话：抛错（不写草稿）', async () => {
    const { sessions } = makeSessions({})
    const { conversation, calls } = makeConversation()
    await expect(fillComposerWithQuote({ sessions, conversation, pollMs: 1, pollMax: 2 }, 'hello')).rejects.toThrow(/no session available/)
    expect(calls.setDraft).toEqual([])
  })
})

describe('helpers', () => {
  it('stripDataUrlPrefix：剥离 base64 前缀；无前缀原样返回', () => {
    expect(stripDataUrlPrefix(PNG_URL)).toBe('QUJD')
    expect(stripDataUrlPrefix('QUJD')).toBe('QUJD')
  })

  it('dataUrlToFile：产出 image/png File，字节与名字正确', () => {
    const file = dataUrlToFile(PNG_URL, 'AAPL-1d.png')
    expect(file).toBeInstanceOf(File)
    expect(file.type).toBe('image/png')
    expect(file.name).toBe('AAPL-1d.png')
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
