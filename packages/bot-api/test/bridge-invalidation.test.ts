/**
 * 写路由失效声明守卫（2026-10-15，简化提案第 2 项）。
 *
 * 每个写端点一条用例：写成功 → 该路由声明的 store 失效**一次**；业务拒绝
 * （HTTP 200 + ok:false）与协议拒绝（4xx）都不发；写完再读对应 GET 读面不追加信号。
 * 另有一条结构用例：漏声明 invalidates 的写路由被守卫拒绝，且生产写路由表与这里的
 * 期望表逐条一致——新增写端点忘了声明失效 store 会红。
 *
 * 全程走 apply() 接线（真实 CordisContext + 内存宿主 store），不触网、不用假件。
 */
import { describe, expect, it } from 'vitest'
import { Context as CordisContext } from '@deepseek-ai/cordis'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { BRIDGE_WRITE_ROUTES, resolveWriteRoute, type BridgeWriteRoute } from '../src/bridge.ts'
import { apply } from '../src/index.ts'
import { createMemoryChartActivationStore, createMemoryCustomIndicatorStore } from '@dshtrading/indicators'
import { createMemoryKnowledgeCardStore } from '@dshtrading/knowledge'
import { createMemoryBuiltinTombstonesStore, createMemoryCustomScreenerStore, createMemoryCustomStrategyStore } from '@dshtrading/strategies'
import { createMemoryHoldingsStore } from '@dshtrading/holdings'
import { createMemorySelectionStore, createMemoryWatchlistGroupsStore, createMemoryWatchlistStore } from '@dshtrading/watchlist'

interface Route {
  kind: string
  path: string
  handler: (req: Partial<IncomingMessage>, res: Partial<ServerResponse>) => Promise<void>
}

type Call = (method: string, sub: string, body?: unknown) => Promise<{ status: number; body: Record<string, unknown> }>

/** 写端点守卫用例：run 跑完该端点的全部写步骤（含拒绝样本），返回**成功写**的步数。 */
interface WriteCase {
  readonly name: string
  readonly method: string
  readonly pathname: string
  /** 该路由声明的失效 store；null = 合法写但不失效任何 store（交易台）。 */
  readonly store: string | null
  /** 对应读面（GET）：写完再读不追加失效信号；无读面则省略。 */
  readonly readSub?: string
  run(call: Call): Promise<number>
}

/** 客户端会重拉的 store 名（与 bridge 的 BridgeInvalidateStore 同一值域）。 */
const WRITE_STORES: readonly string[] = ['indicators', 'chart', 'strategies', 'watchlists', 'selection', 'holdings']

const watched = (emitted: readonly string[]): string[] => emitted.filter(store => WRITE_STORES.includes(store))

const okWrite = (res: { status: number; body: Record<string, unknown> }, extra: Record<string, unknown> = {}): void => {
  expect(res.status).toBe(200)
  expect(res.body).toMatchObject({ ok: true, ...extra })
}

const refusedWrite = (res: { status: number; body: Record<string, unknown> }, code: string): void => {
  expect(res.status).toBe(200)
  expect(res.body).toMatchObject({ ok: false, code })
}

/** 无 code 字段的业务拒绝（迁移幂等守卫、分组归属拒绝等只回 reason）。 */
const refusedBusiness = (res: { status: number; body: Record<string, unknown> }): void => {
  expect(res.status).toBe(200)
  expect(res.body).toMatchObject({ ok: false })
}

const refusedProtocol = (res: { status: number; body: Record<string, unknown> }, pattern: RegExp): void => {
  expect(res.status).toBe(400)
  expect(String(res.body.message)).toMatch(pattern)
}

const HOLDING_ITEM = { market: 'hk', symbol: '00700', side: 'long', size: 100, entryPrice: 380, account: '富途', kind: 'real' }

const VALID_STRATEGY = {
  id: 'demo-invalidation',
  title: '演示',
  horizon: 'swing',
  summary: 'x',
  paramsJson: '[]',
  computeSource: `(bars) => {
    const out = []
    let long = false
    for (let i = 1; i < bars.length; i++) {
      if (!long && i % 2 === 1) { out.push({ index: i, time: bars[i].openTime, action: 'entry', direction: 'long', price: bars[i].close, reason: 'demo entry' }); long = true }
      else if (long && i % 2 === 0) { out.push({ index: i, time: bars[i].openTime, action: 'exit', direction: 'flat', price: bars[i].close, reason: 'demo exit' }); long = false }
    }
    return out
  }`,
}

