/**
 * MarketSidebar 批量报价分块（用户可见路径：左栏自选超过桥的单次上限时仍能看到报价）。
 *
 * 桥对一次 /tickers 请求的 symbols 封顶 32（bridge.ts:215 `MAX_SYMBOLS`，:869 超限整批 400）。
 * 分块前，单市场自选超过 32 行即整拍 400，被 MarketSidebar 的 catch 吞掉 → 该市场报价
 * 永久停在上一帧且无任何提示。分块后每块独立成败：一块失败不影响其它块落地，失败仍静默、
 * 下轮再试（对外语义不变）。
 *
 * 无模块 mock、无 sleep：只把 HTTP 传输层（globalThis.fetch）换成按桥真实信封应答的契约桩
 * （symbols > 32 → 400，镜像 bridge.ts:215/869；块内任一符号在失败名单 → 500），组件、
 * api.ts、store 全都走真实模块；推进一律靠 microtask 排空，不用任何计时器。
 *
 * @vitest-environment jsdom
 */
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Instrument, MarketId } from '../src/client/types.ts'
import type { MarketLocaleKey } from '../src/client/contract.ts'
import type { SelectionState, Watchlists } from '../src/client/store.ts'
import { createWatchlistGroupsStore, createWatchlistStore } from '../src/client/store.ts'
import { fmtPrice } from '../src/client/format.ts'
import { MarketSidebar } from '../src/client/MarketSidebar.tsx'

/** 桥单次批量报价 symbols 封顶（镜像 bot-api/src/bridge.ts:215 MAX_SYMBOLS）。 */
const BRIDGE_MAX_SYMBOLS = 32
/** 桩给出的统一报价。 */
const PRICE = 12.5

interface TickerRequest {
  readonly market: string
  readonly symbols: readonly string[]
  readonly status: number
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
}

/**
 * 契约桩：替换 HTTP 传输层，逐条记账 /tickers 请求。
 * failSymbols 命中的块返回 500（非 2xx），模拟「这一块被上游拒绝」。
 */
function installBridge(options: { failSymbols?: readonly string[] } = {}): TickerRequest[] {
  const requests: TickerRequest[] = []
  globalThis.fetch = (async (input: unknown): Promise<Response> => {
    const url = new URL(String(input), 'http://localhost')
    if (url.pathname === '/dshtrading/api/markets') return jsonResponse({ markets: [{ id: 'cn' }] })
    if (url.pathname === '/dshtrading/api/symbols') return jsonResponse({ symbols: [] })
    // 参考序列一律空：本文件只量批量报价的分块，序列编排由 smoke 用例覆盖。
    if (url.pathname === '/dshtrading/api/klines') return jsonResponse({ klines: [] })
    if (url.pathname !== '/dshtrading/api/tickers') return new Response('not found', { status: 404 })
    const market = url.searchParams.get('market') ?? ''
    const symbols = (url.searchParams.get('symbols') ?? '').split(',').filter(Boolean)
    // 镜像 bridge.ts:215/869：超限时整批拒绝，不是截断。
    const rejected = symbols.length > BRIDGE_MAX_SYMBOLS
    const failed = !rejected && options.failSymbols !== undefined
      && symbols.some(symbol => options.failSymbols?.includes(symbol) === true)
    const status = rejected ? 400 : failed ? 500 : 200
    requests.push({ market, symbols, status })
    if (rejected) return new Response('{"code":"TRADING_PROTOCOL","message":"tickers: too many symbols"}', { status: 400 })
    if (failed) return new Response('boom', { status: 500 })
    const tickers: Record<string, unknown> = {}
    for (const symbol of symbols) {
      tickers[symbol] = { ok: true, ticker: { symbol, name: 'Name ' + symbol, price: PRICE, prevClose: PRICE, changePercent: 0, timestamp: 1 } }
    }
    return jsonResponse({ tickers })
  }) as unknown as typeof globalThis.fetch
  return requests
}

const t = (key: MarketLocaleKey): string => key

function symbolsOf(count: number): string[] {
  return Array.from({ length: count }, (_, i) => 'S' + String(i).padStart(2, '0'))
}

