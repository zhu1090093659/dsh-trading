/**
 * @dsh-trading/watchlist/plugin —— 自选股 Agent 工具 host 半插件（issue #32 / P3）。
 *
 * patch 行：id `dsh-trading-watchlist` / name `@dsh-trading/watchlist/plugin`
 * （base 拥有该共享行）。host 平面注册 4 工具（全会话可见，owner 裁决 D4）：
 * - `watchlist_list`：全市场自选行（只读）；
 * - `watchlist_add`：追加一行（同市场按 symbol 去重）→ emit 'watchlists'；
 * - `watchlist_remove`：移除一行 → emit 'watchlists'；
 * - `watchlist_select`：设置选中标的 → emit 'selection'（客户端 SSE 收到后中栏切图）。
 *
 * 词汇纪律：market/symbol 用市场规范形，本插件不归一化（原样落盘）。
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import os from 'node:os'
import path from 'node:path'
import { createMemorySelectionStore, createMemoryWatchlistStore } from './index.ts'
import type { SelectionStore, WatchlistInstrument, WatchlistStore, WatchlistsMap } from './index.ts'
import { createFileSelectionStore, createFileWatchlistStore } from './file-store.ts'

// 桥（client-ui-trading node 半）经本子路径取 file store（knowledge/tool 同款再导出先例）。
export { createFileSelectionStore, createFileWatchlistStore }

/** Cordis 插件名 = patch 行 id（TEMPLATES §8），市场无关共享行命名空间。 */
export const name = 'dsh-trading-watchlist'

/** 本插件不硬依赖任何服务；tools 经 ctx.inject 声明。 */
export const inject: string[] = []

/** 默认存储路径。 */
export function defaultWatchlistStorePath(): string {
  return path.join(os.homedir(), '.dsh', 'watchlists.json')
}

export function defaultSelectionStorePath(): string {
  return path.join(os.homedir(), '.dsh', 'selection.json')
}

/** tradingEvents 的最小发布面（鸭式；总线缺席时静默降级）。 */
export interface TradingEventsPublisher {
  emit(store: 'watchlists' | 'selection'): void
}

function eventsOf(ctx: Context): TradingEventsPublisher | undefined {
  return (ctx as unknown as { get?: (key: string, strict?: boolean) => unknown }).get?.('tradingEvents', false) as TradingEventsPublisher | undefined
}

function parseInstrumentArgs(raw: Record<string, unknown>): { market: string; symbol: string; name?: string } {
  const market = typeof raw.market === 'string' ? raw.market.trim() : ''
  const symbol = typeof raw.symbol === 'string' ? raw.symbol.trim() : ''
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : undefined
  if (!market || !symbol) {
    throw new Error('market and symbol are required (market: crypto|us|cn|hk…, symbol: 市场规范形，如 BTCUSDT / AAPL / 600519 / 00700)')
  }
  return { market, symbol, name }
}

export interface WatchlistToolDeps {
  watchlists: WatchlistStore
  selection: SelectionStore
  onWatchlistsChanged?: () => void
  onSelectionChanged?: () => void
}

export function createWatchlistListTool(deps: WatchlistToolDeps) {
  return defineTool({
    name: 'watchlist_list',
    description:
      'List the user watchlist rows across all markets (crypto/us/cn/hk), as persisted on the host. '
      + 'Rows are the user-customized entries only; a market without rows falls back to client-side seed display. '
      + 'Read-only.',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute() {
      const map: WatchlistsMap = await deps.watchlists.list()
      const markets = Object.keys(map).filter(market => (map[market] ?? []).length > 0)
      const total = markets.reduce((sum, market) => sum + (map[market]?.length ?? 0), 0)
      return JSON.stringify({ ok: true, total, markets, watchlists: map })
    },
  })
}

