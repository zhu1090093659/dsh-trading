/**
 * MarketSidebar 首拍 prevClose 兜底只认「ticker 确实缺省」（用户可见路径：左栏行的涨跌幅锚点）。
 *
 * 渲染侧本来就 ticker.prevClose 优先（MarketSidebar.tsx 行内 pct 的取值顺序），日 K 只是快照缺
 * 官方昨收时的一次性兜底。改前该兜底只看自己上一拍的 series 状态，首拍必为空 → 每行白补一次
 * 1d/limit=2（真实规模 18 行 = 多 18 次请求）。改后：报价拍未落地时先不补；ticker 带官方锚点
 * 就直接不补；只有「ticker 落地且确实没有 prevClose」才补一次。
 *
 * 无模块 mock、无 sleep：只把 HTTP 传输层（globalThis.fetch）换成按桥真实信封应答的契约桩，
 * 组件、api.ts、store 全走真实模块；推进一律靠 microtask 排空，不推任何计时器。
 *
 * @vitest-environment jsdom
 */
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { MarketId } from '../src/client/types.ts'
import type { MarketLocaleKey } from '../src/client/contract.ts'
import type { SelectionState, Watchlists } from '../src/client/store.ts'
import { createWatchlistGroupsStore, createWatchlistStore } from '../src/client/store.ts'
import { changePercent, fmtPercent, fmtPrice } from '../src/client/format.ts'
import { MarketSidebar } from '../src/client/MarketSidebar.tsx'

/** 行情快照价（桩内统一）。 */
const PRICE = 100
/** ticker 缺 prevClose 时，日 K 兜底能给出的昨收（倒数第二根收盘）。 */
const DAILY_PREV_CLOSE = 90

interface Calls {
  /** 命中 prevClose 兜底的 klines 请求所对应的 symbol（按调用顺序）。 */
  readonly prevClose: string[]
  /** 全部 klines 请求数。 */
  readonly klines: number
}

interface BridgeOptions {
  /** 这些标的的 ticker 不带 prevClose（模拟数据源缺官方锚点）。 */
  readonly omitPrevClose?: readonly string[]
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
}

function bar(openTime: number, close: number): Record<string, number> {
  return { openTime, open: close, high: close, low: close, close, volume: 0, closeTime: openTime + 300_000 }
}

/**
 * 契约桩：crypto 的日内序列一律可用（3 根），日 K 兜底给两根 [DAILY_PREV_CLOSE-? , …]。
 * 逐条记账 1d/limit=2 的请求——那是本文件唯一要量的量。
 */
function installBridge(options: BridgeOptions = {}): Calls {
  const calls = { prevClose: [] as string[], klines: 0 }
  const omit = options.omitPrevClose ?? []
  globalThis.fetch = (async (input: unknown): Promise<Response> => {
    const url = new URL(String(input), 'http://localhost')
    if (url.pathname === '/dshtrading/api/markets') return jsonResponse({ markets: [{ id: 'crypto' }] })
    if (url.pathname === '/dshtrading/api/symbols') return jsonResponse({ symbols: [] })
    if (url.pathname === '/dshtrading/api/tickers') {
      const symbols = (url.searchParams.get('symbols') ?? '').split(',').filter(Boolean)
      const tickers: Record<string, unknown> = {}
      for (const symbol of symbols) {
        tickers[symbol] = {
          ok: true,
          ticker: {
            symbol,
            name: 'Name ' + symbol,
            price: PRICE,
            changePercent: 0,
            timestamp: 1,
            ...(omit.includes(symbol) ? {} : { prevClose: PRICE }),
          },
        }
      }
      return jsonResponse({ tickers })
    }
    if (url.pathname !== '/dshtrading/api/klines') return new Response('not found', { status: 404 })
    calls.klines += 1
    const symbol = url.searchParams.get('symbol') ?? ''
    if (url.searchParams.get('interval') === '1d' && url.searchParams.get('limit') === '2') {
      calls.prevClose.push(symbol)
      // 倒数第二根的收盘才是兜底取的昨收（末根可能是当日未收盘的 bar）。
      return jsonResponse({ klines: [bar(1, DAILY_PREV_CLOSE), bar(2, DAILY_PREV_CLOSE + 1)] })
    }
    // 日内序列：crypto 无交易时段过滤，任意非空即可。
    return jsonResponse({ klines: [bar(1, 1), bar(2, 2), bar(3, 3)] })
  }) as unknown as typeof globalThis.fetch
  return calls
}

