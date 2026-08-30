/**
 * 指标数学内核单测：手算金值 + warm-up undefined 对齐 + 退化输入。
 * sma 两条用例自 chart-layout.test.ts 迁入（该模块随 SVG 图表退役）。
 */
import { describe, expect, it } from 'vitest'
import { bollinger, ema, kdj, macd, rsi, sma, stdev } from '../src/client/indicators/math.ts'

describe('sma', () => {
  it('暖期 undefined，之后为均值（金值自 chart-layout 迁入）', () => {
    expect(sma([1, 2, 3, 4, 5], 3)).toEqual([undefined, undefined, 2, 3, 4])
  })

  it('样本不足全 undefined；period 非法退化', () => {
    expect(sma([1, 2], 5)).toEqual([undefined, undefined])
    expect(sma([1, 2, 3], 0)).toEqual([undefined, undefined, undefined])
  })
})

describe('ema', () => {
  it('种子 = 前 period 个 SMA，其后 EMA 递推', () => {
    // seed=(1+2+3)/3=2；k=0.5；out[3]=4*0.5+2*0.5=3；out[4]=5*0.5+3*0.5=4
    expect(ema([1, 2, 3, 4, 5], 3)).toEqual([undefined, undefined, 2, 3, 4])
  })
})

describe('stdev / bollinger', () => {
  it('stdev 总体口径', () => {
    const out = stdev([1, 2, 3, 4, 5], 3)
    expect(out[2]).toBeCloseTo(Math.sqrt(2 / 3), 10)
    expect(out[4]).toBeCloseTo(Math.sqrt(2 / 3), 10)
  })

  it('bollinger 三轨 = 中轨 ± mult×标准差', () => {
    const { mid, upper, lower } = bollinger([1, 2, 3, 4, 5], 3, 2)
    expect(mid[2]).toBe(2)
    expect(upper[2]).toBeCloseTo(2 + 2 * Math.sqrt(2 / 3), 10)
    expect(lower[2]).toBeCloseTo(2 - 2 * Math.sqrt(2 / 3), 10)
    expect(upper[0]).toBeUndefined()
  })
})

describe('macd', () => {
  it('DIF/DEA/柱 三线对齐（快2 慢3 信号2）', () => {
    const { dif, dea, hist } = macd([1, 2, 3, 4, 5], 2, 3, 2)
    // emaFast=[_,1.5,2.5,3.5,4.5]，emaSlow=[_,_,2,3,4] → dif=[_,_,0.5,0.5,0.5]
    expect(dif[2]).toBeCloseTo(0.5, 10)
    expect(dif[4]).toBeCloseTo(0.5, 10)
    // DEA = DIF 的 EMA(2)：需要 2 个 DIF 值，首个定义位在 index 3
    expect(dea[2]).toBeUndefined()
    expect(dea[3]).toBeCloseTo(0.5, 10)
    expect(hist[3]).toBeCloseTo(0, 10)
    expect(hist[2]).toBeUndefined()
  })

  it('趋势上行时 DIF > 0', () => {
    const values = Array.from({ length: 40 }, (_, i) => 10 + i)
    const { dif } = macd(values, 12, 26, 9)
    const last = dif[39]
    expect(last).toBeDefined()
    expect(last).toBeGreaterThan(0)
  })
})

describe('rsi', () => {
  it('混合序列金值（period 3）', () => {
    const out = rsi([10, 11, 12, 11, 14], 3)
    expect(out[0]).toBeUndefined()
    expect(out[1]).toBeUndefined()
    expect(out[2]).toBeUndefined()
    expect(out[3]).toBeCloseTo(66.6667, 4)
    expect(out[4]).toBeCloseTo(86.6667, 4)
  })

  it('单边上涨 → 100', () => {
    const out = rsi([1, 2, 3, 4, 5, 6], 3)
    expect(out[3]).toBe(100)
    expect(out[5]).toBe(100)
  })
})

describe('kdj', () => {
  it('RSV→SMA 平滑金值（n=2，初始 50）', () => {
    const { k, d, j } = kdj([2, 3, 4, 5], [1, 2, 3, 4], [1.5, 2.5, 3.5, 4.5], 2)
    expect(k[0]).toBeUndefined()
    expect(k[1]).toBeCloseTo(58.3333, 4)
    expect(d[1]).toBeCloseTo(52.7778, 4)
    expect(j[1]).toBeCloseTo(69.4444, 4)
    expect(k[2]).toBeCloseTo(63.8889, 4)
    expect(d[2]).toBeCloseTo(56.4815, 4)
    expect(j[2]).toBeCloseTo(78.7037, 4)
  })

  it('warm-up 前全 undefined', () => {
    const { k } = kdj([1, 2, 3], [0.5, 1, 2], [0.8, 1.5, 2.5], 3)
    // rsv=(2.5-0.5)/(3-0.5)*100=80 → k=50+(80-50)/3=60
    expect(k).toEqual([undefined, undefined, 60])
  })
})
