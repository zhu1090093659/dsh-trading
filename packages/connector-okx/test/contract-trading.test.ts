/**
 * 合约交易语义与闸门（P7 卡）：张↔币换算向量、杠杆/保证金模式（crypto_set_leverage）
 * 三态闸门、永续下单 tdMode 分流、持仓强平/保证金字段透传。
 *
 * 夹具走真实注入的函数缝（routeFetch 捕获请求 + 真实签名授权平面），不用通用 mock：
 * 判据是「发了什么请求 / 没发请求」，不是「被调用过」。
 */
import { installTestAuthority, type TestAuthority } from '@dshtrading/authority/testing'
import { Context as CordisContext } from '@deepseek-ai/cordis'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Config } from '../src/index.js'
import {
  OkxTradeService,
  TradingServiceError,
  coinsToContracts,
  contractsToCoins,
  createPlaceOrderTool,
  createSetLeverageTool,
  type OkxCredentials,
  type OkxInstrument,
} from '../src/index.js'
import { OkxRestClient } from '../src/rest.js'

/** 实盘授权夹具：闸门 ③ 只有拿到真实签名的平面才放行（不 mock 授权面）。 */
let testAuthority: TestAuthority | undefined
beforeAll(() => { testAuthority = installTestAuthority() })
afterAll(() => { testAuthority?.uninstall() })

function baseConfig(overrides: Partial<Config> = {}): Config {
  return {
    enabled: true,
    env: 'demo',
    dryRun: true,
    liveTrading: false,
    apiKeyRef: 'OKX_API_KEY',
    secretRef: 'OKX_SECRET_KEY',
    passphraseRef: 'OKX_PASSPHRASE',
    demoApiKeyRef: 'OKX_DEMO_API_KEY',
    demoSecretRef: 'OKX_DEMO_SECRET_KEY',
    demoPassphraseRef: 'OKX_DEMO_PASSPHRASE',
    ...overrides,
  }
}

interface Route {
  match: (url: string, init: RequestInit) => boolean
  respond: (url: string, init: RequestInit) => Response
}

interface Captured { url: string; method: string; body: string; headers: Record<string, string> }