const t = (key: MarketLocaleKey): string => key

interface Harness {
  view: ReturnType<typeof render>
  /** 加一行自选并重渲染（rowsKey 变化 → 两拍轮询整体重跑）。 */
  addRow: (symbol: string) => Promise<void>
}

async function mountSidebar(symbols: readonly string[]): Promise<Harness> {
  const watchlists = createWatchlistStore()
  for (const symbol of symbols) watchlists.add('crypto' as MarketId, { market: 'crypto' as MarketId, symbol, name: 'Name ' + symbol })
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
  const addRow = async (symbol: string): Promise<void> => {
    watchlists.add('crypto' as MarketId, { market: 'crypto' as MarketId, symbol, name: 'Name ' + symbol })
    view.rerender(element())
    for (let i = 0; i < 4; i += 1) await act(async () => {})
  }
  return { view, addRow }
}

/** 行内价格 + 涨跌幅此刻的文本。 */
function quoteTextOf(harness: Harness, symbol: string): string {
  const row = harness.view.getByText(symbol).closest('button')
  if (row === null) throw new Error('row not found: ' + symbol)
  return row.textContent ?? ''
}

let originalFetch: typeof globalThis.fetch

beforeEach(() => { originalFetch = globalThis.fetch })

afterEach(() => {
  cleanup()
  globalThis.fetch = originalFetch
})

describe('用户左栏自选的昨收锚点来源', () => {
  it('用户自选首个挂载时，ticker 已带官方昨收就不再补拉 1d/limit=2', async () => {
    // Given：crypto 3 行，三个 ticker 都带官方 prevClose
    const calls = installBridge()
    // When：挂载后的首拍（参考序列拍 + 报价拍）
    const harness = await mountSidebar(['A', 'B', 'C'])
    // Then：一次日 K 兜底都不发；涨跌幅直接用 ticker 的锚点算出来
    expect(calls.prevClose).toEqual([])
    expect(quoteTextOf(harness, 'A')).toContain(fmtPrice(PRICE))
    expect(quoteTextOf(harness, 'A')).toContain(fmtPercent(changePercent(PRICE, PRICE)))
  })

  it('用户自选里 ticker 缺官方昨收的行，下一拍才补一次日 K（不重复补、不误补）', async () => {
    // Given：crypto 2 行，A 带 prevClose、B 不带
    const calls = installBridge({ omitPrevClose: ['B'] })
    const harness = await mountSidebar(['A', 'B'])
    // Then：首拍报价拍还没落地，两行都不抢发日 K；B 的涨跌幅暂缺
    expect(calls.prevClose).toEqual([])
    expect(quoteTextOf(harness, 'B')).toContain(fmtPercent(undefined))

    // When：自选加一行 C（rowsKey 变化 → 两拍整体重跑，此时上一拍的报价已在手里）
    await harness.addRow('C')
    // Then：只给确实缺省的 B 补一次；A 有官方锚点、C 的报价拍同样还没落地
    expect(calls.prevClose).toEqual(['B'])
    expect(quoteTextOf(harness, 'B')).toContain(fmtPercent(changePercent(PRICE, DAILY_PREV_CLOSE)))
    expect(quoteTextOf(harness, 'A')).toContain(fmtPercent(changePercent(PRICE, PRICE)))
  })
})
