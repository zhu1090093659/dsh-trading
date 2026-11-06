import { createRequire } from 'node:module'
import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'
import { createAccountTools, createMarketReadTools } from '../src/market-tools.ts'
import { createResearchTools } from '../src/research-tools.ts'

async function createRuntime() {
  const require = createRequire(import.meta.url)
  const sdkRequire = createRequire(require.resolve('@deepseek-ai/dsh-tools'))
  const { SystemPrompt } = await import(sdkRequire.resolve('@deepseek-ai/dsh-system-prompt'))
  // 0.2.2 起工具执行拆成按 Agent 作用域选择的插件：只注册工具而没有加载执行器时
  // execute 抛 ToolExecutorUnavailableError，用官方原生执行器补齐组合。
  const { NativeToolExecutor } = await import(sdkRequire.resolve('@deepseek-ai/dsh-tool-executor-native'))
  const ctx = new Context()
  new SystemPrompt(ctx, SystemPrompt.Config({}))
  const runtime = new ToolRuntime(ctx)
  runtime.setExecutor(new NativeToolExecutor(ctx))
  return runtime
}

const marketRegistry = (provider: string, service: unknown) => ({ active: () => ({ provider, service }) as never })

const orderbookService = { getOrderbook: async () => ({ bids: [[100, 1]], asks: [[101, 1]], timestamp: 7 }) }
const accountService = {
  getPositions: async () => [{ symbol: 'AAPL', size: 3 }],
  listOpenOrders: async () => [{ id: 'o1', symbol: 'AAPL' }],
  listTradeFills: async () => [{ id: 'f1' }],
  getBalances: async () => [{ currency: 'USD', available: 1000 }],
  getOrder: async (symbol: string, id: string) => ({ symbol, id }),
  environment: () => ({ env: 'demo', simulated: true }),
}

describe('base tool output contract', () => {
  it('user receives the declared object and one identical compact JSON text for market and research tools', async () => {
    // Given: a real runtime carrying the host-plane read tools
    const runtime = await createRuntime()
    for (const tool of createMarketReadTools('us', () => marketRegistry('alpaca', orderbookService))) runtime.register(tool)
    for (const tool of createAccountTools('us', () => marketRegistry('alpaca', accountService))) runtime.register(tool)
    for (const tool of createResearchTools('us', () => ({ active: () => ({ provider: 'yahoo', service: { getTicker: async () => ({ symbol: 'AAPL', price: 1 }), getKlines: async () => [] } }) }) as never)) runtime.register(tool)
    const calls: Array<[string, Record<string, unknown>]> = [
      ['us_get_orderbook', { symbol: 'AAPL' }],
      ['us_get_positions', {}],
      ['us_get_orders', {}],
      ['us_get_fills', {}],
      ['us_get_balance', {}],
      ['us_get_order', { symbol: 'AAPL', orderId: 'o1' }],
      ['us_get_ticker', { symbol: 'AAPL' }],
      ['us_get_klines', { symbol: 'AAPL' }],
    ]
    // When: the user invokes each tool through the registry
    for (const [name, args] of calls) {
      // 0.2.2 起 execute 只接受批量输入，单调用在测试里收敛成一条调用的批次。
      const batch = await runtime.execute({ calls: [{ id: name, name, arguments: JSON.stringify(args) }], signal: new AbortController().signal })
      const result = batch.results[0]!.result
      // Then: the structured value and the model text are the same declaration-checked value
      expect(result.isError).toBe(false)
      expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(result.value) }])
    }
  })

  it('user never receives a malformed success value from the declared market output', async () => {
    // Given: the actual orderbook declaration fed an extra, non-declared provider field
    const runtime = await createRuntime()
    const bad = { getOrderbook: async () => { throw new Error('unreachable') } }
    const tool = createMarketReadTools('us', () => marketRegistry('alpaca', bad))[0]!
    // When: the tool's own execute is replaced with a value that violates the closed object
    const patched = { ...tool, execute: async () => ({ ok: true, market: 'us', provider: 'alpaca', symbol: 'AAPL', orderbook: {}, extra: 1 }) as never }
    runtime.register(patched as never)
    // Then: the registry rejects it instead of forwarding a shape the model was never promised
    const batch = await runtime.execute({ calls: [{ id: 'us_get_orderbook', name: 'us_get_orderbook', arguments: JSON.stringify({ symbol: 'AAPL' }) }], signal: new AbortController().signal })
    const result = batch.results[0]!.result
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result)).toMatch(/additionalProperties|is not a declared property/)
  })
})
