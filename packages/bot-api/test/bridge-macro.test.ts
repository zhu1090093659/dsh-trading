import { describe, expect, it } from 'vitest'
import {
  MAX_MACRO_CALENDAR_LIMIT,
  TradingBridge,
  createBridgeHost,
  dispatchBridgeRequest,
  type MacroFeedLike,
} from '../src/bridge.ts'

const CAL = {
  publishedAt: '2026-09-14T12:30:00.000Z',
  star: 3,
  region: '美国',
  title: '美国9月核心CPI年率',
  previous: '3.2',
  consensus: '3.1',
} as const

const RATE = {
  region: '日本',
  bankName: '日本央行',
  rate: '1',
  publishedAt: '2026-06-16',
} as const

function makeBridge(macroFeed?: MacroFeedLike): TradingBridge {
  return new TradingBridge(createBridgeHost({ legacy: () => undefined, macroFeed }))
}

const FEED: MacroFeedLike = {
  listCalendar: async (limit) => (limit === undefined ? [CAL] : []),
  listRates: async () => [RATE],
}

describe('桥 /macro/*（宏观/利率，金十接入）', () => {
  it('日历：回元数据条目（地区已按标题前缀推断）', async () => {
    const wire = await makeBridge(FEED).macroCalendar(null)
    expect(wire).toEqual({ ok: true, items: [CAL] })
  })

  it('日历 limit 透传；越界 → 协议 400（不静默截断）', async () => {
    await expect(makeBridge(FEED).macroCalendar(String(MAX_MACRO_CALENDAR_LIMIT + 1))).rejects.toMatchObject({ status: 400 })
    await expect(makeBridge(FEED).macroCalendar('0')).rejects.toMatchObject({ status: 400 })
    expect(await makeBridge(FEED).macroCalendar('7')).toEqual({ ok: true, items: [] })
  })

  it('利率：全量透传（地区过滤在客户端）', async () => {
    expect(await makeBridge(FEED).macroRates()).toEqual({ ok: true, items: [RATE] })
  })

  it('数据源缺席 → TRADING_NOT_IMPLEMENTED（不是空列表）', async () => {
    await expect(makeBridge(undefined).macroCalendar(null)).rejects.toMatchObject({ code: 'TRADING_NOT_IMPLEMENTED' })
    await expect(makeBridge(undefined).macroRates()).rejects.toMatchObject({ code: 'TRADING_NOT_IMPLEMENTED' })
  })

  it('dispatchBridgeRequest GET /macro/calendar、/macro/rates 透传', async () => {
    const calendar = await dispatchBridgeRequest(makeBridge(FEED), 'GET', '/macro/calendar', new URLSearchParams())
    expect(calendar).toEqual({ status: 200, payload: { ok: true, items: [CAL] } })
    const rates = await dispatchBridgeRequest(makeBridge(FEED), 'GET', '/macro/rates', new URLSearchParams())
    expect(rates).toEqual({ status: 200, payload: { ok: true, items: [RATE] } })
  })
})
