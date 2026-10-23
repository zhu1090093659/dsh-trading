/**
 * 桥 K 线跨源解析用例（2026-10-15 契约，2026-10-23 窄修不变量 #9）：真 TradingBridge +
 * 真 createBridgeHost（无 mock 库），市场服务按本包既有手法用契约化假件经注册表注入——
 * 假件只提供真服务形状（含可选 klineCapabilities），并把「谁被调用、调用几次、返回了哪根
 * bar」留成证据。
 *
 * 判据（与 #resolveKlinesSources / klines 注释同源）：
 * - 候选序 = active 在最前，其后 registry.list(market) 其余项按 provider 名升序；
 * - active 声明覆盖请求 → 先用 active；否则取第一个声明覆盖的候选；无任何声明覆盖 → 用 active；
 * - 结构性缺能力：TRADING_UNSUPPORTED_INTERVAL 沿候选序一直试；
 * - 运行时故障：TRADING_NETWORK / TRADING_UPSTREAM_ERROR 也可兜底，但一次取数最多 1 次；
 * - 限流/坏符号/交易所业务错误原样抛、绝不换源；候选耗尽 → 原样抛最后一个错误；
 * - 整段同源（不拼接多源序列），provider 如实标注最终供数的那一个源。
 */
import { describe, expect, it } from 'vitest'
import type { Interval, Kline, KlineCapability, MarketDataService } from '@dshtrading/api'
import { fakeMarketService } from '@dshtrading/test-support'
import {
  BridgeProtocolError,
  TradingBridge,
  createBridgeHost,
  dispatchBridgeRequest,
  type BridgeHost,
  type MarketDataRegistryLike,
} from '../src/bridge.ts'

const DAY = Date.UTC(2026, 9, 14)

interface KlineCall {
  symbol: string
  interval: string
  limit: number | undefined
}

/** 记录 K 线入参的契约化假源：调用次数与顺序就是「谁供数」的证据。 */
interface FakeSource {
  readonly provider: string
  readonly service: MarketDataService
  readonly klineCalls: KlineCall[]
  readonly tickerCalls: string[]
}

/** 真服务形状的假件（无 mock 库）：只覆盖被测路径，其余方法给最小可用实现。 */
const fakeService = (overrides: Partial<MarketDataService> = {}): MarketDataService => fakeMarketService({
  getTicker: async symbol => ({ symbol, price: 100, timestamp: DAY }),
  ...overrides,
})

/** 连接器错误载体（真形状：Error + code，无需依赖连接器包）。 */
function tradingError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

/**
 * 一个假源：声明给定的 (周期, 深度)，取数时把 mark 编进返回的每根 bar（消费方按 close 判谁供数）。
 * klineError 给出时改为抛出该错误（用于结构性/运行时/不可兜底三类错误路径）；
 * barCount 给出时返回该根数（整段同源用例需要一眼看出「序列是否只有一家」）。
 */
function source(
  provider: string,
  mark: number,
  capabilities: readonly KlineCapability[],
  options: { klineError?: Error; barCount?: number } = {},
): FakeSource {
  const klineCalls: KlineCall[] = []
  const tickerCalls: string[] = []
  const service = fakeService({
    klineCapabilities: () => capabilities,
    getTicker: async symbol => {
      tickerCalls.push(symbol)
      return { symbol, price: mark, timestamp: DAY }
    },
    getKlines: async (symbol, interval, limit) => {
      klineCalls.push({ symbol, interval, limit })
      if (options.klineError !== undefined) throw options.klineError
      const bars: Kline[] = []
      for (let index = 0; index < (options.barCount ?? 1); index += 1) {
        bars.push({ openTime: index + 1, open: mark, high: mark, low: mark, close: mark, volume: mark, closeTime: index + 2 })
      }
      return bars
    },
  })
  return { provider, service, klineCalls, tickerCalls }
}

