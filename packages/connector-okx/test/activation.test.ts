/**
 * 互斥激活单测（主 agent 裁决 #1，方案 B+C）：两个连接器同树时只有激活者注册。
 *
 * 用真实 cordis Context（Service 基类需要活 context），但两个连接器各用自己的
 * context（对应真实部署里各自的 isolate realm——服务键提供互不见面），而工具注册表
 * 共享（对应 agent scope 看到的同一模型工具面——同名工具的碰撞面）。
 */
import { Context as CordisContext } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { apply as applyBinance } from '@dsh-trading/connector-binance'
import { apply as applyOkx, type Config } from '../src/index.js'

const OKX_DEFAULTS: Config = {
  enabled: false,
  env: 'demo',
  dryRun: true,
  liveTrading: false,
  apiKeyRef: 'OKX_API_KEY',
  secretRef: 'OKX_SECRET_KEY',
  passphraseRef: 'OKX_PASSPHRASE',
  demoApiKeyRef: 'OKX_DEMO_API_KEY',
  demoSecretRef: 'OKX_DEMO_SECRET_KEY',
  demoPassphraseRef: 'OKX_DEMO_PASSPHRASE',
}

function makeHost() {
  /** 共享工具注册表（模拟 agent scope 的同一模型工具面）。 */
  const registered = new Map<string, { name: string; owner: string }>()
  const logs: string[] = []
  const newCtx = () => {
    const ctx = new CordisContext() as unknown as {
      tools: unknown
      logger: unknown
      [key: string]: unknown
    }
    // dsh-tools 对同名重复注册直接抛错（会炸 boot/preset 挂载）；连接器的
    // duplicate-safe 注册必须先 get 检查。这里按 dsh-tools 同款语义模拟。
    ctx.tools = {
      register: (def: { name: string }) => {
        if (registered.has(def.name)) {
          throw new Error(`tool "${def.name}" is already registered in this scope`)
        }
        registered.set(def.name, { ...def, owner: 'unknown' })
      },
      get: (name: string) => registered.get(name),
    }
    ctx.logger = () => ({
      // 简易 printf：%s 依序替换（连接器 log 面只用 %s）。
      info: (...args: unknown[]) => logs.push(fmt(args)),
      warn: (...args: unknown[]) => logs.push(`WARN ${fmt(args)}`),
    })
    return ctx
  }
  return { registered, logs, newCtx }
}

function fmt(args: unknown[]): string {
  let out = String(args[0] ?? '')
  let i = 1
  while (out.includes('%s') && i < args.length) {
    out = out.replace('%s', String(args[i]))
    i += 1
  }
  return out
}

const wait = async (cond: () => boolean): Promise<void> => {
  await vi.waitFor(() => {
    if (!cond()) throw new Error('condition not met yet')
  })
}

const BINANCE_TOOLS = ['crypto_get_ticker', 'crypto_get_klines', 'crypto_place_order']
const OKX_TOOLS = [
  'crypto_get_ticker', 'crypto_get_klines', 'crypto_funding_rate',
  'crypto_place_order', 'crypto_cancel_order', 'crypto_get_order',
  'crypto_get_balance', 'crypto_get_positions',
]

describe('互斥激活（enabled 默认 false）', () => {
  it('默认组合（binance 激活 + okx 缺省）：只有 binance 注册工具，okx 静默退出一行 log', async () => {
    const host = makeHost()
    applyBinance(host.newCtx() as never, { enabled: true, dryRun: true, liveTrading: false })
    applyOkx(host.newCtx() as never, { ...OKX_DEFAULTS }) // enabled=false（默认）
    await wait(() => host.registered.size >= BINANCE_TOOLS.length)
    expect([...host.registered.keys()].sort()).toEqual([...BINANCE_TOOLS].sort())
    // okx 侧零注册 + 一行说明 log。
    expect(host.logs.some((line) => line.includes('not activated (enabled=false)'))).toBe(true)
    expect(host.logs.some((line) => line.includes('WARN'))).toBe(false)
  })

  it('okx 激活 + binance 同树：同名工具让位（先到先得 + warn），okx 独有面全部注册', async () => {
    const host = makeHost()
    applyBinance(host.newCtx() as never, { enabled: true, dryRun: true, liveTrading: false })
    applyOkx(host.newCtx() as never, { ...OKX_DEFAULTS, enabled: true })
    await wait(() => host.registered.size >= OKX_TOOLS.length)
    expect([...host.registered.keys()].sort()).toEqual([...OKX_TOOLS].sort())
    // 三个同名工具被跳过且留 warn。
    for (const name of BINANCE_TOOLS) {
      expect(host.logs.some((line) => line.includes(`tool ${name} already registered`))).toBe(true)
    }
  })

  it('okx 单独激活：全量注册（8 工具，含 tradingCryptoTrade 面的 5 个）', async () => {
    const host = makeHost()
    applyOkx(host.newCtx() as never, { ...OKX_DEFAULTS, enabled: true })
    await wait(() => host.registered.size >= OKX_TOOLS.length)
    expect([...host.registered.keys()].sort()).toEqual([...OKX_TOOLS].sort())
    expect(host.logs.some((line) => line.includes('WARN'))).toBe(false)
  })

  it('镜像切换（2026-08-29 对称化修复）：binance enabled=false + okx enabled=true → okx 全量注册、binance 静默退出', async () => {
    const host = makeHost()
    applyBinance(host.newCtx() as never, { enabled: false, dryRun: true, liveTrading: false })
    applyOkx(host.newCtx() as never, { ...OKX_DEFAULTS, enabled: true })
    await wait(() => host.registered.size >= OKX_TOOLS.length)
    expect([...host.registered.keys()].sort()).toEqual([...OKX_TOOLS].sort())
    // binance 零注册 + 一行说明 log；无同名冲突 warn。
    expect(host.logs.some((line) => line.includes('not activated (enabled=false)'))).toBe(true)
    expect(host.logs.some((line) => line.includes('WARN'))).toBe(false)
  })
})
