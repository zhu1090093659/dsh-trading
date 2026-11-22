import { describe, expect, it } from 'vitest'
import { strToU8, zipSync } from 'fflate'
import {
  ETF_RESCUE_BASKETS,
  addDays,
  basketScaleAt,
  computeEtfRescuePoints,
  etfScaleAt,
  findEtfRescueBasket,
  isTradingDate,
  normalizeEtfRescueSymbol,
  parseFundNavPayload,
  parseIndexCalibration,
  parseSseEtfShares,
  parseSzseEtfShares,
  parseTencentIndexCloses,
  resolveEtfRescueTarget,
  tradingDateMs,
  type EtfRescueSeries,
} from '../src/etf-rescue.js'

/** 测试用的整数量级：份额 1e12 份 × 净值 1 元/份 = 规模 1e12 元。 */
const SHARES = 1e12
const NAV = 1
/** 指数收盘 1000 点 × k 1e12 元/点 = 流通市值 1e15 元。 */
const CLOSE = 1000
const K = 1e12

const INDEX_CODES = ['000016', '000300', '000510', '000905', '000852', '000688', '399006'] as const

function codesOf(indexCodes: readonly string[]): string[] {
  return ETF_RESCUE_BASKETS.filter((basket) => indexCodes.includes(basket.indexCode)).flatMap((basket) => [...basket.etfs])
}

function byDate(codes: readonly string[], dates: readonly string[], value: number): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {}
  for (const code of codes) {
    const series: Record<string, number> = {}
    for (const date of dates) series[date] = value
    out[code] = series
  }
  return out
}

function ksFor(indexCodes: readonly string[], value = K): Record<string, number> {
  const out: Record<string, number> = {}
  for (const code of indexCodes) out[code] = value
  return out
}

/** 冻结口径的最小可算样本：两日、七个指数都有收盘、每个 ETF 都有份额与净值。 */
function baseSeries(dates: readonly string[]): EtfRescueSeries {
  const allEtfs = codesOf(INDEX_CODES)
  return {
    targetIndexCode: '000300',
    sharesByCode: byDate(allEtfs, dates, SHARES),
    navByCode: byDate(allEtfs, dates, NAV),
    closeByIndex: byDate(INDEX_CODES, dates, CLOSE),
    kByIndex: ksFor(INDEX_CODES),
    startDate: '2023-01-01',
  }
}

/** 造一个真实的 xlsx（zip）归档：单元格全部 inlineStr，与深交所实测形态一致。 */
function xlsxOf(rows: readonly (readonly string[])[]): Uint8Array {
  const columns = ['A', 'B', 'C', 'D']
  const all: (readonly string[])[] = [['日期', '基金代码', '基金简称', '基金规模(份)'], ...rows]
  let body = ''
  for (let index = 0; index < all.length; index += 1) {
    const row = all[index] as readonly string[]
    const rowNumber = index + 1
    let cells = ''
    for (let cellIndex = 0; cellIndex < row.length; cellIndex += 1) {
      const ref = (columns[cellIndex] as string) + rowNumber
      cells += '<c r="' + ref + '" s="2" t="inlineStr"><is><t>' + (row[cellIndex] as string) + '</t></is></c>'
    }
    body += '<row r="' + rowNumber + '">' + cells + '</row>'
  }
  const sheet =
    '<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
    body +
    '</sheetData></worksheet>'
  return zipSync({ 'xl/worksheets/sheet1.xml': strToU8(sheet), '[Content_Types].xml': strToU8('<Types/>') })
}