const VALID_SCREENER = {
  id: 'scr.custom-invalidation',
  title: '动量',
  summary: 'x',
  paramsJson: '[]',
  columnsJson: JSON.stringify([{ key: 'mom', label: '动量' }]),
  evaluateSource: `(bars) => {
    if (bars.length < 2) return null
    const mom = (bars[bars.length - 1].close - bars[0].close) / bars[0].close * 100
    if (mom <= 0) return null
    return { metrics: { mom }, reason: '动量为正' }
  }`,
}

const CASES: readonly WriteCase[] = [
  {
    name: 'DELETE /indicators/custom 删除自定义指标',
    method: 'DELETE',
    pathname: '/indicators/custom',
    store: 'indicators',
    readSub: '/indicators/custom',
    run: async (call) => {
      refusedProtocol(await call('DELETE', '/indicators/custom'), /id is required/)
      okWrite(await call('DELETE', '/indicators/custom?id=ind-x'), { removed: false })
      return 1
    },
  },
  {
    name: 'DELETE /chart/indicators 摘除图表激活',
    method: 'DELETE',
    pathname: '/chart/indicators',
    store: 'chart',
    readSub: '/chart/indicators',
    run: async (call) => {
      refusedProtocol(await call('DELETE', '/chart/indicators'), /id is required/)
      okWrite(await call('DELETE', '/chart/indicators?id=rsi'), { removed: false })
      return 1
    },
  },
  {
    name: 'DELETE /strategies/custom 删除自定义策略',
    method: 'DELETE',
    pathname: '/strategies/custom',
    store: 'strategies',
    readSub: '/strategies/custom',
    run: async (call) => {
      refusedProtocol(await call('DELETE', '/strategies/custom'), /id is required/)
      okWrite(await call('DELETE', '/strategies/custom?id=demo-x'), { removed: false, scope: 'custom' })
      return 1
    },
  },
  {
    name: 'DELETE /strategies/screeners 删除选股器',
    method: 'DELETE',
    pathname: '/strategies/screeners',
    store: 'strategies',
    readSub: '/strategies/screeners',
    run: async (call) => {
      refusedProtocol(await call('DELETE', '/strategies/screeners'), /id is required/)
      okWrite(await call('DELETE', '/strategies/screeners?id=scr.x'), { removed: false, scope: 'custom' })
      return 1
    },
  },
  {
    name: 'DELETE /trade/order 撤单',
    method: 'DELETE',
    pathname: '/trade/order',
    store: null,
    run: async (call) => {
      refusedProtocol(await call('DELETE', '/trade/order?id=o1'), /market is required/)
      refusedProtocol(await call('DELETE', '/trade/order?market=cn&id=o1'), /no trade service/)
      return 0
    },
  },
  {
    name: 'DELETE /watchlists 移除自选行',
    method: 'DELETE',
    pathname: '/watchlists',
    store: 'watchlists',
    readSub: '/watchlists',
    run: async (call) => {
      refusedProtocol(await call('DELETE', '/watchlists'), /market and symbol are required/)
      okWrite(await call('DELETE', '/watchlists?market=us&symbol=AAPL'))
      return 1
    },
  },
  {
    name: 'DELETE /watchlist-groups 删除分组',
    method: 'DELETE',
    pathname: '/watchlist-groups',
    store: 'watchlists',
    readSub: '/watchlist-groups',
    run: async (call) => {
      refusedProtocol(await call('DELETE', '/watchlist-groups'), /id is required/)
      okWrite(await call('DELETE', '/watchlist-groups?id=g-x'), { removed: false })
      return 1
    },
  },
  {
    name: 'DELETE /watchlist-group-members 移出分组成员',
    method: 'DELETE',
    pathname: '/watchlist-group-members',
    store: 'watchlists',
    readSub: '/watchlist-groups',
    run: async (call) => {
      refusedProtocol(await call('DELETE', '/watchlist-group-members?id=g-x'), /id, market and symbol are required/)
      okWrite(await call('DELETE', '/watchlist-group-members?id=g-x&market=us&symbol=AAPL'), { removed: false })
      return 1
    },
  },
  {
    name: 'DELETE /holdings 删除台账条目',
    method: 'DELETE',
    pathname: '/holdings',
    store: 'holdings',
    readSub: '/holdings',
    run: async (call) => {
      refusedWrite(await call('DELETE', '/holdings?id='), 'TRADING_HOLDINGS_INVALID')
      okWrite(await call('DELETE', '/holdings?id=hd-x'))
      return 1
    },
  },
  {
    name: 'PUT /watchlists 全量替换自选',
    method: 'PUT',
    pathname: '/watchlists',
    store: 'watchlists',
    readSub: '/watchlists',
    run: async (call) => {
      refusedProtocol(await call('PUT', '/watchlists', []), /object keyed by market/)
      okWrite(await call('PUT', '/watchlists', { us: [{ market: 'us', symbol: 'AAPL' }] }))
      return 1
    },
  },
  {
    name: 'PUT /watchlist-groups 重命名分组',
    method: 'PUT',
    pathname: '/watchlist-groups',
    store: 'watchlists',
    readSub: '/watchlist-groups',
    run: async (call) => {
      refusedProtocol(await call('PUT', '/watchlist-groups'), /requires string id/)
      refusedWrite(await call('PUT', '/watchlist-groups', { id: 'g-missing', name: 'x' }), 'not-found')
      const created = await call('POST', '/watchlist-groups', { name: '核心仓' })
      okWrite(created, { created: true })
      const id = (created.body.group as { id: string }).id
      okWrite(await call('PUT', '/watchlist-groups', { id, name: '观察仓' }), { renamed: true })
      return 2
    },
  },
  {
    name: 'PUT /selection 设置选中标的',
    method: 'PUT',
    pathname: '/selection',
    store: 'selection',
    readSub: '/selection',
    run: async (call) => {
      okWrite(await call('PUT', '/selection', { instrument: { market: 'us', symbol: 'AAPL' } }))
      return 1
    },
  },
  {
    name: 'PUT /chart/indicators 挂载图表激活',
    method: 'PUT',
    pathname: '/chart/indicators',
    store: 'chart',
    readSub: '/chart/indicators',
    run: async (call) => {
      refusedProtocol(await call('PUT', '/chart/indicators'), /requires string id/)
      refusedWrite(await call('PUT', '/chart/indicators', { id: 'no-such-indicator' }), 'TRADING_UNKNOWN_INDICATOR')
      okWrite(await call('PUT', '/chart/indicators', { id: 'rsi' }))
      return 1
    },
  },
  {
    name: 'PUT /holdings 编辑台账条目',
    method: 'PUT',
    pathname: '/holdings',
    store: 'holdings',
    readSub: '/holdings',
    run: async (call) => {
      refusedWrite(await call('PUT', '/holdings', {}), 'TRADING_HOLDINGS_INVALID')
      okWrite(await call('PUT', '/holdings', { id: 'hd-x', patch: { size: 5 } }))
      return 1
    },
  },
  {
    name: 'PUT /strategies/custom 保存自定义策略',
    method: 'PUT',
    pathname: '/strategies/custom',
    store: 'strategies',
    readSub: '/strategies/custom',
    run: async (call) => {
      refusedWrite(await call('PUT', '/strategies/custom', {}), 'TRADING_STRATEGY_INVALID')
      okWrite(await call('PUT', '/strategies/custom', VALID_STRATEGY), { overridesBuiltin: false })
      return 1
    },
  },
  {
    name: 'PUT /strategies/screeners 保存选股器',
    method: 'PUT',
    pathname: '/strategies/screeners',
    store: 'strategies',
    readSub: '/strategies/screeners',
    run: async (call) => {
      refusedWrite(await call('PUT', '/strategies/screeners', {}), 'TRADING_SCREENER_INVALID')
      okWrite(await call('PUT', '/strategies/screeners', VALID_SCREENER), { overridesScreener: false })
      return 1
    },
  },
  {
    name: 'POST /trade/order 报单',
    method: 'POST',
    pathname: '/trade/order',
    store: null,
    run: async (call) => {
      refusedProtocol(
        await call('POST', '/trade/order?market=cn', { symbol: '600519.SH', side: 'buy', type: 'market', quantity: 1 }),
        /no trade service/,
      )
      return 0
    },
  },
  {
    name: 'POST /strategies/reset 恢复内置策略',
    method: 'POST',
    pathname: '/strategies/reset',
    store: 'strategies',
    readSub: '/strategies/custom',
    run: async (call) => {
      refusedProtocol(await call('POST', '/strategies/reset', {}), /id is required/)
      refusedWrite(await call('POST', '/strategies/reset', { id: 'demo-custom' }), 'TRADING_STRATEGY_NOT_BUILTIN')
      okWrite(await call('POST', '/strategies/reset', { id: 'ema-crossover' }), { reset: true })
      return 1
    },
  },
  {
    name: 'POST /strategies/screeners/reset 恢复内置选股器',
    method: 'POST',
    pathname: '/strategies/screeners/reset',
    store: 'strategies',
    readSub: '/strategies/screeners',
    run: async (call) => {
      refusedProtocol(await call('POST', '/strategies/screeners/reset', {}), /id is required/)
      refusedWrite(await call('POST', '/strategies/screeners/reset', { id: 'scr.custom' }), 'TRADING_SCREENER_NOT_BUILTIN')
      okWrite(await call('POST', '/strategies/screeners/reset', { id: 'scr.above-ma' }), { reset: true })
      return 1
    },
  },
  {
    name: 'POST /watchlists 追自选行',
    method: 'POST',
    pathname: '/watchlists',
    store: 'watchlists',
    readSub: '/watchlists',
    run: async (call) => {
      refusedProtocol(await call('POST', '/watchlists', {}), /requires string market and symbol/)
      okWrite(await call('POST', '/watchlists', { market: 'us', symbol: 'AAPL' }))
      return 1
    },
  },
  {
    name: 'POST /watchlists/import 迁移导入自选',
    method: 'POST',
    pathname: '/watchlists/import',
    store: 'watchlists',
    readSub: '/watchlists',
    run: async (call) => {
      okWrite(await call('POST', '/watchlists/import', { us: [{ market: 'us', symbol: 'AAPL' }] }), { imported: true })
      refusedBusiness(await call('POST', '/watchlists/import', { us: [{ market: 'us', symbol: 'MSFT' }] }))
      return 1
    },
  },
  {
    name: 'POST /watchlist-groups 建分组',
    method: 'POST',
    pathname: '/watchlist-groups',
    store: 'watchlists',
    readSub: '/watchlist-groups',
    run: async (call) => {
      refusedProtocol(await call('POST', '/watchlist-groups', {}), /non-empty string name/)
      okWrite(await call('POST', '/watchlist-groups', { name: '核心仓' }), { created: true })
      refusedWrite(await call('POST', '/watchlist-groups', { name: '核心仓' }), 'duplicate')
      return 1
    },
  },
  {
    name: 'POST /watchlist-group-members 加入分组',
    method: 'POST',
    pathname: '/watchlist-group-members',
    store: 'watchlists',
    readSub: '/watchlist-groups',
    run: async (call) => {
      refusedProtocol(await call('POST', '/watchlist-group-members', {}), /requires string id, market and symbol/)
      refusedBusiness(
        await call('POST', '/watchlist-group-members', { id: 'g-missing', market: 'us', symbol: 'AAPL' }),
      )
      const created = await call('POST', '/watchlist-groups', { name: '核心仓' })
      okWrite(created, { created: true })
      const id = (created.body.group as { id: string }).id
      okWrite(await call('POST', '/watchlist-group-members', { id, market: 'us', symbol: 'AAPL' }))
      return 2
    },
  },
  {
    name: 'POST /chart/indicators/import 迁移导入激活名册',
    method: 'POST',
    pathname: '/chart/indicators/import',
    store: 'chart',
    readSub: '/chart/indicators',
    run: async (call) => {
      okWrite(await call('POST', '/chart/indicators/import', { instances: [{ id: 'rsi', params: { n: 14 } }] }), { imported: true })
      refusedBusiness(await call('POST', '/chart/indicators/import', { instances: [] }))
      return 1
    },
  },
  {
    name: 'POST /holdings 新增台账条目',
    method: 'POST',
    pathname: '/holdings',
    store: 'holdings',
    readSub: '/holdings',
    run: async (call) => {
      refusedWrite(await call('POST', '/holdings', { ...HOLDING_ITEM, size: -1 }), 'TRADING_HOLDINGS_INVALID')
      okWrite(await call('POST', '/holdings', HOLDING_ITEM))
      return 1
    },
  },
  {
    name: 'POST /holdings/stage 暂存台账条目',
    method: 'POST',
    pathname: '/holdings/stage',
    store: 'holdings',
    readSub: '/holdings',
    run: async (call) => {
      refusedWrite(await call('POST', '/holdings/stage', { items: [] }), 'TRADING_HOLDINGS_INVALID')
      okWrite(await call('POST', '/holdings/stage', { items: [HOLDING_ITEM] }))
      return 1
    },
  },
  {
    name: 'POST /holdings/confirm 确认暂存条目',
    method: 'POST',
    pathname: '/holdings/confirm',
    store: 'holdings',
    readSub: '/holdings',
    run: async (call) => {
      refusedWrite(await call('POST', '/holdings/confirm', {}), 'TRADING_HOLDINGS_INVALID')
      okWrite(await call('POST', '/holdings/confirm', { ids: ['hd-missing'] }))
      return 1
    },
  },
  {
    name: 'POST /holdings/discard 丢弃暂存条目',
    method: 'POST',
    pathname: '/holdings/discard',
    store: 'holdings',
    readSub: '/holdings',
    run: async (call) => {
      refusedWrite(await call('POST', '/holdings/discard', {}), 'TRADING_HOLDINGS_INVALID')
      okWrite(await call('POST', '/holdings/discard', { ids: ['hd-missing'] }))
      return 1
    },
  },
]

