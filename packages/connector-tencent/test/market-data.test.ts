import { describe, expect, it } from 'vitest'
import type { TencentRestOptions } from '../src/rest.js'
import {
  INTERVAL_VOCABULARY,
  type TencentMarket,
  TencentRestClient,
  TradingServiceError,
  klineDateToEpochMs,
  normalizeCnSymbol,
  normalizeHkSymbol,
  wallTimeToEpochMs,
} from '../src/rest.js'

// 夹具为腾讯端点 2026-08-31 真实响应形态（原始字节证据 spikes/impl-cn-hk/r1-*.raw /
// r2-*.json）；中文名以 GBK 字节内嵌，验证 GBK 解码路径（UTF-8 解码会乱码）。
const CN_NAME_GBK = 'b9f3d6ddc3a9cca8' // 贵州茅台
const HK_NAME_GBK = 'ccdad1b6bfd8b9c9' // 腾讯控股

/** 把「ASCII 模板 + GBK 名字字节」拼成响应体（客户端按 GBK 解码）。 */
function gbkResponse(template: string, nameHex: string): Uint8Array {
  const [head, tail] = template.split('%NAME%')
  const nameBytes = nameHex.match(/../g)!.map((h) => parseInt(h, 16))
  const bytes = [
    ...Buffer.from(head, 'latin1'),
    ...nameBytes,
    ...Buffer.from(tail, 'latin1'),
  ]
  return new Uint8Array(bytes)
}

const CN_TICKER_TEMPLATE =
  'v_sh600519="1~%NAME%~600519~1297.40~1292.30~1289.00~16126~8576~7550~1297.35~5~1297.20~1~1297.10~3~1297.01~3~1297.00~11~1297.40~9~1297.50~11~1297.55~2~1297.68~1~1297.70~1~~20260828161500~5.10~0.39~1297.89~1288.00~1297.40/16126/2086008422~16126~208601~0.13~19.92~~1297.89~1288.00~0.77~16218.56~16218.56~6.46~1421.53~1163.07~0.54~-1~1293.56~18.22~19.70~~~0.10~208600.8422~168.6620~13~   A~GP-A~-3.84~1.93~4.01~32.41~27.30~1539.98~1151.01~-3.32~-3.94~4.63~1250081601~1250081601~-2.13~-6.26~1250081601~~~-6.94~0.02~~CNY~0~___D__F__N~1296.83~14~";\n'

const HK_TICKER_TEMPLATE =
  'v_r_hk00700="100~%NAME%~00700~455.200~447.800~444.000~27742475.0~0~0~455.200~0~0~0~0~0~0~0~0~0~455.200~0~0~0~0~0~0~0~0~0~27742475.0~2026/08/28 16:08:37~7.400~1.65~462.200~443.400~455.200~27742475.0~12655334445.330~0~16.65~~0~0~4.20~41437.5241~41437.5241~TENCENT~1.17~677.700~411.000~1.53~0.44~0~0~0~0~0~15.28~3.18~0.30~100~-23.33~-0.39~GP~20.41~11.00~3.45~-4.21~-2.40~9103146761.00~9103146761.00~15.77~5.309~456.172~-25.58~HKD~1~50";\n'

const CN_KLINE_JSON = JSON.stringify({
  code: 0,
  msg: '',
  data: {
    sh600519: {
      // 真实字段序：[date, open, close, high, low, volume] —— 开收高低量！
      qfqday: [
        ['2026-08-27', '1304.000', '1292.300', '1305.000', '1288.000', '24767.000'],
        ['2026-08-28', '1289.000', '1297.400', '1297.890', '1288.000', '16126.000'],
      ],
    },
  },
})

// hk 行第 7 个元素起是分红/回购附加对象与字符串（2026-08-31 实测 hk00700）。
const HK_KLINE_JSON = JSON.stringify({
  code: 0,
  msg: '',
  data: {
    hk00700: {
      qfqday: [
        ['2026-08-27', '447.000', '447.800', '448.200', '441.600', '33116469.000', { cqr: '2026-08-27', HGcontent: '回购68.00万股' }, '1.150', '4600000.000'],
        ['2026-08-28', '444.000', '455.200', '462.200', '443.400', '27742475.000', { cqr: '2026-08-28', HGcontent: '' }, '1.170', '4560000.000'],
      ],
    },
  },
})

/** 返回按 URL 片段分发的 fetch 桩，并记录全部请求 URL。 */
function stubFetch(routes: Array<{ match: string; body: Uint8Array | string; status?: number }>) {
  const urls: string[] = []
  const impl = (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input)
    urls.push(url)
    const route = routes.find((r) => url.includes(r.match))
    if (!route) throw new Error(`stubFetch: no route for ${url}`)
    const body = typeof route.body === 'string' ? new TextEncoder().encode(route.body) : route.body
    return new Response(body as BodyInit, {
      status: route.status ?? 200,
      headers: { 'content-type': 'text/html; charset=GBK' },
    })
  }) as typeof fetch
  return { impl, urls }
}