/** 注入的 fetch 缝：命中路由则应答，未命中即炸（任何未预期的请求都算失败）。 */
function captureFetch(routes: Route[]): { fetchImpl: typeof fetch; calls: Captured[] } {
  const calls: Captured[] = []
  const fetchImpl = (async (input, init) => {
    const url = String(input)
    const requestInit = init ?? {}
    calls.push({
      url,
      method: String(requestInit.method ?? 'GET'),
      body: String(requestInit.body ?? ''),
      headers: (requestInit.headers ?? {}) as Record<string, string>,
    })
    const route = routes.find(r => r.match(url, requestInit))
    if (!route) throw new Error(`unexpected request: ${url}`)
    return route.respond(url, requestInit)
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

function okEnvelope(data: unknown): Response {
  return new Response(JSON.stringify({ code: '0', data }), { status: 200 })
}

function makeTradeService(fetchImpl: typeof fetch, configOverrides: Partial<Config> = {}): OkxTradeService {
  const credentials: OkxCredentials = { key: 'k', secret: 's', passphrase: 'p' }
  return new OkxTradeService(new CordisContext() as never, {
    client: new OkxRestClient({ baseUrl: 'https://okx.test', fetchImpl, clockSync: false, clockOffsetMs: 0 }),
    config: baseConfig(configOverrides),
    getCredentials: async () => credentials,
  })
}

/** 一张合约含 0.01 BTC、步进 1 张（换算向量用的粗网格）。 */
const SWAP_COARSE: OkxInstrument = {
  instId: 'BTC-USDT-SWAP', instType: 'SWAP', lotSz: 1, minSz: 1, tickSz: 0.1,
  ctVal: 0.01, ctValCcy: 'BTC', settleCcy: 'USDT', maxLeverage: 10,
}
/** 步进 0.01 张（细网格）。 */
const SWAP_FINE: OkxInstrument = {
  instId: 'ETH-USDT-SWAP', instType: 'SWAP', lotSz: 0.01, minSz: 0.01, tickSz: 0.01,
  ctVal: 0.01, ctValCcy: 'ETH', settleCcy: 'USDT', maxLeverage: 10,
}

/* ------------------------------------------------------------------ */
/* 张↔币换算向量                                                          */
/* ------------------------------------------------------------------ */

describe('OKX 张↔币换算向量（coinsToContracts / contractsToCoins）', () => {
  it('管理员：按 ctVal 换算张数并按 lotSz 向下取整，且张数×ctVal 恒不超过请求币数', () => {
    // Given 一张 ctVal=0.01、步进 1 张的永续规格与四组请求币数
    const vectors = [
      { coins: 0.01, contracts: 1, note: '恰好 1 张' },
      { coins: 0.029, contracts: 2, note: '2.9 张向下取整为 2 张' },
      { coins: 1.99, contracts: 199, note: '199 张整' },
      { coins: 0.0099, contracts: Number.NaN, note: '低于 minSz 1 张' },
    ]
    // When 逐组换算（最后一组按拒绝处理）
    // Then 前三维是精确张数，且换算结果绝不放大币数敞口
    for (const vector of vectors.slice(0, 3)) {
      const contracts = coinsToContracts(SWAP_COARSE.instId, SWAP_COARSE, vector.coins)
      expect(contracts).toBe(vector.contracts)
      expect(contracts * (SWAP_COARSE.ctVal ?? 0)).toBeLessThanOrEqual(vector.coins)
    }
    expect(() => coinsToContracts(SWAP_COARSE.instId, SWAP_COARSE, 0.0099)).toThrowError(/minSz/)
  })

  it('管理员：细步进网格同样只向下取整（0.029 BTC ÷ 0.01 张步进 = 2.9 张）', () => {
    // Given ctVal=0.01 ETH、lotSz=0.01 张的规格
    // When 换算 0.029 币
    const contracts = coinsToContracts(SWAP_FINE.instId, SWAP_FINE, 0.029)
    // Then 得到 2.9 张（网格步进未被跨越到 2.91 或 3）
    expect(contracts).toBeCloseTo(2.9, 10)
    expect(contracts * (SWAP_FINE.ctVal ?? 0)).toBeLessThanOrEqual(0.029)
  })

  it('管理员：请求量略低于整数张时不被向上取整（旧 1e-9 容差的事故样本回归）', () => {
    // Given ctVal=0.1、步进 1 张，请求 0.299999999999 币（恰好 3 张减 1e-12）
    const tickGrid: OkxInstrument = {
      instId: 'X-USDT-SWAP', instType: 'SWAP', lotSz: 1, minSz: 1, tickSz: 0.1,
      ctVal: 0.1, ctValCcy: 'X', settleCcy: 'USDT',
    }
    // When 换算张数
    const contracts = coinsToContracts(tickGrid.instId, tickGrid, 0.299999999999)
    // Then 取 2 张（旧实现的 floor(x + 1e-9) 会跳成 3 张，放大敞口）
    expect(contracts).toBe(2)
    expect(contracts * 0.1).toBeLessThanOrEqual(0.299999999999)
  })

  it('管理员：ctVal 缺席时拒绝换算，不虚构合约乘数', () => {
    // Given 一份没有 ctVal 的 SWAP 规格（交易所元数据缺失）
    const broken: OkxInstrument = { instId: 'X-USDT-SWAP', instType: 'SWAP', lotSz: 1, minSz: 1, tickSz: 0.1 }
    // When 尝试换算
    const error = (() => { try { return coinsToContracts(broken.instId, broken, 1) } catch (e: unknown) { return e } })()
    // Then 抛结构化错误并点明 ctVal，而不是按 1:1 猜乘数
    expect(error).toBeInstanceOf(TradingServiceError)
    expect((error as TradingServiceError).code).toBe('TRADING_EXCHANGE_ERROR')
    expect((error as TradingServiceError).message).toContain('ctVal')
  })

  it('管理员：contractsToCoins 在步进网格上与 coinsToContracts 互为逆运算', () => {
    // Given 步进 1 张的粗网格与三组「正好落在网格上」的张数
    // When 先张→币再生效回张
    // Then 网格上的值往返不变
    for (const contracts of [1, 7, 199]) {
      const coins = contractsToCoins(SWAP_COARSE.instId, SWAP_COARSE, contracts)
      expect(coins).toBeCloseTo(contracts * 0.01, 12)
      expect(coinsToContracts(SWAP_COARSE.instId, SWAP_COARSE, coins)).toBe(contracts)
    }
  })
})

/* ------------------------------------------------------------------ */
/* 杠杆/保证金模式（crypto_set_leverage）                                     */
/* ------------------------------------------------------------------ */

describe('OkxTradeService.setLeverage（三态闸门）', () => {
  it('管理员：dryRun 缺省时返回本地模拟回执，不发任何请求', async () => {
    // Given 空路由（任何出网都会炸）与缺省 dryRun 的杠杆设置请求
    const { fetchImpl, calls } = captureFetch([])
    const trade = makeTradeService(fetchImpl)
    // When 设置 3x 全仓
    const setting = await trade.setLeverage({ symbol: 'BTCUSDT-SWAP', leverage: 3, marginMode: 'cross' })
    // Then 回执标记 dryRun 且确实没触网，输出符号为规范形
    expect(setting).toMatchObject({ symbol: 'BTCUSDT-SWAP', leverage: 3, marginMode: 'cross', dryRun: true })
    expect(calls).toHaveLength(0)
  })

  it('管理员：dryRun=false 且未获实盘授权 → 结构化拒绝且不触网', async () => {
    // Given liveTrading=false（缺省）且未签授权平面
    const { fetchImpl, calls } = captureFetch([])
    const trade = makeTradeService(fetchImpl, { liveTrading: false })
    // When 请求真实设置杠杆
    const error = await trade.setLeverage({ symbol: 'BTCUSDT-SWAP', leverage: 3, marginMode: 'cross', dryRun: false })
      .catch((e: unknown) => e)
    // Then 拒绝码为 TRADING_LIVE_TRADING_DISABLED，且没有发出任何请求
    expect(error).toBeInstanceOf(TradingServiceError)
    expect((error as TradingServiceError).code).toBe('TRADING_LIVE_TRADING_DISABLED')
    expect(calls).toHaveLength(0)
  })

  it('管理员：dryRun=false + 已获授权 → 真实签名打 set-leverage，请求体与模拟盘头正确', async () => {
    // Given 已签授权平面、demo 环境，以及规格与 set-leverage 两个端点的应答
    const { fetchImpl, calls } = captureFetch([
      { match: u => u.includes('/api/v5/public/instruments'), respond: () => okEnvelope([{ ...SWAP_COARSE, lever: '10' }]) },
      { match: u => u.includes('/api/v5/account/set-leverage'), respond: () => okEnvelope([{ lever: '5', mgnMode: 'isolated', instId: 'BTC-USDT-SWAP' }]) },
    ])
    const trade = makeTradeService(fetchImpl, { dryRun: false, liveTrading: true, env: 'demo' })
    // When 设置 5x 逐仓多单
    const setting = await trade.setLeverage({ symbol: 'BTCUSDT-SWAP', leverage: 5, marginMode: 'isolated', posSide: 'long', dryRun: false })
    // Then 打到 set-leverage，请求体是张/模式/方向原样，demo 头在，回执 dryRun=false
    const post = calls.find(c => c.url.includes('/api/v5/account/set-leverage'))
    expect(post?.method).toBe('POST')
    expect(JSON.parse(post?.body ?? '{}')).toEqual({ instId: 'BTC-USDT-SWAP', lever: '5', mgnMode: 'isolated', posSide: 'long' })
    expect(post?.headers['x-simulated-trading']).toBe('1')
    expect(setting).toMatchObject({ symbol: 'BTCUSDT-SWAP', leverage: 5, marginMode: 'isolated', posSide: 'long', dryRun: false })
  })

  it('管理员：请求杠杆超过交易所规格上限 → 结构化拒绝且不发设置请求', async () => {
    // Given 交易所规格 lever=5
    const { fetchImpl, calls } = captureFetch([
      { match: u => u.includes('/api/v5/public/instruments'), respond: () => okEnvelope([{ ...SWAP_COARSE, lever: '5' }]) },
      { match: u => u.includes('/api/v5/account/set-leverage'), respond: () => okEnvelope([{ lever: '50' }]) },
    ])
    const trade = makeTradeService(fetchImpl, { dryRun: false, liveTrading: true })
    // When 请求 50x
    const error = await trade.setLeverage({ symbol: 'BTCUSDT-SWAP', leverage: 50, marginMode: 'cross', dryRun: false })
      .catch((e: unknown) => e)
    // Then 结构化拒绝并点明上限，且绝不静默截断后再发请求
    expect((error as TradingServiceError).code).toBe('TRADING_EXCHANGE_ERROR')
    expect((error as TradingServiceError).message).toContain('maximum lever 5')
    expect(calls.filter(c => c.url.includes('set-leverage'))).toHaveLength(0)
  })

  it('管理员：现货标的设杠杆 → TRADING_UNSUPPORTED_SYMBOL 且不触网', async () => {
    // Given 现货符号（非 -SWAP）
    const { fetchImpl, calls } = captureFetch([])
    const trade = makeTradeService(fetchImpl, { dryRun: false, liveTrading: true })
    // When 请求给现货设杠杆
    const error = await trade.setLeverage({ symbol: 'BTCUSDT', leverage: 3, marginMode: 'cross', dryRun: false })
      .catch((e: unknown) => e)
    // Then 结构化拒绝（现货是 cash，不是本能力面），一步网络都不走
    expect((error as TradingServiceError).code).toBe('TRADING_UNSUPPORTED_SYMBOL')
    expect(calls).toHaveLength(0)
  })
})

describe('crypto_set_leverage 工具（参数与回执）', () => {
  it('管理员：缺省 dryRun 的工具回执带 DRY-RUN 说明且不触网', async () => {
    // Given 真实交易服务 + 空路由（任何出网都会炸）
    const { fetchImpl, calls } = captureFetch([])
    const tool = createSetLeverageTool({ trade: makeTradeService(fetchImpl) })
    // When 调用工具设置 2x 全仓
    const receipt = JSON.parse(await tool.execute({ instId: 'btcusdt-swap', leverage: 2, marginMode: 'cross' })) as { dryRun?: boolean; note?: string; symbol?: string }
    // Then 回执是模拟且点明未发请求、上限只在真实路径校验
    expect(receipt.dryRun).toBe(true)
    expect(receipt.symbol).toBe('BTCUSDT-SWAP')
    expect(receipt.note).toContain('DRY-RUN')
    expect(calls).toHaveLength(0)
  })

  it('管理员：现货 instId 调用工具 → 参数错误，明确只接受永续', async () => {
    // Given 工具与现货 instId
    const { fetchImpl } = captureFetch([])
    const tool = createSetLeverageTool({ trade: makeTradeService(fetchImpl) })
    // When 用 BTCUSDT（现货）调用
    // Then 抛参数错误并点明不是永续，不进入任何交易路径
    await expect(tool.execute({ instId: 'BTCUSDT', leverage: 2 })).rejects.toThrowError(/not a perpetual/)
  })

  it('管理员：路由到的交易连接器未实现 setLeverage → TRADING_NOT_IMPLEMENTED', async () => {
    // Given 一个只有下单三件套、没有 setLeverage 的 TradeService 契约对象
    const trade = {} as never
    const tool = createSetLeverageTool({ trade })
    // When 调用工具
    const error = await tool.execute({ instId: 'BTCUSDT-SWAP', leverage: 2 }).catch((e: unknown) => e)
    // Then 报「未实现」而不是静默成功
    expect(error).toBeInstanceOf(TradingServiceError)
    expect((error as TradingServiceError).code).toBe('TRADING_NOT_IMPLEMENTED')
  })
})

/* ------------------------------------------------------------------ */
/* 永续下单的保证金模式与持仓字段                                               */
/* ------------------------------------------------------------------ */

describe('placeOrder 的保证金模式（tdMode 分流）', () => {
  it('管理员：marginMode=isolated → tdMode=isolated，且张数按 ctVal 换算', async () => {
    // Given 永续规格与下单应答，已获实盘的 demo 环境
    const { fetchImpl, calls } = captureFetch([
      { match: u => u.includes('/api/v5/public/instruments'), respond: () => okEnvelope([{ ...SWAP_COARSE, lotSz: '0.01', minSz: '0.01' }]) },
      { match: u => u.includes('/api/v5/trade/order'), respond: () => okEnvelope([{ ordId: 'iso-1', sCode: '0', sMsg: '' }]) },
    ])
    const trade = makeTradeService(fetchImpl, { dryRun: false, liveTrading: true })
    // When 下 0.02 BTC 的逐仓永续市价单
    await trade.placeOrder({ symbol: 'BTCUSDT-SWAP', side: 'buy', type: 'market', quantity: 0.02, marginMode: 'isolated', dryRun: false })
    // Then 请求体 tdMode=isolated、sz 换算成 2 张
    const post = calls.find(c => c.url.includes('/api/v5/trade/order'))
    expect(JSON.parse(post?.body ?? '{}')).toMatchObject({ tdMode: 'isolated', sz: '2', instId: 'BTC-USDT-SWAP' })
  })

  it('管理员：现货订单传 marginMode → TRADING_UNSUPPORTED_SYMBOL，绝不静默回落 cash', async () => {
    // Given 现货符号 + marginMode=cross（现货杠杆是另一个未接线产品面）
    const { fetchImpl, calls } = captureFetch([])
    const trade = makeTradeService(fetchImpl)
    // When 下这笔自相矛盾的订单
    const error = await trade.placeOrder({ symbol: 'BTC-USDT', side: 'buy', type: 'market', quantity: 0.01, marginMode: 'cross' })
      .catch((e: unknown) => e)
    // Then 结构化拒绝且没有任何请求（连模拟回执都不给，避免掩盖参数错误）
    expect((error as TradingServiceError).code).toBe('TRADING_UNSUPPORTED_SYMBOL')
    expect(calls).toHaveLength(0)
  })

  it('管理员：crypto_place_order 工具把 marginMode 透传给交易服务', async () => {
    // Given 一个记录调用的交易服务契约对象与行情缝
    const seen: Array<Record<string, unknown>> = []
    const trade = {
      async placeOrder(req: Record<string, unknown>) {
        seen.push(req)
        return { id: 'o-1', symbol: String(req.symbol), side: 'buy' as const, type: 'market' as const, status: 'new' as const, quantity: Number(req.quantity), dryRun: false, timestamp: 1 }
      },
    }
    const tool = createPlaceOrderTool({
      marketData: { getTicker: async () => ({ symbol: 'BTCUSDT-SWAP', price: 1, timestamp: 1 }) },
      trade: trade as never,
      config: baseConfig({ dryRun: false, liveTrading: true }),
    })
    // When 显式逐仓下单
    await tool.execute({ instId: 'BTCUSDT-SWAP', side: 'buy', type: 'market', quantity: 0.01, marginMode: 'isolated', dryRun: false })
    // Then 服务收到的 marginMode 原样
    expect(seen).toHaveLength(1)
    expect(seen[0]?.marginMode).toBe('isolated')
  })
})

describe('getPositions 的强平/保证金字段', () => {
  it('管理员：交易所回传的强平价/维持保证金率/保证金模式/名义价值原样透传', async () => {
    // Given OKX 持仓行（含 liqPx/mgnRatio/mgnMode/notionalUsd）与永续规格
    const { fetchImpl } = captureFetch([
      { match: u => u.includes('/api/v5/public/instruments'), respond: () => okEnvelope([SWAP_COARSE]) },
      {
        match: u => u.includes('/api/v5/account/positions'),
        respond: () => okEnvelope([{
          instId: 'BTC-USDT-SWAP', posSide: 'net', pos: '-2', avgPx: '42000', markPx: '42100',
          upl: '2', lever: '3', liqPx: '38500.5', mgnRatio: '0.8', mgnMode: 'isolated', notionalUsd: '84200', uTime: '1700000000000',
        }]),
      },
    ])
    const trade = makeTradeService(fetchImpl)
    // When 读取持仓
    const positions = await trade.getPositions()
    // Then 四个字段都带上交易所口径，仓位数量仍是币数（2 张 × 0.01 = 0.02）
    expect(positions).toHaveLength(1)
    expect(positions[0]).toMatchObject({
      symbol: 'BTCUSDT-SWAP', side: 'short', size: 0.02, leverage: 3,
      liquidationPrice: 38500.5, marginRatio: 0.8, marginMode: 'isolated', notionalUsd: 84200,
    })
  })

  it('管理员：交易所未回传的字段一律缺席（不本地补算强平价）', async () => {
    // Given 一行只有基础字段的持仓（交易所未给强平/保证金口径）
    const { fetchImpl } = captureFetch([
      { match: u => u.includes('/api/v5/public/instruments'), respond: () => okEnvelope([SWAP_COARSE]) },
      {
        match: u => u.includes('/api/v5/account/positions'),
        respond: () => okEnvelope([{ instId: 'BTC-USDT-SWAP', posSide: 'net', pos: '2', avgPx: '42000', uTime: '1700000000000' }]),
      },
    ])
    const trade = makeTradeService(fetchImpl)
    // When 读取持仓
    const positions = await trade.getPositions()
    // Then 缺席字段保持 undefined——「不是 0、不是算出来的值」
    expect(positions[0]?.liquidationPrice).toBeUndefined()
    expect(positions[0]?.marginRatio).toBeUndefined()
    expect(positions[0]?.marginMode).toBeUndefined()
  })
})
