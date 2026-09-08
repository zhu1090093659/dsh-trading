/**
 * crypto_get_derivatives_history：数据源是路由选中的 crypto 行情服务（registry-first，
 * 只读）。覆盖 issue #86 / 审计缺口卡 G8 的验收面：幂等注册、成功路径、limit 截断、
 * 缺方法 → TRADING_NOT_IMPLEMENTED、无 provider → TRADING_NO_PROVIDER、非法 limit。
 */
import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { apply, createGetDerivativesHistoryTool } from '../src/index.ts'

const TOOL_NAME = 'crypto_get_derivatives_history'

/** 固定 history（4 点，时间升序），供成功路径与截断断言共用。 */
const HISTORY = {
  symbol: 'BTCUSDT-SWAP',
  source: 'binance',
  fundingRates: [
    { time: 1_772_390_400_000, value: 0.0001 },
    { time: 1_772_418_800_000, value: 0.0002 },
    { time: 1_772_447_200_000, value: -0.0001 },
    { time: 1_772_475_600_000, value: 0.00005 },
  ],
  openInterest: [
    { time: 1_772_390_400_000, value: 70_000 },
    { time: 1_772_418_800_000, value: 71_000 },
    { time: 1_772_447_200_000, value: 72_000 },
    { time: 1_772_475_600_000, value: 73_000 },
  ],
}

interface FakeTool {
  name: string
  execute(raw: unknown): Promise<unknown>
}

interface FakeEntry {
  provider: string
  service: Record<string, unknown>
}

/** 最小注册表替身：只认 crypto 市场（与 MarketDataRegistryService.active 同形）。 */
function registryWith(entry: FakeEntry | undefined) {
  return { active: (market: string) => (market === 'crypto' ? entry : undefined) }
}

/** 直接以注入的 registry 构造工具（绕过 apply，测 execute 语义）。 */
function toolFor(registry: unknown): FakeTool {
  return createGetDerivativesHistoryTool({ getRegistry: () => registry as never }) as unknown as FakeTool
}

/** 假 cordis Context：apply 只需 skills/tools/logger/get/inject。 */
function makeCtx(registry?: unknown) {
  const registered = new Map<string, FakeTool>()
  const register = vi.fn((tool: FakeTool) => {
    registered.set(tool.name, tool)
    return tool
  })
  const ctx = {
    skills: { registerProvider: vi.fn() },
    tools: { register, get: (name: string) => registered.get(name) },
    logger: () => ({ info: vi.fn() }),
    get: (key: string) => (key === 'tradingMarketDataRegistry' ? registry : undefined),
    inject: vi.fn(),
  } as unknown as Context
  return { ctx, register, registered }
}