export function createWatchlistAddTool(deps: WatchlistToolDeps) {
  return defineTool({
    name: 'watchlist_add',
    description:
      'Add an instrument to the user watchlist (cross-market, no tool-name market prefix). '
      + 'Deduplicated per market by symbol. The open GUI sidebar refreshes live over the SSE invalidation channel.',
    parameters: {
      market: {
        type: 'string',
        required: true,
        description: 'Market vocabulary slug: crypto | us | cn | hk',
      },
      symbol: {
        type: 'string',
        required: true,
        description: 'Market-canonical symbol (docs/symbol-vocabulary.md), e.g. BTCUSDT / AAPL / 600519 / 00700',
      },
      name: {
        type: 'string',
        description: 'Optional display name, e.g. 贵州茅台',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(raw) {
      const instrument = parseInstrumentArgs((raw ?? {}) as Record<string, unknown>)
      const added = await deps.watchlists.add(instrument.market, instrument)
      if (added) deps.onWatchlistsChanged?.()
      return JSON.stringify({
        ok: true,
        added,
        note: added
          ? `Added ${instrument.symbol} (${instrument.market}) to the watchlist.`
          : `${instrument.symbol} is already in the ${instrument.market} watchlist (deduplicated, nothing changed).`,
      })
    },
  })
}

export function createWatchlistRemoveTool(deps: WatchlistToolDeps) {
  return defineTool({
    name: 'watchlist_remove',
    description:
      'Remove an instrument from the user watchlist (cross-market). '
      + 'The open GUI sidebar refreshes live over the SSE invalidation channel.',
    parameters: {
      market: {
        type: 'string',
        required: true,
        description: 'Market vocabulary slug: crypto | us | cn | hk',
      },
      symbol: {
        type: 'string',
        required: true,
        description: 'Market-canonical symbol to remove',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(raw) {
      const { market, symbol } = parseInstrumentArgs((raw ?? {}) as Record<string, unknown>)
      const removed = await deps.watchlists.remove(market, symbol)
      if (removed) deps.onWatchlistsChanged?.()
      return JSON.stringify({
        ok: true,
        removed,
        note: removed
          ? `Removed ${symbol} from the ${market} watchlist.`
          : `${symbol} was not in the ${market} watchlist (nothing changed).`,
      })
    },
  })
}

export function createWatchlistSelectTool(deps: WatchlistToolDeps) {
  return defineTool({
    name: 'watchlist_select',
    description:
      'Select an instrument as the focused chart in the trading GUI (cross-market). '
      + 'The open GUI switches the middle-stage chart to this instrument live over the SSE channel. '
      + 'Prefer an instrument that exists in watchlist_list (its display name is reused); unknown symbols are accepted with the raw symbol as display fallback.',
    parameters: {
      market: {
        type: 'string',
        required: true,
        description: 'Market vocabulary slug: crypto | us | cn | hk',
      },
      symbol: {
        type: 'string',
        required: true,
        description: 'Market-canonical symbol to focus',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(raw) {
      const { market, symbol } = parseInstrumentArgs((raw ?? {}) as Record<string, unknown>)
      // 名称解析：自选行里已有的行带展示名；否则以 symbol 兜底。
      const map = await deps.watchlists.list()
      const row = (map[market] ?? []).find(row => row.symbol === symbol)
      const instrument: WatchlistInstrument = row ?? { market, symbol }
      await deps.selection.set({ instrument })
      deps.onSelectionChanged?.()
      return JSON.stringify({
        ok: true,
        selected: instrument,
        note: `Focused the chart on ${symbol} (${market}) — the open GUI switches live.`,
      })
    },
  })
}

export interface WatchlistPluginDeps {
  watchlists: WatchlistStore
  selection: SelectionStore
}

export function registerWatchlistTools(ctx: Context, deps: WatchlistPluginDeps): void {
  ctx.inject(['tools'] as never, (toolCtx) => {
    const tools = (toolCtx as unknown as { tools?: { register(t: unknown): void; get(name: string): unknown } }).tools
    if (!tools || typeof tools.register !== 'function') return

    const hookDeps: WatchlistToolDeps = {
      ...deps,
      onWatchlistsChanged: () => eventsOf(ctx)?.emit('watchlists'),
      onSelectionChanged: () => eventsOf(ctx)?.emit('selection'),
    }
    const shared = {
      register: (tool: ReturnType<typeof defineTool>) => {
        if (tools.get(tool.name) === undefined) tools.register(tool)
      },
    }
    shared.register(createWatchlistListTool(hookDeps))
    shared.register(createWatchlistAddTool(hookDeps))
    shared.register(createWatchlistRemoveTool(hookDeps))
    shared.register(createWatchlistSelectTool(hookDeps))
  })
}

/** Host plugin body：file store provide + 4 工具注册（host 平面，全会话可见）。 */
export function apply(ctx: Context): void {
  const watchlists = createFileWatchlistStore(defaultWatchlistStorePath())
  const selection = createFileSelectionStore(defaultSelectionStorePath())
  registerWatchlistTools(ctx, { watchlists, selection })
}

// 单测便利再导出（内存版）。
export { createMemorySelectionStore, createMemoryWatchlistStore }
