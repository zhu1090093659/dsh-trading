/**
 * 「发给 Agent」数据位置段单测（离线纯函数）：
 * owner 2026-09-05 裁决不内联行情数据——消息只给「范围 + 取数位置 +
 * 已开指标参数」，分析由 Agent 调工具、写代码完成。
 * 时区标签走同源 helper、时间用本地时区构造，断言与运行环境 TZ 无关。
 */
import { describe, expect, it } from 'vitest'
import { composeQuoteDataSection, timezoneLabel, type QuoteDataSectionCopy } from '../src/client/compose-quote-data.ts'
import type { Kline } from '../src/client/types.ts'

/** 本地时区安全的时间构造（ms）。 */
const at = (y: number, m: number, d: number, hh = 0, mm = 0): number => new Date(y, m - 1, d, hh, mm).getTime()

const kline = (openTime: number, close: number): Kline => ({ openTime, open: close - 1, high: close + 1, low: close - 2, close, volume: 1000 + close })

const COPY: QuoteDataSectionCopy = {
  header: '[data]',
  range: 'range {range} count={count} interval={interval} tz={tz}',
  locate: 'locate {tool} {symbol} {interval} {limit}',
  indicators: 'indicators {list} via {tool}',
}

describe('composeQuoteDataSection', () => {
  it('全量：头行 + 范围 + 取数位置 + 已开指标参数行（limit = 根数）', () => {
    const text = composeQuoteDataSection({
      market: 'cn',
      symbol: '600519.SH',
      interval: '1d',
      klines: [kline(at(2026, 9, 1), 10), kline(at(2026, 9, 2), 11), kline(at(2026, 9, 3), 12)],
      indicators: [
        { id: 'ma', title: 'MA', params: { n1: 5, n2: 10, n3: 20, n4: 30, n5: 60, n6: 120 } },
        { id: 'macd', title: 'MACD', params: { fast: 12, slow: 26, signal: 9 } },
      ],
      klinesTool: 'cn_get_klines',
      indicatorsTool: 'cn_get_indicators',
    }, COPY)
    const lines = text.split('\n')
    expect(lines[0]).toBe('[data]')
    expect(lines[1]).toBe(`range 2026-09-01 ~ 2026-09-03 count=3 interval=1d tz=${timezoneLabel()}`)
    expect(lines[2]).toBe('locate cn_get_klines 600519.SH 1d 3')
    expect(lines[3]).toBe('indicators MA(n1=5, n2=10, n3=20, n4=30, n5=60, n6=120); MACD(fast=12, slow=26, signal=9) via cn_get_indicators')
  })

  it('盘中周期：范围两端落到时分', () => {
    const text = composeQuoteDataSection({
      market: 'crypto',
      symbol: 'BTCUSDT',
      interval: '1h',
      klines: [kline(at(2026, 9, 1, 8, 0), 10), kline(at(2026, 9, 1, 14, 30), 11)],
      indicators: [],
      klinesTool: 'crypto_get_klines',
    }, COPY)
    expect(text.split('\n')[1]).toBe(`range 2026-09-01 08:00 ~ 2026-09-01 14:30 count=2 interval=1h tz=${timezoneLabel()}`)
  })

  it('无已开指标：指标参数行整行省略', () => {
    const text = composeQuoteDataSection({
      market: 'us',
      symbol: 'AAPL',
      interval: '1d',
      klines: [kline(at(2026, 9, 4), 300)],
      indicators: [],
      klinesTool: 'us_get_klines',
    }, COPY)
    const lines = text.split('\n')
    expect(lines).toHaveLength(3)
    expect(lines[2]).toBe('locate us_get_klines AAPL 1d 1')
  })

  it('空序列：返回空串（整段省略）', () => {
    const text = composeQuoteDataSection({
      market: 'cn',
      symbol: '600519.SH',
      interval: '1d',
      klines: [],
      indicators: [],
      klinesTool: 'cn_get_klines',
    }, COPY)
    expect(text).toBe('')
  })

  it('缺省 copy：回落 zh 默认文案（含范围、取数位置与指标参数槽）', () => {
    const text = composeQuoteDataSection({
      market: 'cn',
      symbol: '600519.SH',
      interval: '1d',
      klines: [kline(at(2026, 9, 5), 1450)],
      indicators: [{ id: 'ma', title: 'MA', params: { n1: 5 } }],
      klinesTool: 'cn_get_klines',
      indicatorsTool: 'cn_get_indicators',
    })
    expect(text).toContain('【图表数据 · 范围与取数位置（与截图同一序列）】')
    expect(text).toContain(`范围：2026-09-05 ~ 2026-09-05 · 共1根 · interval=1d · ${timezoneLabel()}（最新一根为进行中的当根K线）`)
    expect(text).toContain('取数位置：Agent 可调用 cn_get_klines 工具（symbol=600519.SH，interval=1d，limit=1）取得同源序列')
    expect(text).toContain('已开指标参数：MA(n1=5)；可用 cn_get_indicators 同参数复算，或取数后自行计算。')
  })
})