describe('上交所 ETF 份额解析', () => {
  it('用户看到 TOT_VOL 按万份换算成份，非白名单代码与坏行被跳过', () => {
    // Given: 上交所 commonQuery 的真实响应骨架（2024-02-05 实测 519 行，这里取三行）
    const payload = {
      result: [
        { STAT_DATE: '2024-02-05', SEC_CODE: '510300', TOT_VOL: '1970688.77' },
        { STAT_DATE: '2024-02-05', SEC_CODE: '600519', TOT_VOL: '9999' },
        { STAT_DATE: '2024-02-05', SEC_CODE: '510050', TOT_VOL: '-' },
      ],
    }

    // When: 解析成份额表
    const shares = parseSseEtfShares(payload)

    // Then: 万份 ×10000 得份，非白名单与非数字行不出现（不补 0）
    expect(shares).toEqual({ '510300': 19706887700 })
  })

  it('用户看到响应缺 result[] 时解析抛错，而不是静默回空表', () => {
    // Given: 上游形态异常的响应（没有 result 数组）
    const payload = { message: 'error' }

    // When/Then: 解析抛错（由网络层映射成 TRADING_UPSTREAM_ERROR）
    expect(() => parseSseEtfShares(payload)).toThrow(/result/)
  })
})

describe('深交所 xlsx 份额解析', () => {
  it('用户看到 inlineStr 单元格被解析，基金代码尾随空格被 trim', () => {
    // Given: 深交所实测形态的 xlsx（inlineStr，无 sharedStrings），代码列带尾随空格
    const xlsx = xlsxOf([
      ['2024-01-05', '159919 ', '沪深300ETF', '1204997623.00'],
      ['2024-01-05', '159001', '货币ETF', '16214101.00'],
      ['N/A', '159915', '创业板ETF', '100'],
    ])

    // When: 解 zip 并解析 sheet1.xml
    const byDateTable = parseSzseEtfShares(xlsx)

    // Then: 白名单代码被 trim 后留 159919；159001 不在白名单、日期非法的行都跳过
    expect(byDateTable).toEqual({ '2024-01-05': { '159919': 1204997623 } })
  })

  it('用户看到归档里没有 sheet1.xml 时抛错（上游形态变了要响亮）', () => {
    // Given: 一个不含 worksheet 成员的 zip
    const broken = zipSync({ 'xl/workbook.xml': strToU8('<workbook/>') })

    // When/Then: 解析抛错
    expect(() => parseSzseEtfShares(broken)).toThrow(/sheet1\.xml/)
  })
})

describe('规模 = 份额 × 净值', () => {
  it('用户看到单只 ETF 规模按份额乘净值计算，缺一侧即不参与（不补 0）', () => {
    // Given: 同一天里 A 有份额与净值、B 只有份额、C 的净值为 0
    const shares = { A: { '2026-11-20': 2e9 }, B: { '2026-11-20': 3e9 }, C: { '2026-11-20': 4e9 } }
    const navs = { A: { '2026-11-20': 1.5 }, B: { '2026-11-19': 1 }, C: { '2026-11-20': 0 } }
    const basket = findEtfRescueBasket('000016')

    // When: 算单只规模与篮子合计
    const scaleA = etfScaleAt('A', '2026-11-20', shares, navs)
    const scaleB = etfScaleAt('B', '2026-11-20', shares, navs)
    const basketScale = basketScaleAt({ ...(basket as NonNullable<typeof basket>), etfs: ['A', 'B', 'C'] }, '2026-11-20', shares, navs)

    // Then: A = 2e9 × 1.5 = 3e9；B 缺净值、C 净值为 0 都不计入合计
    expect(scaleA).toBe(3e9)
    expect(scaleB).toBeUndefined()
    expect(basketScale).toEqual({ scale: 3e9, contributors: 1 })
  })
})