function client(market: TencentMarket, options: TencentRestOptions = {}): TencentRestClient {
  return new TencentRestClient(market, options)
}

describe('normalizeCnSymbol', () => {
  it('accepts bare / SH / sz prefixed codes and routes by leading digit', () => {
    expect(normalizeCnSymbol('600519')).toBe('sh600519')
    expect(normalizeCnSymbol('600519.SH')).toBe('sh600519') // 规范形输入（docs/symbol-vocabulary.md）
    expect(normalizeCnSymbol('000001.SZ')).toBe('sz000001') // 规范形后缀优先于首位推断
    expect(normalizeCnSymbol('SH600519')).toBe('sh600519')
    expect(normalizeCnSymbol('sh600519')).toBe('sh600519')
    expect(normalizeCnSymbol('000001')).toBe('sz000001')
    expect(normalizeCnSymbol('SZ000001')).toBe('sz000001')
    expect(normalizeCnSymbol('300750')).toBe('sz300750')
    expect(normalizeCnSymbol('688981')).toBe('sh688981')
  })

  it('rejects malformed codes', () => {
    expect(() => normalizeCnSymbol('AAPL')).toThrow(TradingServiceError)
    expect(() => normalizeCnSymbol('12345')).toThrow(TradingServiceError)
    expect(() => normalizeCnSymbol('')).toThrow(TradingServiceError)
  })
})

describe('normalizeHkSymbol', () => {
  it('zero-pads to 5 digits', () => {
    expect(normalizeHkSymbol('00700')).toBe('00700')
    expect(normalizeHkSymbol('700')).toBe('00700')
    expect(normalizeHkSymbol('00700.HK')).toBe('00700') // 规范形输入
    expect(normalizeHkSymbol('700.hk')).toBe('00700')
    expect(normalizeHkSymbol('5')).toBe('00005')
    expect(normalizeHkSymbol('99888')).toBe('99888')
  })

  it('rejects malformed codes', () => {
    expect(() => normalizeHkSymbol('0700A')).toThrow(TradingServiceError)
    expect(() => normalizeHkSymbol('123456')).toThrow(TradingServiceError)
    expect(() => normalizeHkSymbol('')).toThrow(TradingServiceError)
  })
})

describe('time parsing', () => {
  it('parses exchange wall clock with the correct timezone', () => {
    // 上海 UTC+8 无夏令时；香港 UTC+8。
    expect(wallTimeToEpochMs('2026-08-28T16:15:00', 'Asia/Shanghai')).toBe(Date.UTC(2026, 7, 28, 8, 15, 0))
    expect(wallTimeToEpochMs('2026/08/28 16:08:37', 'Asia/Hong_Kong')).toBe(Date.UTC(2026, 7, 28, 8, 8, 37))
    expect(klineDateToEpochMs('2026-08-28')).toBe(Date.UTC(2026, 7, 28))
  })
})

describe('TencentRestClient.getTicker (cn)', () => {
  it('decodes GBK, maps cn field layout and converts lots to shares', async () => {
    const { impl, urls } = stubFetch([{ match: 'qt.gtimg.cn', body: gbkResponse(CN_TICKER_TEMPLATE, CN_NAME_GBK) }])
    const ticker = await client('cn', { fetchImpl: impl }).getTicker('600519')
    expect(urls[0]).toBe('https://qt.gtimg.cn/q=sh600519')
    expect(ticker.name).toBe('贵州茅台') // UTF-8 误解码时这里是乱码——GBK 契约直证
    expect(ticker.symbol).toBe('600519.SH') // 输出规范形（docs/symbol-vocabulary.md）
    expect(ticker.price).toBe(1297.4)
    expect(ticker.bid).toBe(1297.35)
    expect(ticker.ask).toBe(1297.4)
    // cn 字段 6 单位是手（16126 手）→ 归一化为股 1,612,600。
    expect(ticker.volume).toBe(1_612_600)
    expect(ticker.timestamp).toBe(Date.UTC(2026, 7, 28, 8, 15, 0))
    expect(ticker).toMatchObject({
      market: 'cn',
      currency: 'CNY',
      prevClose: 1292.3,
      open: 1289,
      high: 1297.89,
      low: 1288,
      limitUp: 1421.53,
      limitDown: 1163.07,
      change: 5.1,
      changePercent: 0.39,
    })
  })

  it('accepts prefixed and lowercase symbols', async () => {
    const { impl, urls } = stubFetch([{ match: 'qt.gtimg.cn', body: gbkResponse(CN_TICKER_TEMPLATE, CN_NAME_GBK) }])
    await client('cn', { fetchImpl: impl }).getTicker('SH600519')
    expect(urls[0]).toBe('https://qt.gtimg.cn/q=sh600519')
  })

  it('maps unknown-symbol payload to TRADING_UNSUPPORTED_SYMBOL', async () => {
    const { impl } = stubFetch([{ match: 'qt.gtimg.cn', body: 'v_pv_none="1";' }])
    await expect(client('cn', { fetchImpl: impl }).getTicker('999999')).rejects.toMatchObject({ code: 'TRADING_UNSUPPORTED_SYMBOL' })
  })
})