/** 挂载左栏（cn market 的 count 行自选），排空首拍的全部取数。 */
async function mountSidebar(count: number): Promise<ReturnType<typeof render>> {
  const watchlists = createWatchlistStore()
  for (const symbol of symbolsOf(count)) watchlists.add('cn' as MarketId, { market: 'cn' as MarketId, symbol, name: 'Stock ' + symbol })
  const groups = createWatchlistGroupsStore()
  const selection: SelectionState = { instrument: null }
  const element = (): React.JSX.Element => (
    <MarketSidebar
      t={t}
      useSelection={<T,>(sel: (value: SelectionState) => T): T => sel(selection)}
      useWatchlists={<T,>(sel: (value: Watchlists) => T): T => sel(watchlists.getSnapshot())}
      useGroups={<T,>(sel: (value: ReturnType<typeof groups.getSnapshot>) => T): T => sel(groups.getSnapshot())}
      addInstrument={() => {}}
      removeInstrument={() => {}}
      selectInstrument={() => {}}
      openSettings={() => {}}
      createGroup={async () => ({ ok: false as const, reason: 'unavailable' as const })}
      renameGroup={async () => ({ ok: false as const, reason: 'unavailable' as const })}
      deleteGroup={async () => false}
      assignGroupMember={async () => true}
      setActiveGroup={() => {}}
    />
  )
  const view = render(element())
  // 桩全部是立即 resolve 的 async 函数：microtask 排空即够，不用计时器。
  for (let i = 0; i < 4; i += 1) await act(async () => {})
  return view
}

/** 行内价格单元格此刻的文本（无报价时 fmtPrice(undefined) 的占位）。 */
function priceTextOf(view: ReturnType<typeof render>, symbol: string): string {
  const row = view.getByText(symbol).closest('button')
  if (row === null) throw new Error('row not found: ' + symbol)
  return row.textContent ?? ''
}

let originalFetch: typeof globalThis.fetch

beforeEach(() => { originalFetch = globalThis.fetch })

afterEach(() => {
  cleanup()
  globalThis.fetch = originalFetch
})

describe('用户左栏自选批量报价的分块', () => {
  it('用户单市场自选 40 行时，拆成 2 次批量报价且两次都成功', async () => {
    // Given：cn 一个市场 40 行（越过桥的 32 封顶）
    const requests = installBridge()
    // When：挂载后的首拍批量报价
    const view = await mountSidebar(40)
    // Then：2 次请求、各 32/8 个标的、都 200，40 个标的全部被覆盖并落屏
    expect(requests).toHaveLength(2)
    expect(requests.map(request => request.symbols.length)).toEqual([BRIDGE_MAX_SYMBOLS, 8])
    expect(requests.every(request => request.status === 200)).toBe(true)
    expect(requests.flatMap(request => request.symbols).sort()).toEqual(symbolsOf(40))
    expect(priceTextOf(view, 'S00')).toContain(fmtPrice(PRICE))
    expect(priceTextOf(view, 'S39')).toContain(fmtPrice(PRICE))
  })

  it('用户单市场自选 33 行时（阈值上一行），拆成 2 次批量报价', async () => {
    // Given：cn 33 行 = 32 + 1
    const requests = installBridge()
    // When：首拍批量报价
    await mountSidebar(33)
    // Then：2 次请求，第二块只剩 1 个标的
    expect(requests).toHaveLength(2)
    expect(requests.map(request => request.symbols.length)).toEqual([BRIDGE_MAX_SYMBOLS, 1])
    expect(requests.every(request => request.status === 200)).toBe(true)
  })

  it('用户单市场自选 32 行时（阈值上界），仍是 1 次批量报价', async () => {
    // Given：cn 恰好 32 行
    const requests = installBridge()
    // When：首拍批量报价
    await mountSidebar(32)
    // Then：1 次请求装下全部
    expect(requests).toHaveLength(1)
    expect(requests[0]?.symbols).toHaveLength(BRIDGE_MAX_SYMBOLS)
    expect(requests[0]?.status).toBe(200)
  })

  it('用户单市场自选 1 行时，仍是 1 次批量报价', async () => {
    // Given：cn 只有 1 行
    const requests = installBridge()
    // When：首拍批量报价
    await mountSidebar(1)
    // Then：1 次请求装下这 1 个标的
    expect(requests).toHaveLength(1)
    expect(requests[0]?.symbols).toEqual(['S00'])
    expect(requests[0]?.status).toBe(200)
  })

  it('用户单市场自选 40 行且其中一块被上游拒绝时，另一块的报价照常落屏', async () => {
    // Given：40 行，含 S32 的那一块（第二块）返回 500
    const requests = installBridge({ failSymbols: ['S32'] })
    // When：首拍批量报价
    const view = await mountSidebar(40)
    // Then：两块各自成败——第一块的 32 行有价，第二块静默失败（保留占位，下轮再试）
    expect(requests).toHaveLength(2)
    expect(requests.map(request => request.status)).toEqual([200, 500])
    expect(priceTextOf(view, 'S00')).toContain(fmtPrice(PRICE))
    expect(priceTextOf(view, 'S31')).toContain(fmtPrice(PRICE))
    expect(priceTextOf(view, 'S32')).not.toContain(fmtPrice(PRICE))
    expect(priceTextOf(view, 'S32')).toContain(fmtPrice(undefined))
  })
})