describe(TOOL_NAME, () => {
  it('幂等注册：重复 apply 只注册一次', () => {
    const { ctx, register, registered } = makeCtx(
      registryWith({ provider: 'binance', service: { getDerivativesHistory: vi.fn(async () => HISTORY) } }),
    )
    apply(ctx, { dryRun: true, liveTrading: false })
    apply(ctx, { dryRun: true, liveTrading: false })
    expect(register.mock.calls.filter(([tool]) => tool.name === TOOL_NAME)).toHaveLength(1)
    expect(registered.has(TOOL_NAME)).toBe(true)
  })

  it('成功路径：registry-first 取激活 crypto provider，返回 ok/market/provider/symbol/history', async () => {
    const getDerivativesHistory = vi.fn(async () => HISTORY)
    const { ctx, registered } = makeCtx(registryWith({ provider: 'binance', service: { getDerivativesHistory } }))
    apply(ctx, { dryRun: true, liveTrading: false })

    const tool = registered.get(TOOL_NAME)
    expect(tool).toBeDefined()
    const payload = JSON.parse((await tool!.execute({ symbol: 'BTCUSDT' })) as string)

    expect(payload.ok).toBe(true)
    expect(payload.market).toBe('crypto')
    expect(payload.provider).toBe('binance')
    // 服务返回值里的 symbol 是市场规范形（BTCUSDT-SWAP），优先回显它
    expect(payload.symbol).toBe('BTCUSDT-SWAP')
    expect(payload.history).toEqual(HISTORY)
    expect(payload.truncatedTo).toBeUndefined()
    expect(getDerivativesHistory).toHaveBeenCalledWith('BTCUSDT')
  })

  it('limit 生效：尾部截取最近 N 条并返回 truncatedTo', async () => {
    const tool = toolFor(registryWith({ provider: 'okx', service: { getDerivativesHistory: async () => HISTORY } }))
    const payload = JSON.parse((await tool.execute({ symbol: 'BTCUSDT-SWAP', limit: 2 })) as string)

    expect(payload.truncatedTo).toBe(2)
    expect(payload.history.fundingRates).toEqual(HISTORY.fundingRates.slice(-2))
    expect(payload.history.openInterest).toEqual(HISTORY.openInterest.slice(-2))
    expect(payload.history.fundingRates).toHaveLength(2)
    expect(payload.history.openInterest).toHaveLength(2)
    // 未截断字段原样保留
    expect(payload.history.symbol).toBe('BTCUSDT-SWAP')
    expect(payload.history.source).toBe('binance')
  })

  it('服务缺可选方法 → TRADING_NOT_IMPLEMENTED（绝不返回空数组冒充无数据）', async () => {
    const tool = toolFor(registryWith({ provider: 'ccxt', service: { getTicker: vi.fn() } }))
    await expect(tool.execute({ symbol: 'BTCUSDT' })).rejects.toThrow('TRADING_NOT_IMPLEMENTED')
  })

  it('registry 缺席 / crypto 无激活 provider → TRADING_NO_PROVIDER', async () => {
    await expect(toolFor(undefined).execute({ symbol: 'BTCUSDT' })).rejects.toThrow('TRADING_NO_PROVIDER')
    await expect(toolFor(registryWith(undefined)).execute({ symbol: 'BTCUSDT' })).rejects.toThrow('TRADING_NO_PROVIDER')
    // 其它市场有 provider 不代表 crypto 有
    const otherMarketOnly = { active: (market: string) => (market === 'crypto' ? undefined : { provider: 'yahoo', service: {} }) }
    await expect(toolFor(otherMarketOnly).execute({ symbol: 'BTCUSDT' })).rejects.toThrow('TRADING_NO_PROVIDER')
  })

  it('非法 limit → 抛错说明 1..200；边界 1 与 200 合法', async () => {
    const tool = toolFor(registryWith({ provider: 'binance', service: { getDerivativesHistory: async () => HISTORY } }))
    // 越界整数：execute 内裁决，文案含 1..200
    for (const limit of [0, -1, 201, 1000]) {
      await expect(tool.execute({ symbol: 'BTCUSDT', limit })).rejects.toThrow(/1\.\.200/)
    }
    // 非数字/非有限值：defineTool 参数校验层直接拒绝（不会落到 execute）
    for (const limit of [Number.NaN, Number.POSITIVE_INFINITY, '10']) {
      await expect(tool.execute({ symbol: 'BTCUSDT', limit })).rejects.toThrow(/limit/)
    }
    // 真截断：truncated=true + truncatedTo=limit + 序列截到 limit（审查 P2-5）。
    const one = JSON.parse((await tool.execute({ symbol: 'BTCUSDT', limit: 1 })) as string)
    expect(one.truncated).toBe(true)
    expect(one.truncatedTo).toBe(1)
    expect(one.history.fundingRates).toHaveLength(1)
    // 序列比 limit 短：不算截断，不回显 truncatedTo（此前无条件回显请求值）。
    const max = JSON.parse((await tool.execute({ symbol: 'BTCUSDT', limit: 200 })) as string)
    expect(max.truncated).toBe(false)
    expect(max.truncatedTo).toBeUndefined()
    expect(max.history.openInterest).toHaveLength(4)
  })

  it('缺 symbol 或 provider 返回非法载荷 → 抛错（不伪造空序列）', async () => {
    const tool = toolFor(registryWith({ provider: 'binance', service: { getDerivativesHistory: async () => HISTORY } }))
    // 缺参：defineTool 参数校验层拒绝；空白串：execute 内裁决
    await expect(tool.execute({})).rejects.toThrow(/symbol/)
    await expect(tool.execute({ symbol: '   ' })).rejects.toThrow('symbol parameter is required')

    const malformed = toolFor(registryWith({ provider: 'binance', service: { getDerivativesHistory: async () => undefined } }))
    await expect(malformed.execute({ symbol: 'BTCUSDT' })).rejects.toThrow('invalid derivatives history payload')
  })
})
