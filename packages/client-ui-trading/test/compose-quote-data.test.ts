/**
 * 「发给 Agent」数据位置段单测（离线纯函数）：
 * owner 2026-09-05 裁决——K 线数据不内联（范围 + 取数位置），已开指标
 * 直接发计算后的当根读数（图表 legend 同源，只给参数让他复算属多此一举）。
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
  indicators: 'readouts {list}',
}

describe('composeQuoteDataSection', () => {
  it('全量：头行 + 范围 + 取数位置 + 指标当根读数（legend 同款两位小数）', () => {
    const text = composeQuoteDataSection({
      market: 'cn',
      symbol: '600519.SH',
      interval: '1d',
      klines: [kline(at(2026, 9, 1), 10), kline(at(2026, 9, 2), 11), kline(at(2026, 9, 3), 12)],
      indicatorReadouts: [
        { title: 'MA', outputs: [
          { key: 'MA5', value: 11.256 },
          { key: 'MA10', value: 10.8 },
          { key: 'MA120', value: undefined },
        ] },
        { title: 'MACD', outputs: [
          { key: 'DIF', value: 0.1234 },
          { key: 'DEA', value: 0.05 },
          { key: 'MACD', value: -0.0421 },
        ] },
      ],
      klinesTool: 'cn_get_klines',
    }, COPY)
    const lines = text.split('\n')
    expect(lines[0]).toBe('[data]')
    expect(lines[1]).toBe(`range 2026-09-01 ~ 2026-09-03 count=3 interval=1d tz=${timezoneLabel()}`)
    expect(lines[2]).toBe('locate cn_get_klines 600519.SH 1d 3')
    expect(lines[3]).toBe('readouts MA MA5=11.26, MA10=10.80; MACD DIF=0.12, DEA=0.05, MACD=-0.04')
  })

  it('warm-up：分量 undefined 跳过，整组无有效值整组省略', () => {
    const text = composeQuoteDataSection({
      market: 'us',
      symbol: 'AAPL',
      interval: '1d',
      klines: [kline(at(2026, 9, 1), 10), kline(at(2026, 9, 2), 11)],
      indicatorReadouts: [
        { title: 'MA', outputs: [{ key: 'MA120', value: undefined }] },
        { title: 'RSI', outputs: [{ key: 'RSI6', value: 62.5 }] },
      ],
      klinesTool: 'us_get_klines',
    }, COPY)
    expect(text.split('\n')[3]).toBe('readouts RSI RSI6=62.50')
  })

  it('无指标读数：读数行整行省略；盘中周期范围落到时分', () => {
    const text = composeQuoteDataSection({
      market: 'crypto',
      symbol: 'BTCUSDT',
      interval: '1h',
      klines: [kline(at(2026, 9, 1, 8, 0), 10), kline(at(2026, 9, 1, 14, 30), 11)],
      indicatorReadouts: [],
      klinesTool: 'crypto_get_klines',
    }, COPY)
    const lines = text.split('\n')
    expect(lines).toHaveLength(3)
    expect(lines[1]).toBe(`range 2026-09-01 08:00 ~ 2026-09-01 14:30 count=2 interval=1h tz=${timezoneLabel()}`)
    expect(lines[2]).toBe('locate crypto_get_klines BTCUSDT 1h 2')
  })

  it('空序列：返回空串（整段省略）', () => {
    const text = composeQuoteDataSection({
      market: 'cn',
      symbol: '600519.SH',
      interval: '1d',
      klines: [],
      indicatorReadouts: [],
      klinesTool: 'cn_get_klines',
    }, COPY)
    expect(text).toBe('')
  })

  it('缺省 copy：回落 zh 默认文案（范围/取数位置/读数行）', () => {
    const text = composeQuoteDataSection({
      market: 'cn',
      symbol: '600519.SH',
      interval: '1d',
      klines: [kline(at(2026, 9, 5), 1450)],
      indicatorReadouts: [{ title: 'MA', outputs: [{ key: 'MA5', value: 1449.2 }] }],
      klinesTool: 'cn_get_klines',
    })
    expect(text).toContain('【图表数据 · 范围与取数位置（与截图同一序列）】')
    expect(text).toContain(`范围：2026-09-05 ~ 2026-09-05 · 共1根 · interval=1d · ${timezoneLabel()}（最新一根为进行中的当根K线）`)
    expect(text).toContain('取数位置：Agent 可调用 cn_get_klines 工具（symbol=600519.SH，interval=1d，limit=1）取得同源序列')
    expect(text).toContain('已开指标读数（与上方当根K线同根）：MA MA5=1449.20')
  })
})
