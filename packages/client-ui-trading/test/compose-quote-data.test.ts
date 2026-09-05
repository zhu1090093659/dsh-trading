/**
 * 「发给 Agent」数据段组装单测（离线纯函数）：
 * K 线全序列 CSV + 已开指标逐柱数值列 + 数据位置（复取/复算工具指引）。
 * 时间单元格用本地时区构造（new Date(y, m, d)），时区标签走同源 helper，
 * 断言与运行环境 TZ 无关。
 */
import { describe, expect, it } from 'vitest'
import { composeQuoteDataSection, timezoneLabel, type QuoteDataSectionCopy } from '../src/client/compose-quote-data.ts'
import type { Kline } from '../src/client/types.ts'

/** 本地时区安全的时间构造（ms）。 */
const at = (y: number, m: number, d: number, hh = 0, mm = 0): number => new Date(y, m - 1, d, hh, mm).getTime()

const kline = (openTime: number, close: number): Kline => ({ openTime, open: close - 1, high: close + 1, low: close - 2, close, volume: 1000 + close })

const COPY: QuoteDataSectionCopy = {
  header: '[data]',
  locator: 'locator market={market} symbol={symbol} interval={interval} count={count} range={range} tz={tz}',
  refetch: 'refetch {tool} {symbol} {interval} {limit}',
  indicators: 'indicators {tool}',
  truncated: 'truncated {inlined}/{count}',
  full: 'full {count}',
  note: 'note',
}

const FENCE = '\u0060\u0060\u0060'

describe('composeQuoteDataSection', () => {
  it('全量：头行 + 数据位置 + 复取/复算指引 + CSV 全列（含指标，warm-up 空单元格）', () => {
    const klines = [kline(at(2026, 9, 1), 10), kline(at(2026, 9, 2), 11), kline(at(2026, 9, 3), 12)]
    const text = composeQuoteDataSection({
      market: 'cn',
      symbol: '600519.SH',
      interval: '1d',
      klines,
      indicatorGroups: [{
        id: 'ma',
        title: 'MA',
        outputs: [
          { key: 'MA5', values: [undefined, 10.5, 11] },
          { key: 'MA10', values: [undefined, undefined, 10.8] },
        ],
      }],
      klinesTool: 'cn_get_klines',
      indicatorsTool: 'cn_get_indicators',
    }, COPY)
    const lines = text.split('\n')
    expect(lines[0]).toBe('[data]')
    expect(lines[1]).toBe(`locator market=cn symbol=600519.SH interval=1d count=3 range=2026-09-01 ~ 2026-09-03 tz=${timezoneLabel()}`)
    expect(lines[2]).toBe('refetch cn_get_klines 600519.SH 1d 3')
    expect(lines[3]).toBe('indicators cn_get_indicators')
    expect(lines[4]).toBe('full 3')
    expect(lines[5]).toBe('note')
    expect(lines[6]).toBe('')
    expect(lines[7]).toBe(`${FENCE}csv`)
    expect(lines[8]).toBe('time,open,high,low,close,volume,MA5,MA10')
    expect(lines[9]).toBe('2026-09-01,9,11,8,10,1010,,')
    expect(lines[10]).toBe('2026-09-02,10,12,9,11,1011,10.5,')
    expect(lines[11]).toBe('2026-09-03,11,13,10,12,1012,11,10.8')
    expect(lines[12]).toBe(FENCE)
  })

  it('截断：maxRows 内联最近 N 根，指标列下标与全序列对齐', () => {
    const klines = [kline(at(2026, 9, 1), 10), kline(at(2026, 9, 2), 11), kline(at(2026, 9, 3), 12), kline(at(2026, 9, 4), 13)]
    const text = composeQuoteDataSection({
      market: 'us',
      symbol: 'AAPL',
      interval: '1d',
      klines,
      indicatorGroups: [{ id: 'ma', title: 'MA', outputs: [{ key: 'MA2', values: [undefined, 10.5, 11.5, 12.5] }] }],
      klinesTool: 'us_get_klines',
      maxRows: 2,
    }, COPY)
    const lines = text.split('\n')
    expect(lines[3]).toBe('truncated 2/4')
    expect(lines[7]).toBe('time,open,high,low,close,volume,MA2')
    expect(lines[8]).toBe('2026-09-03,11,13,10,12,1012,11.5')
    expect(lines[9]).toBe('2026-09-04,12,14,11,13,1013,12.5')
    expect(lines).toHaveLength(11)
  })

  it('output key 跨组撞名：列头以「指标名.key」消歧；盘中周期 time 落到时分', () => {
    const klines = [kline(at(2026, 9, 1, 14, 30), 10)]
    const text = composeQuoteDataSection({
      market: 'crypto',
      symbol: 'BTCUSDT',
      interval: '1h',
      klines,
      indicatorGroups: [
        { id: 'a', title: 'Alpha', outputs: [{ key: 'line', values: [1] }] },
        { id: 'b', title: 'Beta', outputs: [{ key: 'line', values: [2] }] },
      ],
      klinesTool: 'crypto_get_klines',
    }, COPY)
    expect(text).toContain('time,open,high,low,close,volume,Alpha.line,Beta.line')
    expect(text.split('\n')[8]).toBe('2026-09-01 14:30,9,11,8,10,1010,1,2')
  })

  it('无指标：CSV 只剩基础六列；无 indicatorsTool 时省略复算行', () => {
    const text = composeQuoteDataSection({
      market: 'hk',
      symbol: '00700.HK',
      interval: '1w',
      klines: [kline(at(2026, 8, 31), 300)],
      indicatorGroups: [],
      klinesTool: 'hk_get_klines',
    }, COPY)
    const lines = text.split('\n')
    expect(lines[3]).toBe('full 1')
    expect(lines[7]).toBe('time,open,high,low,close,volume')
    expect(lines[8]).toBe('2026-08-31,299,301,298,300,1300')
  })

  it('空序列：返回空串（整段省略）', () => {
    const text = composeQuoteDataSection({
      market: 'cn',
      symbol: '600519.SH',
      interval: '1d',
      klines: [],
      indicatorGroups: [],
      klinesTool: 'cn_get_klines',
    }, COPY)
    expect(text).toBe('')
  })

  it('缺省 copy：回落 zh 默认文案（含数据位置与 warm-up 注记）', () => {
    const text = composeQuoteDataSection({
      market: 'cn',
      symbol: '600519.SH',
      interval: '1d',
      klines: [kline(at(2026, 9, 5), 1450)],
      indicatorGroups: [],
      klinesTool: 'cn_get_klines',
    })
    expect(text).toContain('【图表数据 · 与截图同一序列，可直接用于分析】')
    expect(text).toContain(`数据位置：market=cn · symbol=600519.SH · interval=1d · 共1根 · 2026-09-05 ~ 2026-09-05 · ${timezoneLabel()}`)
    expect(text).toContain('cn_get_klines 工具（symbol=600519.SH，interval=1d，limit=1）')
    expect(text).toContain('指标空值 = warm-up 未就绪')
  })
})
