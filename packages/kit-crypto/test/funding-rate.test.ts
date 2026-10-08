/**
 * crypto_funding_rate（kit-crypto）：规范形输入互译与输出回显（P6）。
 * 契约化 fake fetch（普通函数 + URL 记录），不出网、不使用通用 mock 工具。
 */
import { describe, expect, it } from 'vitest'
import { createFundingRateTool } from '../src/index.ts'

interface ToolLike {
  execute(raw: unknown): Promise<unknown>
}

const RECORDS = [
  { symbol: 'BTCUSDT', fundingTime: 1_700_000_000_000, fundingRate: '0.00010000', markPrice: '42000.5' },
]

/** 契约化 fake fetch：记录请求 URL 并回放固定记录。 */
function fundingFetch(rows: unknown[], status = 200): { fetchImpl: typeof globalThis.fetch; urls: string[] } {
  const urls: string[] = []
  const fetchImpl = (async (input: RequestInfo | URL) => {
    urls.push(String(input))
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => '',
      json: async () => rows,
    } as unknown as Response
  }) as unknown as typeof globalThis.fetch
  return { fetchImpl, urls }
}

function toolFor(fetchImpl: typeof globalThis.fetch): ToolLike {
  return createFundingRateTool({ fetch: fetchImpl }) as unknown as ToolLike
}

describe('crypto_funding_rate 符号口径（P6 规范形）', () => {
  it('用户：永续规范形与交易所原生形互译到同一 fapi 符号，输出回显规范形', async () => {
    // Given: 同一永续的两种写法（规范形 BTCUSDT-SWAP / OKX 原生形 BTC-USDT-SWAP）
    const canonical = fundingFetch(RECORDS)
    const native = fundingFetch(RECORDS)
    // When: 分别调用工具
    const fromCanonical = (await toolFor(canonical.fetchImpl).execute({ symbol: 'BTCUSDT-SWAP' })) as string
    const fromNative = (await toolFor(native.fetchImpl).execute({ symbol: 'BTC-USDT-SWAP' })) as string
    // Then: REST 边界译成 Binance 原生形，两条输出都回显同一规范形
    expect(canonical.urls[0]).toContain('symbol=BTCUSDT')
    expect(native.urls[0]).toContain('symbol=BTCUSDT')
    expect(fromCanonical).toContain('crypto_funding_rate BTCUSDT-SWAP — last 1 funding event(s):')
    expect(fromNative).toContain('crypto_funding_rate BTCUSDT-SWAP — last 1 funding event(s):')
    expect(fromCanonical).toContain('rate=0.00010000 (0.0100%)  markPrice=42000.5')
  })

  it('管理员：现货形 BTCUSDT 视为同一永续（回显规范形），非法符号则结构化拒绝且不发请求', async () => {
    // Given: 一个可用端点与一个过短的非法符号
    const usable = fundingFetch(RECORDS)
    const rejected = fundingFetch(RECORDS)
    // When: 分别调用工具
    const output = (await toolFor(usable.fetchImpl).execute({ symbol: 'BTCUSDT' })) as string
    // Then: 现货形按永续处理并回显规范形；非法符号在发请求前拒绝
    expect(output).toContain('crypto_funding_rate BTCUSDT-SWAP — last 1 funding event(s):')
    await expect(toolFor(rejected.fetchImpl).execute({ symbol: 'bt' })).rejects.toThrow(/invalid symbol/)
    expect(rejected.urls).toEqual([])
  })
})
