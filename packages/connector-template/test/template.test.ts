/**
 * 【模板】骨架冒烟测试 —— 生成器展开后同样适用（断言按 token 常量比对，不依赖具体值）。
 *
 * 这里故意不写「实现级」测试：真实签名向量/映射表/字段解析是每个交易所自己的事
 * （参照 connector-okx 的 signature.test.ts/public-market-data.test.ts/trade.test.ts）。
 * 本文件守卫的是模板的结构性正确性：Config 默认值、闸门三态、凭证 ref 分组、
 * 互斥激活注册面、dry-run 回执不触网。
 */
import { Context as CordisContext } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import {
  apply,
  buildDryRunReceipt,
  credentialRefsFor,
  evaluateOrderGate,
  resolveCredentials,
  Config,
  type Config as ConfigType,
} from '../src/index.js'

const DEFAULTS: ConfigType = {
  enabled: false,
  env: 'demo',
  dryRun: true,
  liveTrading: false,
  apiKeyRef: '__ENV_PREFIX___API_KEY',
  secretRef: '__ENV_PREFIX___SECRET_KEY',
  passphraseRef: '__ENV_PREFIX___PASSPHRASE',
  demoApiKeyRef: '__ENV_PREFIX___DEMO_API_KEY',
  demoSecretRef: '__ENV_PREFIX___DEMO_SECRET_KEY',
  demoPassphraseRef: '__ENV_PREFIX___DEMO_PASSPHRASE',
}