async function makeWiredCtx(emitted: string[]): Promise<{ registered: Route[] }> {
  const registered: Route[] = []
  const ctx = new CordisContext()
  // store 全部走能力包导出的内存实现（Service 形状 provide，与真实 plugin 同款解包路径）：
  // 不落文件、不触网，写面在测试里确定性地成功/拒绝。
  ctx.provide('tradingCustomIndicators', { store: createMemoryCustomIndicatorStore() })
  ctx.provide('tradingChartActivations', { store: createMemoryChartActivationStore() })
  ctx.provide('tradingKnowledgeCards', { store: createMemoryKnowledgeCardStore() })
  ctx.provide('tradingStrategies', {
    store: createMemoryCustomStrategyStore(),
    tombstones: createMemoryBuiltinTombstonesStore(),
    screenerStore: createMemoryCustomScreenerStore(),
  })
  ctx.provide('tradingWatchlist', {
    store: createMemoryWatchlistStore(),
    selection: createMemorySelectionStore(),
    groups: createMemoryWatchlistGroupsStore(),
  })
  ctx.provide('tradingHoldings', { store: createMemoryHoldingsStore() })
  ctx.provide('tradingEvents', { emit: (store: string) => { emitted.push(store) } })
  ctx.provide('webServer', { register: (route: Route) => { registered.push(route) } })
  ctx.provide('connection', { requestRejection: () => undefined })
  apply(ctx as never)
  await new Promise(resolve => setImmediate(resolve))
  return { registered }
}