/** 声明若干周期同一深度的假源（多数用例的表格噪音）。 */
function depth(maxBars: number, intervals: readonly Interval[]): KlineCapability[] {
  return intervals.map(interval => ({ interval, maxBars }))
}

/** 注册表假件（真 MarketDataRegistryLike 形状）：active 与 list 按市场给出。 */
function registryOf(markets: Record<string, { active?: FakeSource; listed?: FakeSource[] }>): MarketDataRegistryLike {
  const toEntry = (entry: FakeSource): { provider: string; service: MarketDataService } => ({ provider: entry.provider, service: entry.service })
  return {
    active: market => {
      const entry = markets[market]?.active
      return entry === undefined ? undefined : toEntry(entry)
    },
    list: market => (markets[market]?.listed ?? []).map(toEntry),
  }
}

function bridgeWith(registry: MarketDataRegistryLike): TradingBridge {
  return new TradingBridge(createBridgeHost({ registry, legacy: () => undefined }))
}

/** 本机 cn 路由的真实形态：tencent 激活（无 1m/分钟深度 800），eastmoney 同市场注册（1m 2500）。 */
function cnSources(): { tencent: FakeSource; eastmoney: FakeSource; registry: MarketDataRegistryLike } {
  const tencent = source('tencent', 11, depth(800, ['5m', '30m', '1d', '1w', '1M']))
  const eastmoney = source('eastmoney', 22, depth(2500, ['1m', '5m', '15m', '30m', '1h', '1d', '1w', '1M']))
  return { tencent, eastmoney, registry: registryOf({ cn: { active: tencent, listed: [tencent, eastmoney] } }) }
}