describe('深度与广度公式', () => {
  it('用户看到深度 = 篮子规模 ÷ 指数流通市值，广度 = 六个篮子规模 ÷ 六个指数流通市值', () => {
    // Given: 两日完整三源数据；沪深300 四只 ETF、非300 十一只 ETF、各指数 close 1000 k 1e12
    const series = baseSeries(['2026-11-19', '2026-11-20'])

    // When: 出点
    const points = computeEtfRescuePoints(series)

    // Then: 深度 = 4e12/1e15×100 = 0.4；广度 = 11e12/6e15×100 = 11/60；日期为 UTC 当日 0 点
    expect(points).toHaveLength(2)
    expect(points[0]?.depthPct).toBeCloseTo(0.4, 12)
    expect(points[0]?.breadthPct).toBeCloseTo(11 / 60, 12)
    expect(points[0]?.date).toBe(tradingDateMs('2026-11-19'))
    expect(points[1]?.date).toBe(tradingDateMs('2026-11-20'))
    expect(points[0]?.date).toBeLessThan(points[1]?.date as number)
  })

  it('用户看到 ETF 缺净值/缺份额的交易日不参与合计，全部缺失则当日不出点', () => {
    // Given: 第二日 510310 缺净值、第三日沪深300 全部 ETF 缺份额
    const series = baseSeries(['2026-11-19', '2026-11-20', '2026-11-21'])
    const navByCode = { ...series.navByCode }
    navByCode['510310'] = { '2026-11-19': NAV }
    const sharesByCode = { ...series.sharesByCode }
    for (const code of ['510300', '510310', '510330', '159919']) {
      sharesByCode[code] = { '2026-11-19': SHARES, '2026-11-20': SHARES }
    }

    // When: 出点
    const points = computeEtfRescuePoints({ ...series, navByCode, sharesByCode })

    // Then: 第二日深度 = 3e12/1e15×100 = 0.3（不是 0.4，也没补 0）；第三日没有点
    expect(points.map((point) => point.depthPct)).toHaveLength(2)
    expect(points[0]?.depthPct).toBeCloseTo(0.4, 12)
    expect(points[1]?.depthPct).toBeCloseTo(0.3, 12)
    expect(points[1]?.date).toBe(tradingDateMs('2026-11-20'))
  })

  it('用户看到指数尚未发布（无收盘）时该指数整条不进广度合计', () => {
    // Given: 000510 只有第二日有收盘（指数 2024-09-23 才发布，更早日期没有点位）
    const series = baseSeries(['2026-11-19', '2026-11-20'])
    const closeByIndex = { ...series.closeByIndex }
    closeByIndex['000510'] = { '2026-11-20': CLOSE }

    // When: 出点
    const points = computeEtfRescuePoints({ ...series, closeByIndex })

    // Then: 第一日按五指数口径 = 8e12/5e15×100 = 0.16；第二日按六指数口径 = 11/60
    expect(points).toHaveLength(2)
    expect(points[0]?.breadthPct).toBeCloseTo(0.16, 12)
    expect(points[1]?.breadthPct).toBeCloseTo(11 / 60, 12)
  })

  it('用户看到回溯起点之前的日期与终点之后的日期都不出点', () => {
    // Given: 两日数据，但把起点设在第二日
    const series = baseSeries(['2026-11-19', '2026-11-20'])

    // When: 起点 2026-11-20、终点 2026-11-20
    const points = computeEtfRescuePoints({ ...series, startDate: '2026-11-20', endDate: '2026-11-20' })

    // Then: 只剩第二日一个点
    expect(points).toHaveLength(1)
    expect(points[0]?.date).toBe(tradingDateMs('2026-11-20'))
  })
})

describe('符号解析', () => {
  it('用户用 000300.SH / 000300 / SH000300 三种形态都能映射到沪深300 篮子', () => {
    // Given/When: 三种入参形态
    const forms = ['000300.SH', '000300', 'SH000300']
    const resolved = forms.map((form) => resolveEtfRescueTarget(form))

    // Then: 规范形一致、篮子名一致
    expect(resolved.map((item) => item.symbol)).toEqual(['000300.SH', '000300.SH', '000300.SH'])
    expect(resolved.map((item) => item.basket?.indexCode)).toEqual(['000300', '000300', '000300'])
    expect(resolved.map((item) => item.basket?.depthLabel)).toEqual(['沪深300ETF', '沪深300ETF', '沪深300ETF'])
  })

  it('用户传 sz399006 时映射到创业板指，传个股 600519.SH 时映射为空但符号规范化', () => {
    // Given/When: 深市指数前缀形与一只普通个股
    const index = resolveEtfRescueTarget('sz399006')
    const stock = resolveEtfRescueTarget('600519.SH')

    // Then: 指数命中白名单、个股符号规范化但篮子为空（调用方据此返回空 points）
    expect(index.basket?.indexCode).toBe('399006')
    expect(index.symbol).toBe('399006.SZ')
    expect(stock.basket).toBeUndefined()
    expect(stock.symbol).toBe('600519.SH')
    expect(normalizeEtfRescueSymbol('???')).toBeUndefined()
  })
})