describe('模板骨架', () => {
  it('导出面：Config schema 存在且默认值面 = enabled=false / dryRun=true / liveTrading=false（铁律 #3 默认面）', () => {
    expect(Config).toBeDefined()
    expect(DEFAULTS.enabled).toBe(false)
    expect(DEFAULTS.dryRun).toBe(true)
    expect(DEFAULTS.liveTrading).toBe(false)
    expect(DEFAULTS.env).toBe('demo')
  })

  it('凭证 ref 分组：live 用 live 组、demo 用 demo 组（demo/live key 不通用）', () => {
    const live = credentialRefsFor(DEFAULTS, 'live')
    expect(live.apiKeyRef.endsWith('_API_KEY')).toBe(true)
    expect(live.apiKeyRef).not.toContain('_DEMO_')
    const demo = credentialRefsFor(DEFAULTS, 'demo')
    expect(demo.apiKeyRef).toContain('_DEMO_')
  })

  it('resolveCredentials：凭证 seam 命中时返回三值，未命中抛 TRADING_CREDENTIALS_MISSING', async () => {
    const ctx = { get: () => ({ resolve: async (ref: string) => (ref.includes('_API_KEY') ? { value: 'k' } : ref.includes('SECRET') ? { value: 's' } : { value: 'p' }) }) }
    const creds = await resolveCredentials(ctx as never, DEFAULTS)
    expect({ key: creds.key, secret: creds.secret, passphrase: creds.passphrase }).toEqual({ key: 'k', secret: 's', passphrase: 'p' })
    await expect(resolveCredentials({ get: () => undefined } as never, DEFAULTS)).rejects
      .toMatchObject({ code: 'TRADING_CREDENTIALS_MISSING' })
  })

  it('闸门三态：①reject（dryRun=false + liveTrading=false）②simulate ③live（dryRun=false + liveTrading=true）', () => {
    const base: ConfigType = { ...DEFAULTS, liveTrading: false }
    expect(evaluateOrderGate(base, { symbol: 'X', side: 'buy', type: 'limit', quantity: 1 })).toEqual({ action: 'simulate' })
    expect(evaluateOrderGate(base, { symbol: 'X', side: 'buy', type: 'limit', quantity: 1, dryRun: false }).action).toBe('reject')
    const live: ConfigType = { ...DEFAULTS, liveTrading: true, env: 'demo', dryRun: false }
    expect(evaluateOrderGate(live, { symbol: 'X', side: 'buy', type: 'limit', quantity: 1, dryRun: false }))
      .toEqual({ action: 'live', environment: 'demo' })
    // config.dryRun 强制模拟：闸门判定顺序为先 reject 后 simulate——只有实盘解锁过
    // （liveTrading=true）的会话，config.dryRun=true 才会把显式 dryRun=false 压回 simulate。
    const forced: ConfigType = { ...DEFAULTS, liveTrading: true, env: 'demo', dryRun: true }
    expect(evaluateOrderGate(forced, { symbol: 'X', side: 'buy', type: 'limit', quantity: 1, dryRun: false }))
      .toEqual({ action: 'simulate' })
  })

  it('dry-run 回执不触网：行情失败时标注 unavailable，仍返回模拟成交', async () => {
    const marketData = { getTicker: vi.fn().mockRejectedValue(new Error('boom')) }
    const receipt = await buildDryRunReceipt(
      { symbol: 'XXX', side: 'buy', type: 'limit', quantity: 1, price: 100 },
      marketData as never,
    )
    const parsed = JSON.parse(receipt) as { status: string; dryRun: boolean; reference: { unavailable?: string } }
    expect(parsed.status).toBe('filled')
    expect(parsed.dryRun).toBe(true)
    expect(parsed.reference.unavailable).toBe('boom')
  })

  it('互斥激活：enabled=false 时 apply 零注册 + 一行说明 log', () => {
    const registered = new Map<string, { name: string }>()
    const logs: string[] = []
    const ctx = new CordisContext() as unknown as { tools: unknown; logger: unknown; [key: string]: unknown }
    ctx.tools = {
      register: (def: { name: string }) => { registered.set(def.name, def) },
      get: (name: string) => registered.get(name),
    }
    ctx.logger = () => ({ info: (...a: unknown[]) => logs.push(String(a[0])), warn: (...a: unknown[]) => logs.push(String(a[0])) })
    apply(ctx as never, DEFAULTS)
    expect(registered.size).toBe(0)
    expect(logs.some((line) => line.includes('not activated (enabled=false)'))).toBe(true)
  })

  it('互斥激活：enabled=true 时全量注册（含交易面 5 工具，共 7 工具）', async () => {
    const registered = new Map<string, { name: string }>()
    const ctx = new CordisContext() as unknown as { tools: unknown; logger: unknown; [key: string]: unknown }
    ctx.tools = {
      register: (def: { name: string }) => { if (registered.has(def.name)) throw new Error(`tool "${def.name}" already registered`); registered.set(def.name, def) },
      get: (name: string) => registered.get(name),
    }
    ctx.logger = () => ({ info: () => {}, warn: () => {} })
    apply(ctx as never, { ...DEFAULTS, enabled: true })
    await vi.waitFor(() => {
      if (registered.size < 7) throw new Error(`expected 7 tools, got ${registered.size}`)
    })
    expect([...registered.keys()].sort()).toEqual([
      '__MARKET___cancel_order', '__MARKET___get_balance', '__MARKET___get_klines',
      '__MARKET___get_order', '__MARKET___get_positions', '__MARKET___get_ticker',
      '__MARKET___place_order',
    ].sort())
  })
})
/**
 * dataplane 骨架冒烟（2026-08-30 注册表模式）：注册表在 → 注册 (market, slug) 且
 * 不占根市场键；enabled=false → 不注册；注册表缺席 → 回退直接 provide。
 */
describe('connector-template dataplane 骨架', () => {
  it('三态：注册表模式 / enabled 硬关 / 老部署回退', async () => {
    const { apply: dpApply } = await import('../src/dataplane.js')
    const registrations: Array<{ market: string; provider: string }> = []
    const provided: Record<string, unknown> = {}
    const registry = {
      register: (market: string, provider: string) => {
        registrations.push({ market, provider })
        return () => {}
      },
    }
    const mk = (withRegistry: boolean) => ({
      get: (key: string) => (key === 'tradingMarketDataRegistry' && withRegistry ? registry : undefined),
      isolate: () => ({ reflect: { provide: () => {} } }),
      effect: (fn: () => () => void) => { fn() },
      reflect: { provide: (name: string, value: unknown) => { provided[name] = value } },
    }) as never

    dpApply(mk(true), { ...DEFAULTS, enabled: true })
    expect(registrations).toEqual([{ market: '__MARKET__', provider: '__EXCHANGE_SLUG__' }])
    expect(Object.keys(provided)).toHaveLength(0) // 根市场键不被占用

    dpApply(mk(true), DEFAULTS) // enabled=false
    expect(registrations).toHaveLength(1)

    dpApply(mk(false), { ...DEFAULTS, enabled: true }) // 老部署回退
    expect(provided['trading__MARKET_CAP__MarketData']).toBeDefined()
  })
})