describe('TencentRestClient.getTicker (hk)', () => {
  it('uses the r_hk wire prefix and maps the hk field layout', async () => {
    const { impl, urls } = stubFetch([{ match: 'qt.gtimg.cn', body: gbkResponse(HK_TICKER_TEMPLATE, HK_NAME_GBK) }])
    const ticker = await client('hk', { fetchImpl: impl }).getTicker('700')
    expect(urls[0]).toBe('https://qt.gtimg.cn/q=r_hk00700')
    expect(ticker.name).toBe('腾讯控股')
    expect(ticker.symbol).toBe('00700.HK') // 输出规范形
    expect(ticker.price).toBe(455.2)
    // hk 字段 6 单位是股（与 cn 的手不同，布局差异直证）。
    expect(ticker.volume).toBe(27_742_475)
    expect(ticker.timestamp).toBe(Date.UTC(2026, 7, 28, 8, 8, 37))
    expect(ticker).toMatchObject({
      market: 'hk',
      currency: 'HKD',
      prevClose: 447.8,
      open: 444,
      high: 462.2,
      low: 443.4,
      week52High: 677.7,
      week52Low: 411,
      change: 7.4,
      changePercent: 1.65,
    })
  })
})

describe('TencentRestClient.getKlines', () => {
  it('parses cn day klines with the open-close-high-low-volume field order', async () => {
    const { impl, urls } = stubFetch([{ match: 'fqkline/get', body: CN_KLINE_JSON }])
    const klines = await client('cn', { fetchImpl: impl }).getKlines('600519', '1d', 2)
    expect(urls[0]).toBe('https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=sh600519,day,,,2,qfq')
    expect(klines).toHaveLength(2)
    // 字段序陷阱直证：第 2 列是开、第 3 列是收（若按 OHLC 误读，open/high 会整体错位）。
    expect(klines[1]).toEqual({
      openTime: Date.UTC(2026, 7, 28),
      open: 1289,
      high: 1297.89,
      low: 1288,
      close: 1297.4,
      volume: 16126,
      closeTime: Date.UTC(2026, 7, 28) + 86_400_000 - 1,
    })
  })

  it('routes hk to hkfqkline with the hk prefix and drops extra row fields', async () => {
    const { impl, urls } = stubFetch([{ match: 'hkfqkline/get', body: HK_KLINE_JSON }])
    const klines = await client('hk', { fetchImpl: impl }).getKlines('00700', '1d', 2)
    expect(urls[0]).toBe('https://web.ifzq.gtimg.cn/appstock/app/hkfqkline/get?param=hk00700,day,,,2,qfq')
    expect(klines[1]).toMatchObject({ open: 444, close: 455.2, high: 462.2, low: 443.4, volume: 27_742_475 })
  })

  it('maps week/month intervals to qfqweek/qfqmonth', async () => {
    const weekJson = JSON.stringify({ code: 0, msg: '', data: { sh600519: { qfqweek: [['2026-08-21', '1295.000', '1272.830', '1308.880', '1272.010', '213505.000']] } } })
    const monthJson = JSON.stringify({ code: 0, msg: '', data: { sh600519: { qfqmonth: [['2026-07-31', '1180.100', '1350.600', '1362.000', '1166.330', '1164067.000']] } } })
    const { impl, urls } = stubFetch([
      { match: 'week', body: weekJson },
      { match: 'month', body: monthJson },
    ])
    const c = client('cn', { fetchImpl: impl })
    await c.getKlines('600519', '1w', 1)
    expect(urls[0]).toContain('param=sh600519,week,,,1,qfq')
    await c.getKlines('600519', '1M', 1)
    expect(urls[1]).toContain('param=sh600519,month,,,1,qfq')
  })

  it('rejects unsupported intervals and upstream param errors', async () => {
    const { impl } = stubFetch([{ match: 'fqkline/get', body: CN_KLINE_JSON }])
    const c = client('cn', { fetchImpl: impl })
    await expect(c.getKlines('600519', '1m')).rejects.toMatchObject({ code: 'TRADING_UNSUPPORTED_INTERVAL' })
    await expect(c.getKlines('600519', '5m')).rejects.toMatchObject({ code: 'TRADING_UNSUPPORTED_INTERVAL' })
    expect(INTERVAL_VOCABULARY).toEqual(['1d', '1w', '1M'])
  })

  it('maps upstream error payloads to TRADING_EXCHANGE_ERROR', async () => {
    const { impl } = stubFetch([{ match: 'fqkline/get', body: JSON.stringify({ code: 0, msg: 'param error', data: [] }) }])
    await expect(client('cn', { fetchImpl: impl }).getKlines('600519', '1d')).rejects.toMatchObject({ code: 'TRADING_UNSUPPORTED_SYMBOL' })
  })
})