async function http(registered: Route[], method: string, sub: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  let status = 0
  let text = ''
  const res = {
    writeHead: (s: number) => { status = s },
    end: (b?: string) => { text = b ?? '' },
  } as unknown as ServerResponse
  const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), {
    method,
    url: `/dshtrading/api${sub}`,
  }) as unknown as IncomingMessage
  await registered[0]!.handler(req, res)
  return { status, body: JSON.parse(text) as Record<string, unknown> }
}

describe('写路由失效声明（提案第 2 项）', () => {
  for (const c of CASES) {
    it(`用户 ${c.name}：写成功只让声明的 store 失效一次，拒绝与 GET 都不发信号`, async () => {
      // Given 一个接了 tradingEvents 的宿主桥（内存 store、离线）
      const emitted: string[] = []
      const { registered } = await makeWiredCtx(emitted)

      // When 走真实 HTTP 写面跑完该端点的全部写步骤（含拒绝样本）
      const writes = await c.run((method, sub, body) => http(registered, method, sub, body))

      // Then 只有该路由声明的 store 被失效，次数 = 成功写的步数
      const expected = c.store === null ? [] : Array.from({ length: writes }, () => c.store as string)
      expect(watched(emitted)).toEqual(expected)

      // And 再读一次对应读面，不追加任何失效信号
      if (c.readSub !== undefined) {
        const read = await http(registered, 'GET', c.readSub)
        expect(read.status).toBe(200)
        expect(watched(emitted)).toEqual(expected)
      }
    })
  }

  it('管理员：漏声明失效 store 的写路由被守卫拒绝，且写路由表与这里的期望表逐条一致', () => {
    // Given 一条绕过类型声明的写路由（没有 invalidates）
    const undeclared = {
      method: 'POST',
      pathname: '/undeclared',
      handle: async () => ({ status: 200, payload: { ok: true } }),
    } as unknown as BridgeWriteRoute

    // When 守卫解析它
    // Then 拒绝——否则该写会「成功但客户端静默不刷新」
    expect(() => resolveWriteRoute([undeclared], 'POST', '/undeclared')).toThrow(/invalidates/)

    // And 生产表的每条写路由都登记了失效声明，且与期望表逐条一致、无重复
    //（新增写端点必须在这里登记一条用例，否则本用例红）
    for (const route of BRIDGE_WRITE_ROUTES) expect(Array.isArray(route.invalidates)).toBe(true)
    const actual = BRIDGE_WRITE_ROUTES.map(route => `${route.method} ${route.pathname}`).sort()
    expect(actual).toEqual(CASES.map(c => `${c.method} ${c.pathname}`).sort())
    expect(new Set(actual).size).toBe(actual.length)
  })
})