describe('桥 K 线跨源解析（能力声明驱动，2026-10-15）', () => {
  it('运营在激活源结构性缺该周期时换用同市场声明覆盖的源（cn 1m：tencent → eastmoney）', async () => {
    // Given cn 路由 active=tencent（无 1m）、eastmoney 已注册且声明 1m/2500
    const { tencent, eastmoney, registry } = cnSources()

    // When 客户端按五日窗口取 cn 1m（limit=2500）
    const wire = await bridgeWith(registry).klines('cn', '600519', '1m', '2500')

    // Then eastmoney 供数、wire 标注真实来源，且 tencent 一次都没被调用（不是「试了再换」）
    expect(wire.provider).toBe('eastmoney')
    expect(wire.klines[0]?.close).toBe(22)
    expect(tencent.klineCalls).toEqual([])
    expect(eastmoney.klineCalls).toEqual([{ symbol: '600519', interval: '1m', limit: 2500 }])
  })

  it('运营在激活源声明覆盖请求时零跨源（cn 1d/100 仍由 tencent 供数）', async () => {
    // Given cn 路由 active=tencent 声明 1d/800，eastmoney 同市场也有 1d 能力
    const { tencent, eastmoney, registry } = cnSources()

    // When 取 cn 1d（limit=100，落在 tencent 的 800 深度内）
    const wire = await bridgeWith(registry).klines('cn', '600519', '1d', '100')

    // Then active 供数、provider=tencent，eastmoney 零调用（active 有能力就永远用 active）
    expect(wire.provider).toBe('tencent')
    expect(wire.klines[0]?.close).toBe(11)
    expect(tencent.klineCalls).toEqual([{ symbol: '600519', interval: '1d', limit: 100 }])
    expect(eastmoney.klineCalls).toEqual([])
  })

  it('运营在 list 里存在 provider 名更早的有能力者时仍用 active（候选序 active 在最前）', async () => {
    // Given active=tencent 声明覆盖 1d/800，list 里另有 provider 名排更前（aaa-broker）的有能力者
    const active = source('tencent', 11, depth(800, ['1d']))
    const earlier = source('aaa-broker', 99, depth(2500, ['1d']))
    const registry = registryOf({ cn: { active, listed: [earlier, active] } })

    // When 取 cn 1d/100
    const wire = await bridgeWith(registry).klines('cn', '600519', '1d', '100')

    // Then 仍用 active（不按 provider 名或深度偏好换源），更早的候选零调用
    expect(wire.provider).toBe('tencent')
    expect(wire.klines[0]?.close).toBe(11)
    expect(earlier.klineCalls).toEqual([])
  })

  it('运营在 active 声明覆盖却抛结构性错误时仍沿候选序兜底（声明只是预判，错误码才是事实）', async () => {
    // Given active 声明 1m/2500 但实际抛 TRADING_UNSUPPORTED_INTERVAL（实现与声明不一致）
    const active = source('tencent', 11, depth(2500, ['1m']), {
      klineError: tradingError('TRADING_UNSUPPORTED_INTERVAL', 'tencent klines: unsupported interval 1m'),
    })
    const eastmoney = source('eastmoney', 22, depth(2500, ['1m']))
    const registry = registryOf({ cn: { active, listed: [active, eastmoney] } })

    // When 取 cn 1m/2500
    const wire = await bridgeWith(registry).klines('cn', '600519', '1m', '2500')

    // Then 兜底到 eastmoney：active 先试（1 次），随后按候选序试下一个
    expect(wire.provider).toBe('eastmoney')
    expect(active.klineCalls).toEqual([{ symbol: '600519', interval: '1m', limit: 2500 }])
    expect(eastmoney.klineCalls).toEqual([{ symbol: '600519', interval: '1m', limit: 2500 }])
  })

  it('运营在双方都没声明能力时按候选序兜底（不论是否声明，未声明 ≠ 不支持）', async () => {
    // Given active（tencent）与 eastmoney 都未声明能力，active 抛结构性错误
    const active = source('tencent', 11, [], {
      klineError: tradingError('TRADING_UNSUPPORTED_INTERVAL', 'tencent klines: unsupported interval 1m'),
    })
    const eastmoney = source('eastmoney', 22, [])
    const registry = registryOf({ cn: { active, listed: [eastmoney, active] } })

    // When 取 cn 1m/2500
    const wire = await bridgeWith(registry).klines('cn', '600519', '1m', '2500')

    // Then 无声明覆盖 → 先用 active（未声明路径），结构性错误后兜底到 eastmoney
    expect(wire.provider).toBe('eastmoney')
    expect(active.klineCalls).toHaveLength(1)
    expect(eastmoney.klineCalls).toHaveLength(1)
  })

  it('运营在限流时不换源（TRADING_RATE_LIMITED 原样抛，同市场其它源零调用）', async () => {
    // Given active 声明覆盖 1d/800 但上游 429，list 里另有有能力者
    const active = source('tencent', 11, depth(800, ['1d']), {
      klineError: tradingError('TRADING_RATE_LIMITED', 'tencent kline: 429 too many requests'),
    })
    const eastmoney = source('eastmoney', 22, depth(2500, ['1d']))
    const registry = registryOf({ cn: { active, listed: [active, eastmoney] } })

    // When 取 cn 1d/100
    const call = bridgeWith(registry).klines('cn', '600519', '1d', '100')

    // Then 原样抛出（错误码与消息都不改写），eastmoney 零调用——429 是上游明确的「别打」信号，
    // 换源等于把压力摊给别家
    await expect(call).rejects.toThrowError(/429 too many requests/)
    await expect(call).rejects.toMatchObject({ code: 'TRADING_RATE_LIMITED' })
    expect(active.klineCalls).toHaveLength(1)
    expect(eastmoney.klineCalls).toEqual([])
  })

  it('运营在交易所业务错误时不换源（TRADING_EXCHANGE_ERROR 原样抛，其它源零调用）', async () => {
    // Given active 抛交易所业务错误（业务码/坏符号语义都走这条），list 里另有有能力者
    const active = source('tencent', 11, depth(800, ['1d']), {
      klineError: tradingError('TRADING_EXCHANGE_ERROR', 'tencent kline: msg param error'),
    })
    const eastmoney = source('eastmoney', 22, depth(2500, ['1d']))
    const registry = registryOf({ cn: { active, listed: [active, eastmoney] } })

    // When 取 cn 1d/100
    const call = bridgeWith(registry).klines('cn', '600519', '1d', '100')

    // Then 原样抛出该业务错误，eastmoney 零调用——业务错误说的是「这次请求本身不成立」，
    // 换个源答出来的数字不是同一个事实
    await expect(call).rejects.toThrowError(/msg param error/)
    await expect(call).rejects.toMatchObject({ code: 'TRADING_EXCHANGE_ERROR' })
    expect(active.klineCalls).toHaveLength(1)
    expect(eastmoney.klineCalls).toEqual([])
  })

  it('运营在坏符号时不换源（TRADING_SYMBOL_NOT_FOUND 原样抛，其它源零调用）', async () => {
    // Given active 抛坏符号，list 里另有有能力者
    const active = source('tencent', 11, depth(800, ['1d']), {
      klineError: tradingError('TRADING_SYMBOL_NOT_FOUND', 'tencent kline: unknown symbol 600519'),
    })
    const eastmoney = source('eastmoney', 22, depth(2500, ['1d']))
    const registry = registryOf({ cn: { active, listed: [active, eastmoney] } })

    // When 取 cn 1d/100
    const call = bridgeWith(registry).klines('cn', '600519', '1d', '100')

    // Then 原样抛出坏符号错误，eastmoney 零调用——坏符号不是「这个源答不出」
    await expect(call).rejects.toThrowError(/unknown symbol 600519/)
    await expect(call).rejects.toMatchObject({ code: 'TRADING_SYMBOL_NOT_FOUND' })
    expect(active.klineCalls).toHaveLength(1)
    expect(eastmoney.klineCalls).toEqual([])
  })

  it('运营在网络故障时兜底到同市场下一个已注册源（TRADING_NETWORK → eastmoney 供数并如实标注）', async () => {
    // Given active 声明覆盖 1d/800 却抛网络错误（单枪超时/连接已建立后的 HTTP 空回），
    // eastmoney 同市场有能力
    const active = source('tencent', 11, depth(800, ['1d']), {
      klineError: tradingError('TRADING_NETWORK', 'tencent kline: socket hang up'),
    })
    const eastmoney = source('eastmoney', 22, depth(2500, ['1d']))
    const registry = registryOf({ cn: { active, listed: [active, eastmoney] } })

    // When 取 cn 1d/100
    const wire = await bridgeWith(registry).klines('cn', '600519', '1d', '100')

    // Then 兜底源供数：数据与 provider 都指向 eastmoney（各打一次，故障源没有被重试）
    expect(wire.provider).toBe('eastmoney')
    expect(wire.klines[0]?.close).toBe(22)
    expect(active.klineCalls).toHaveLength(1)
    expect(eastmoney.klineCalls).toEqual([{ symbol: '600519', interval: '1d', limit: 100 }])
  })

  it('运营在上游 HTTP 非 2xx 时同样兜底一次（TRADING_UPSTREAM_ERROR → eastmoney 供数）', async () => {
    // Given active 声明覆盖 1d/800 却抛 TRADING_UPSTREAM_ERROR（HTTP 502），eastmoney 同市场有能力
    const active = source('tencent', 11, depth(800, ['1d']), {
      klineError: tradingError('TRADING_UPSTREAM_ERROR', 'tencent kline: HTTP 502'),
    })
    const eastmoney = source('eastmoney', 22, depth(2500, ['1d']))
    const registry = registryOf({ cn: { active, listed: [active, eastmoney] } })

    // When 取 cn 1d/100
    const wire = await bridgeWith(registry).klines('cn', '600519', '1d', '100')

    // Then 由 eastmoney 供数并标注它，原错误不外泄（兜底成功时不抛）
    expect(wire.provider).toBe('eastmoney')
    expect(wire.klines[0]?.close).toBe(22)
    expect(active.klineCalls).toHaveLength(1)
    expect(eastmoney.klineCalls).toHaveLength(1)
  })

  it('运营在运行时故障上最多兜底一次（三候选各抛网络错误时只打 2 个源）', async () => {
    // Given 候选序 tencent → aaa-broker → zebra-broker，三个候选全都抛网络错误
    const active = source('tencent', 11, [], { klineError: tradingError('TRADING_NETWORK', 'tencent: ETIMEDOUT') })
    const aaa = source('aaa-broker', 33, [], { klineError: tradingError('TRADING_NETWORK', 'aaa-broker: ETIMEDOUT') })
    const zebra = source('zebra-broker', 44, [], { klineError: tradingError('TRADING_NETWORK', 'zebra-broker: ETIMEDOUT') })
    const registry = registryOf({ cn: { active, listed: [zebra, aaa, active] } })

    // When 取 cn 1d/100
    const call = bridgeWith(registry).klines('cn', '600519', '1d', '100')

    // Then 只打了 2 个源（运行时故障的换源硬上界 = 1 次）：第 3 个候选零调用，
    // 抛出的是第 2 个候选的错误——不做「N 个源 × 各自枪数」的长链串联
    await expect(call).rejects.toThrowError(/aaa-broker: ETIMEDOUT/)
    await expect(call).rejects.toMatchObject({ code: 'TRADING_NETWORK' })
    expect(active.klineCalls).toHaveLength(1)
    expect(aaa.klineCalls).toHaveLength(1)
    expect(zebra.klineCalls).toEqual([])
  })

  it('运营在结构性缺能力时穿过多个候选（运行时故障的 1 次上界不削短结构路径）', async () => {
    // Given 候选序 tencent → aaa-broker → zebra-broker，前两个结构性抛 TRADING_UNSUPPORTED_INTERVAL，
    // 第三个有能力（三者都未声明能力，走未声明路径）
    const active = source('tencent', 11, [], { klineError: tradingError('TRADING_UNSUPPORTED_INTERVAL', 'tencent: unsupported 1m') })
    const aaa = source('aaa-broker', 33, [], { klineError: tradingError('TRADING_UNSUPPORTED_INTERVAL', 'aaa-broker: unsupported 1m') })
    const zebra = source('zebra-broker', 44, [])
    const registry = registryOf({ cn: { active, listed: [zebra, aaa, active] } })

    // When 取 cn 1m/2500
    const wire = await bridgeWith(registry).klines('cn', '600519', '1m', '2500')

    // Then 走到第 3 个候选才停：三个源各被打一次，最终由 zebra-broker 供数并标注
    expect(wire.provider).toBe('zebra-broker')
    expect(wire.klines[0]?.close).toBe(44)
    expect(active.klineCalls).toHaveLength(1)
    expect(aaa.klineCalls).toHaveLength(1)
    expect(zebra.klineCalls).toHaveLength(1)
  })

  it('运营在兜底后拿到整段单源序列（每根 bar 都来自最终源，provider 与之一致）', async () => {
    // Given active 抛网络错误，兜底源 eastmoney 一次给 3 根 bar（mark=22）
    const active = source('tencent', 11, depth(800, ['1d']), {
      klineError: tradingError('TRADING_NETWORK', 'tencent kline: empty reply'),
    })
    const eastmoney = source('eastmoney', 22, depth(2500, ['1d']), { barCount: 3 })
    const registry = registryOf({ cn: { active, listed: [active, eastmoney] } })

    // When 取 cn 1d/100
    const wire = await bridgeWith(registry).klines('cn', '600519', '1d', '100')

    // Then 整段来自 eastmoney：3 根 bar 的 close 全是 22（没有一根来自故障源的 11），provider 与之一致
    expect(wire.provider).toBe('eastmoney')
    expect(wire.klines.map(bar => bar.close)).toEqual([22, 22, 22])
    expect(wire.klines.some(bar => bar.close === 11)).toBe(false)
    expect(active.klineCalls).toHaveLength(1)
    expect(eastmoney.klineCalls).toHaveLength(1)
  })

  it('运营在候选耗尽时原样抛最后一个错误（绝不返回空序列冒充无数据）', async () => {
    // Given 三个候选都抛结构性错误（候选序：active 后按 provider 名升序 aaa-broker → zebra-broker）
    const active = source('tencent', 11, [], { klineError: tradingError('TRADING_UNSUPPORTED_INTERVAL', 'tencent: unsupported 1m') })
    const aaa = source('aaa-broker', 33, [], { klineError: tradingError('TRADING_UNSUPPORTED_INTERVAL', 'aaa-broker: unsupported 1m') })
    const zebra = source('zebra-broker', 44, [], { klineError: tradingError('TRADING_UNSUPPORTED_INTERVAL', 'zebra-broker: unsupported 1m') })
    const registry = registryOf({ cn: { active, listed: [zebra, aaa, active] } })

    // When 取 cn 1m/2500
    const call = bridgeWith(registry).klines('cn', '600519', '1m', '2500')

    // Then 抛的是**最后一个**候选的错误，且三个候选各被调用一次（按候选序，不是 list 原序）
    await expect(call).rejects.toThrowError(/zebra-broker: unsupported 1m/)
    expect(active.klineCalls).toHaveLength(1)
    expect(aaa.klineCalls).toHaveLength(1)
    expect(zebra.klineCalls).toHaveLength(1)
  })

  it('运营在宿主无注册表时只认 active（老宿主行为不变，wire 不标注 provider）', async () => {
    // Given 字面量宿主（无 marketRegistry，只有 getMarketService 解析出的一个服务）
    const service = source('tencent', 11, depth(800, ['1d']))
    const host: BridgeHost = {
      getMarketService: market => (market === 'cn' ? service.service : undefined),
      activeProvider: () => 'tencent',
    }

    // When 取 cn 1d/100
    const wire = await new TradingBridge(host).klines('cn', '600519', '1d', '100')

    // Then 行为与改动前一致：单候选、无跨源，且问不到 slug 时省略 provider 字段
    expect(wire.klines).toHaveLength(1)
    expect(wire).not.toHaveProperty('provider')
  })

  it('运营在路由指向未注册源时 K 线照旧 400（用户设置是权威，不为它换源）', async () => {
    // Given registry.active(cn) 无结果（设置选了未安装的 provider），list 里仍有已注册项
    const eastmoney = source('eastmoney', 22, depth(2500, ['1m']))
    const registry = registryOf({ cn: { listed: [eastmoney] } })

    // When 取 cn 1m/2500
    const call = bridgeWith(registry).klines('cn', '600519', '1m', '2500')

    // Then 400「未安装」，不静默改用注册表里的别家源
    await expect(call).rejects.toThrowError(BridgeProtocolError)
    await expect(call).rejects.toThrowError(/market cn is not installed/)
    expect(eastmoney.klineCalls).toEqual([])
  })
})