describe('其余上游响应解析', () => {
  it('用户看到基金净值按 FSRQ/DWJZ 解析，Data 为 null 时按空表处理', () => {
    // Given: 两行真实形态的净值 + 一个 Data:null 的响应
    const payload = {
      Data: {
        LSJZList: [
          { FSRQ: '2026-11-20', DWJZ: '4.0286' },
          { FSRQ: '2026-11-19', DWJZ: '4.0594' },
          { FSRQ: '', DWJZ: '1' },
        ],
      },
      ErrCode: 0,
      TotalCount: 2,
    }

    // When/Then: 净值表只留合法行；null 形态不抛错
    expect(parseFundNavPayload(payload)).toEqual({ '2026-11-20': 4.0286, '2026-11-19': 4.0594 })
    expect(parseFundNavPayload({ Data: null })).toEqual({})
  })

  it('用户看到腾讯 K 线取下标 2 作为收盘，qfqday 形态同样解析', () => {
    // Given: day[] 行序 [日期, 开, 收, 高, 低, 量]
    const day = { data: { sh000300: { day: [['2026-11-20', '3925.740', '3954.570', '3961.070', '3894.470', '210744943.000']] } } }
    const qfq = { data: { sh000300: { qfqday: [['2026-11-19', '3900.000', '3880.000', '3910.000', '3870.000', '1']] } } }

    // When/Then: 收盘取 3954.57（不是开盘 3925.74），qfqday 也认
    expect(parseTencentIndexCloses(day, 'sh000300')).toEqual({ '2026-11-20': 3954.57 })
    expect(parseTencentIndexCloses(qfq, 'sh000300')).toEqual({ '2026-11-19': 3880 })
    expect(parseTencentIndexCloses({ data: {} }, 'sh000300')).toEqual({})
  })

  it('用户看到指数标定同时认 stock/get 的 f117÷f43 与 ulist 的 f21÷f2 两种形态', () => {
    // Given: 两个端点的实测骨架（000300 点位 3954.57、流通市值 4.82367490434e13）
    const stockGet = { data: { f43: 395457, f58: '沪深300', f117: 48236749043399.58 } }
    const ulist = { data: { total: 1, diff: [{ f2: 395457, f12: '000300', f14: '沪深300', f21: 48236749043400 }] } }

    // When: 解析两种形态
    const fromStock = parseIndexCalibration(stockGet)
    const fromList = parseIndexCalibration(ulist)

    // Then: 读数同值（差为上游取整），来源留痕
    expect(fromStock?.source).toBe('push2-stock-get')
    expect(fromStock?.close).toBeCloseTo(3954.57, 6)
    expect(fromList?.source).toBe('push2-ulist')
    expect(fromList?.floatMarketCap).toBe(48236749043400)
    expect(fromList?.close).toBe(3954.57)
    expect(parseIndexCalibration({ data: null })).toBeUndefined()
  })

  it('用户看到非法日期不被归一化成合法日，日期加减按 UTC 日历走', () => {
    // Given: 2 月 30 日这种不存在、闰年 2 月 29 日这种存在
    // When/Then: 只有真日期通过；跨月加减保留日历语义
    expect(isTradingDate('2024-02-30')).toBe(false)
    expect(isTradingDate('2024-02-29')).toBe(true)
    expect(addDays('2024-02-28', 2)).toBe('2024-03-01')
    expect(tradingDateMs('2024-02-29')).toBe(Date.UTC(2024, 1, 29))
  })
})