describe('桥 /markets 能力并集与 /tickers 指定源（2026-10-15）', () => {
  it('运营在 /markets 上报同市场全部注册项的能力并集（同周期取最大深度，未声明的市场不带该字段）', async () => {
    // Given cn 两个源分别声明 1m（1205 / 2500）与 1d（800），us 源未声明任何能力
    const cnA = source('akshare', 1, depth(1205, ['1m']))
    const cnB = source('eastmoney', 2, [...depth(2500, ['1m']), ...depth(800, ['1d'])])
    const usSource = source('yahoo', 3, [])
    const registry = registryOf({ cn: { active: cnB, listed: [cnA, cnB] }, us: { active: usSource, listed: [usSource] } })

    // When 请求 /markets
    const { status, payload } = await dispatchBridgeRequest(bridgeWith(registry), 'GET', '/markets', new URLSearchParams())
    const markets = (payload as { markets: Array<{ id: string; provider?: string; klineCapabilities?: KlineCapability[] }> }).markets

    // Then cn 项带并集（1m 取最大值 2500、1d 800），us 项不带该字段（缺省 = 未声明，不给空数组）
    expect(status).toBe(200)
    expect(markets.find(row => row.id === 'cn')).toEqual({
      id: 'cn',
      provider: 'eastmoney',
      klineCapabilities: [{ interval: '1m', maxBars: 2500 }, { interval: '1d', maxBars: 800 }],
    })
    expect(markets.find(row => row.id === 'us')).toEqual({ id: 'us', provider: 'yahoo' })
    expect(markets.find(row => row.id === 'us')).not.toHaveProperty('klineCapabilities')
  })

  it('用户指定已注册非 active 源时 /tickers 用该源取数（响应语义不变）', async () => {
    // Given cn 的 active=tencent、eastmoney 已注册但非 active
    const { tencent, eastmoney, registry } = cnSources()

    // When 显式按 provider=eastmoney 取一只标的
    const { status, payload } = await dispatchBridgeRequest(
      bridgeWith(registry), 'GET', '/tickers', new URLSearchParams({ market: 'cn', symbols: '600519', provider: 'eastmoney' }),
    )

    // Then eastmoney 取数（价格 22 = 该源假值），active 一次都没被调用
    expect(status).toBe(200)
    expect(payload).toEqual({ tickers: { '600519': { ok: true, ticker: { symbol: '600519', price: 22, timestamp: DAY } } } })
    expect(eastmoney.tickerCalls).toEqual(['600519'])
    expect(tencent.tickerCalls).toEqual([])
  })

  it('用户未指定源时 /tickers 维持现行 active 解析', async () => {
    // Given cn 的 active=tencent、eastmoney 已注册但非 active
    const { tencent, eastmoney, registry } = cnSources()

    // When 不带 provider 取一只标的
    const { payload } = await dispatchBridgeRequest(
      bridgeWith(registry), 'GET', '/tickers', new URLSearchParams({ market: 'cn', symbols: '600519' }),
    )

    // Then 用 active（价格 11 = tencent 假值），eastmoney 零调用
    expect(payload).toEqual({ tickers: { '600519': { ok: true, ticker: { symbol: '600519', price: 11, timestamp: DAY } } } })
    expect(tencent.tickerCalls).toEqual(['600519'])
    expect(eastmoney.tickerCalls).toEqual([])
  })

  it('用户指定未注册源时 /tickers 以 400 拒绝且零取数（不静默降级到 active）', async () => {
    // Given cn 只注册了 tencent 与 eastmoney
    const { tencent, eastmoney, registry } = cnSources()

    // When 指定一个未注册的 provider
    const call = dispatchBridgeRequest(
      bridgeWith(registry), 'GET', '/tickers', new URLSearchParams({ market: 'cn', symbols: '600519', provider: 'stooq' }),
    )

    // Then 400 并点名该 provider，两个已注册源都零调用
    await expect(call).rejects.toThrowError(BridgeProtocolError)
    await expect(call).rejects.toThrowError(/provider "stooq" is not a registered source of market cn/)
    expect(tencent.tickerCalls).toEqual([])
    expect(eastmoney.tickerCalls).toEqual([])
  })

  it('用户指定源但宿主没有注册表时 /tickers 同样以 400 拒绝', async () => {
    // Given 字面量宿主：只有 getMarketService，没有 marketRegistry
    const service = source('tencent', 11, [])
    const host: BridgeHost = {
      getMarketService: market => (market === 'cn' ? service.service : undefined),
      activeProvider: () => 'tencent',
    }

    // When 指定 provider=eastmoney
    const call = dispatchBridgeRequest(
      new TradingBridge(host), 'GET', '/tickers', new URLSearchParams({ market: 'cn', symbols: '600519', provider: 'eastmoney' }),
    )

    // Then 400（注册表缺席时无法证明该源已注册，不许猜），且零取数
    await expect(call).rejects.toThrowError(/is not a registered source of market cn/)
    expect(service.tickerCalls).toEqual([])
  })
})
