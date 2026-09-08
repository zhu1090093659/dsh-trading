/**
 * @dshtrading/watchlist/plugin —— 自选股 Agent 工具 host 半插件（issue #32 / P3）。
 *
 * patch 行：id `dsh-trading-watchlist` / name `@dshtrading/watchlist/plugin`
 * （base 拥有该共享行）。host 平面注册 8 工具（全会话可见，owner 裁决 D4）：
 * - `watchlist_list`：全市场自选行 + 分组名册 + 当前选中（只读）——合并用户定制
 *   行与市场种子行（seeds.ts 单源，与 GUI 左栏展示一致；2026-09-02 可见性修复；
 *   2026-09-08 / issue #86 补 groups 与 selection 回显）。
 * - `watchlist_add`：追加一行（同市场按 symbol 去重）→ emit 'watchlists'；
 * - `watchlist_remove`：移除一行 → emit 'watchlists'；
 * - `watchlist_select`：设置选中标的 → emit 'selection'（客户端 SSE 收到后中栏切图）。
 * - `watchlist_group_create` / `_rename` / `_delete` / `_assign`：自定义分组
 *   CRUD 与行级归属（issue #86 / G5，审计缺口卡）→ emit 'watchlists'。
 *   分组注册表与桥共用同一 file store 实例（WatchlistStoreService.groups）。
 *
 * 词汇纪律：market/symbol 用市场规范形，本插件不归一化（原样落盘）。
 */
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import path from 'node:path'
import { dshHomeDir } from '@dshtrading/dsh-home'
import { createMemorySelectionStore, createMemoryWatchlistGroupsStore, createMemoryWatchlistStore } from './index.ts'
import type { SelectionStore, WatchlistGroup, WatchlistGroupsStore, WatchlistInstrument, WatchlistStore, WatchlistsMap } from './index.ts'
import { effectiveWatchlistRows, WATCHLIST_SEEDS, watchlistRowSource } from './seeds.ts'
import { createFileSelectionStore, createFileWatchlistGroupsStore, createFileWatchlistStore } from './file-store.ts'

// 桥（client-ui-trading node 半）经本子路径取 file store（knowledge/tool 同款再导出先例）。
export { createFileSelectionStore, createFileWatchlistGroupsStore, createFileWatchlistStore }

/** Cordis 插件名 = patch 行 id（TEMPLATES §8），市场无关共享行命名空间。 */
export const name = 'dsh-trading-watchlist'

/** 本插件不硬依赖任何服务；tools 经 ctx.inject 声明。 */
export const inject: string[] = []

/** 默认存储路径：$DSH_HOME/watchlists.json（缺省 ~/.dsh）。 */
export function defaultWatchlistStorePath(): string {
  return path.join(dshHomeDir(), 'watchlists.json')
}

export function defaultSelectionStorePath(): string {
  return path.join(dshHomeDir(), 'selection.json')
}

/** 默认分组注册表路径：$DSH_HOME/watchlist-groups.json（issue #82）。 */
export function defaultWatchlistGroupsStorePath(): string {
  return path.join(dshHomeDir(), 'watchlist-groups.json')
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
  return { market, symbol, ...(name !== undefined ? { name } : {}) }
}

export interface WatchlistToolDeps {
  watchlists: WatchlistStore
  selection: SelectionStore
  /** 分组注册表（issue #86 / G5）：缺席时分组工具明确报错，不静默降级。 */
  groups?: WatchlistGroupsStore
  onWatchlistsChanged?: () => void
  onSelectionChanged?: () => void
}

/** 分组注册表取用（缺席 = 老部署，写工具必须响亮失败而不是假装成功）。 */
function requireGroups(deps: WatchlistToolDeps, tool: string): WatchlistGroupsStore {
  if (deps.groups === undefined) {
    throw new Error(`${tool}: watchlist group store is not mounted — upgrade the dsh-trading profile so @dshtrading/watchlist/plugin provides it`)
  }
  return deps.groups
}

/** 分组名校验（与桥 parseGroupNameBody 同口径：trim 非空、≤24 字符）。 */
function parseGroupName(raw: unknown, tool: string): string {
  const name = typeof raw === 'string' ? raw.trim() : ''
  if (!name) throw new Error(`${tool}: name is required (non-empty string)`)
  if (name.length > 24) throw new Error(`${tool}: group name too long (24 chars max, got ${name.length})`)
  return name
}

function parseGroupId(raw: unknown, tool: string): string {
  const id = typeof raw === 'string' ? raw.trim() : ''
  if (!id) throw new Error(`${tool}: id is required (a group id from watchlist_list / watchlist_group_create)`)
  return id
}

/** 全表统计某分组的成员行数（合并视图口径 = 用户实际看到的行）。 */
function countGroupMembers(map: WatchlistsMap, groupId: string): number {
  let count = 0
  for (const market of Object.keys(map)) {
    for (const row of effectiveWatchlistRows(map, market)) {
      if (Array.isArray(row.groups) && row.groups.includes(groupId)) count += 1
    }
  }
  return count
}

export function createWatchlistListTool(deps: WatchlistToolDeps) {
  return defineTool({
    name: 'watchlist_list',
    description:
      'List the user\'s watchlist exactly as displayed in the trading GUI sidebar, across all markets (crypto/us/cn/hk). '
      + 'Rows merge the user\'s customized entries (source "custom") with each market\'s default seed rows (source "seed", '
      + 'shown while that market has no custom edits) — the GUI shows the same rows, so this list IS what the user sees. '
      + 'It also maps display names to symbols (e.g. 苹果 → AAPL / us, 贵州茅台 → 600519 / cn). '
      + 'It also returns "groups" (the user\'s custom groups with id, name and member count) and "selection" (the instrument '
      + 'currently focused in the GUI chart, or null). Group membership lives on each row as row.groups (group ids); rows without '
      + 'groups are ungrouped. ALWAYS call this first when the user mentions any instrument by name or symbol, when you need a group '
      + 'id for watchlist_group_assign/rename/delete, or when you need the current selection; never conclude an instrument '
      + 'is untracked from docs or connector coverage alone. Read-only.',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute() {
      const map: WatchlistsMap = await deps.watchlists.list()
      // 合并视图 = 客户端 rowsFor 同构：定制行优先，未定制市场回落种子行
      // （seeds.ts 单一事实源）——Agent 看到的行与 GUI 左栏一致。
      const markets = [...new Set([...Object.keys(WATCHLIST_SEEDS), ...Object.keys(map)])]
      const watchlists: WatchlistsMap = {}
      const sources: Record<string, 'custom' | 'seed'> = {}
      let total = 0
      for (const market of markets) {
        const rows = effectiveWatchlistRows(map, market)
        watchlists[market] = rows
        sources[market] = watchlistRowSource(map, market)
        total += rows.length
      }
      // 分组与选中态回显（issue #86 / G5）：与 GUI 左栏同源，agent 因此拿得到
      // 分组 id（此前 group id 只能由用户在 UI 里读出来）。
      const groupRows: WatchlistGroup[] = deps.groups === undefined ? [] : await deps.groups.list()
      const groups = groupRows.map(group => ({
        id: group.id,
        name: group.name,
        createdAt: group.createdAt,
        members: countGroupMembers(watchlists, group.id),
      }))
      const selection = (await deps.selection.get()).instrument
      return JSON.stringify({ ok: true, total, markets, sources, watchlists, groups, selection })
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
      // 名称解析走合并视图（定制行优先，种子行兜底——与 watchlist_list 同源，
      // 否则 agent 从 list 看到"腾讯控股 00700"再 select 却拿不到展示名）。
      const map = await deps.watchlists.list()
      const row = effectiveWatchlistRows(map, market).find(row => row.symbol === symbol)
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

export function createWatchlistGroupCreateTool(deps: WatchlistToolDeps) {
  return defineTool({
    name: 'watchlist_group_create',
    description:
      'Create a named custom watchlist group (a cross-market bucket for organizing the user watchlist, e.g. "港股观察" / "核心仓"). '
      + 'Group names are unique (trimmed, 24 chars max); creating an existing name is refused. '
      + 'The returned id is what watchlist_group_assign / watchlist_group_rename / watchlist_group_delete take — call watchlist_list first '
      + 'to see existing groups and their member counts. The open GUI sidebar refreshes live over the SSE invalidation channel.',
    parameters: {
      name: {
        type: 'string',
        required: true,
        description: 'Group display name (non-empty, 24 chars max, unique among groups)',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(raw) {
      const groups = requireGroups(deps, 'watchlist_group_create')
      const name = parseGroupName(((raw ?? {}) as Record<string, unknown>).name, 'watchlist_group_create')
      const result = await groups.create(name)
      if (result.error === 'duplicate') {
        return JSON.stringify({
          ok: false,
          code: 'duplicate',
          note: `A group named ${JSON.stringify(name)} already exists — call watchlist_list to see the existing groups and reuse that id.`,
        })
      }
      if (result.group === undefined) {
        return JSON.stringify({ ok: false, code: 'unavailable', note: 'The watchlist group store returned no group.' })
      }
      deps.onWatchlistsChanged?.()
      return JSON.stringify({
        ok: true,
        id: result.group.id,
        name: result.group.name,
        note: `Created group ${JSON.stringify(result.group.name)} (id ${result.group.id}, 0 members). Assign instruments with watchlist_group_assign.`,
      })
    },
  })
}

export function createWatchlistGroupRenameTool(deps: WatchlistToolDeps) {
  return defineTool({
    name: 'watchlist_group_rename',
    description:
      'Rename a custom watchlist group by id (membership is untouched — only the display name changes). '
      + 'Refused when the id is unknown or the new name is already used by another group. '
      + 'Call watchlist_list first to get the id and report the old → new name back to the user.',
    parameters: {
      id: {
        type: 'string',
        required: true,
        description: 'Group id from watchlist_list / watchlist_group_create',
      },
      name: {
        type: 'string',
        required: true,
        description: 'New group display name (non-empty, 24 chars max, unique among groups)',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(raw) {
      const groups = requireGroups(deps, 'watchlist_group_rename')
      const args = (raw ?? {}) as Record<string, unknown>
      const id = parseGroupId(args.id, 'watchlist_group_rename')
      const name = parseGroupName(args.name, 'watchlist_group_rename')
      const before = (await groups.list()).find(group => group.id === id)
      const result = await groups.rename(id, name)
      if (result.error === 'not-found') {
        return JSON.stringify({ ok: false, code: 'not-found', note: `No watchlist group with id ${JSON.stringify(id)} — call watchlist_list for the current ids.` })
      }
      if (result.error === 'duplicate') {
        return JSON.stringify({ ok: false, code: 'duplicate', note: `Another group is already named ${JSON.stringify(name)} — pick a different name.` })
      }
      if (result.group === undefined) {
        return JSON.stringify({ ok: false, code: 'unavailable', note: 'The watchlist group store returned no group.' })
      }
      deps.onWatchlistsChanged?.()
      return JSON.stringify({
        ok: true,
        id: result.group.id,
        from: before?.name ?? null,
        to: result.group.name,
        note: `Renamed group ${JSON.stringify(before?.name ?? id)} → ${JSON.stringify(result.group.name)} (membership unchanged).`,
      })
    },
  })
}

export function createWatchlistGroupDeleteTool(deps: WatchlistToolDeps) {
  return defineTool({
    name: 'watchlist_group_delete',
    description:
      'Delete a custom watchlist group by id. Deleting a group clears its membership from every watchlist row but NEVER deletes '
      + 'watchlist rows themselves (the instruments stay in the watchlist, only the grouping is dropped). '
      + 'DISCIPLINE: before calling this, tell the user the group name and how many member rows it has (watchlist_list returns members), '
      + 'and call it only after they confirm; then report the same numbers back after the call. '
      + 'Refused when the id is unknown. The open GUI sidebar refreshes live over the SSE invalidation channel.',
    parameters: {
      id: {
        type: 'string',
        required: true,
        description: 'Group id from watchlist_list (unknown id is refused)',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(raw) {
      const groups = requireGroups(deps, 'watchlist_group_delete')
      const id = parseGroupId(((raw ?? {}) as Record<string, unknown>).id, 'watchlist_group_delete')
      const target = (await groups.list()).find(group => group.id === id)
      if (target === undefined) {
        return JSON.stringify({ ok: false, code: 'not-found', note: `No watchlist group with id ${JSON.stringify(id)} — call watchlist_list for the current ids.` })
      }
      // 顺序与桥一致：先清全表成员关系，再删注册表行（否则行上留悬挂 id）。
      const membersCleared = await deps.watchlists.stripGroup(id)
      const removed = await groups.remove(id)
      if (removed || membersCleared > 0) deps.onWatchlistsChanged?.()
      return JSON.stringify({
        ok: true,
        id,
        name: target.name,
        removed,
        membersCleared,
        note: removed
          ? `Deleted group ${JSON.stringify(target.name)} (${membersCleared} row(s) lost this membership). The watchlist rows themselves are untouched.`
          : `Group ${JSON.stringify(target.name)} was already gone; ${membersCleared} stale membership(s) cleaned.`,
      })
    },
  })
}

export function createWatchlistGroupAssignTool(deps: WatchlistToolDeps) {
  return defineTool({
    name: 'watchlist_group_assign',
    description:
      'Add or remove one watchlist instrument to/from a custom group (set member=true to add, member=false to remove). '
      + 'The instrument must already be in the watchlist or be a market seed row; when the market has no customized rows yet the '
      + 'target row is materialized from that market seed baseline first (result field materialized=true) — this mirrors the GUI drag '
      + 'behavior, and no other rows are lost. Removing membership never deletes the watchlist row. '
      + 'Unknown group ids are refused (no dangling membership). The open GUI sidebar refreshes live over the SSE invalidation channel.',
    parameters: {
      id: {
        type: 'string',
        required: true,
        description: 'Group id from watchlist_list / watchlist_group_create',
      },
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
      member: {
        type: 'boolean',
        required: true,
        description: 'true = add the instrument to the group; false = remove it from the group',
      },
      name: {
        type: 'string',
        description: 'Optional display name used only when the row must be materialized, e.g. 贵州茅台',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(raw) {
      const groups = requireGroups(deps, 'watchlist_group_assign')
      const args = (raw ?? {}) as Record<string, unknown>
      const id = parseGroupId(args.id, 'watchlist_group_assign')
      const { market, symbol } = parseInstrumentArgs(args)
      const displayName = typeof args.name === 'string' && args.name.trim() ? args.name.trim() : undefined
      if (typeof args.member !== 'boolean') {
        throw new Error('watchlist_group_assign: member is required (true = add to the group, false = remove from it)')
      }
      const member = args.member
      const target = (await groups.list()).find(group => group.id === id)
      if (target === undefined) {
        return JSON.stringify({ ok: false, code: 'not-found', note: `No watchlist group with id ${JSON.stringify(id)} — call watchlist_list for the current ids.` })
      }

      let materialized = false
      if (member) {
        const map = await deps.watchlists.list()
        const rows = map[market]
        if (!Array.isArray(rows)) {
          // 未定制市场：整体物化该市场种子基线（只物化单行会让「键存在 = 已定制」
          // 语义把该市场其余默认行判成已删除）——桥 addWatchlistGroupMember 同款。
          const seeds = WATCHLIST_SEEDS[market] ?? []
          const baseline: WatchlistInstrument[] = seeds.map(row => ({
            market: row.market,
            symbol: row.symbol,
            ...(row.name !== undefined ? { name: row.name } : {}),
          }))
          if (!baseline.some(row => row.symbol === symbol)) {
            baseline.push({ market, symbol, ...(displayName !== undefined ? { name: displayName } : {}) })
          }
          await deps.watchlists.save({ ...map, [market]: baseline })
          materialized = true
        } else if (!rows.some(row => row.symbol === symbol)) {
          materialized = await deps.watchlists.add(market, {
            market,
            symbol,
            ...(displayName !== undefined ? { name: displayName } : {}),
          })
        }
      }

      const changed = await deps.watchlists.assignGroup(market, symbol, id, member)
      if (changed || materialized) deps.onWatchlistsChanged?.()
      return JSON.stringify({
        ok: true,
        id,
        group: target.name,
        market,
        symbol,
        assigned: member ? changed : false,
        removed: member ? false : changed,
        materialized,
        note: member
          ? (changed
            ? `Added ${symbol} (${market}) to group ${JSON.stringify(target.name)}${materialized ? ' (row materialized from the market seed baseline)' : ''}.`
            : `${symbol} (${market}) is already in group ${JSON.stringify(target.name)} (nothing changed).`)
          : (changed
            ? `Removed ${symbol} (${market}) from group ${JSON.stringify(target.name)}; the watchlist row itself is untouched.`
            : `${symbol} (${market}) was not in group ${JSON.stringify(target.name)} (nothing changed).`),
      })
    },
  })
}

export interface WatchlistPluginDeps {
  watchlists: WatchlistStore
  selection: SelectionStore
  groups: WatchlistGroupsStore
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
    // 分组工具族（issue #86 / G5）：与桥共用同一 groups store 实例（双 store 前科）。
    shared.register(createWatchlistGroupCreateTool(hookDeps))
    shared.register(createWatchlistGroupRenameTool(hookDeps))
    shared.register(createWatchlistGroupDeleteTool(hookDeps))
    shared.register(createWatchlistGroupAssignTool(hookDeps))
  })
}

/** SDK 服务键：自选/选中 store 单实例（桥与工具共享同一缓存；2026-09-08 审查 H1 收口）。 */
export const TRADING_WATCHLIST_KEY = 'tradingWatchlist'

/**
 * 自选 + 选中 store 服务（单实例共享点，strategies/indicators 同款 provide 模式）。
 *
 * 2026-09-08 审查实证：桥（client-ui-trading node 半）此前自建第二个 file store，
 * 与工具侧实例各持整表缓存、各自整表回写 → 两侧写互相覆盖（agent `watchlist_add`
 * 抹掉 GUI 刚写入的行与全部分组归属）。服务缺席（老部署）时桥仍回退自建实例。
 */
export class WatchlistStoreService extends Service {
  readonly store: WatchlistStore
  readonly selection: SelectionStore
  /** 分组注册表单实例（issue #86 / G5）：工具与桥共用，杜绝双 store 互踩。 */
  readonly groups: WatchlistGroupsStore
  constructor(
    ctx: Context,
    deps: { watchlists: WatchlistStore; selection: SelectionStore; groups: WatchlistGroupsStore },
    serviceName: string = TRADING_WATCHLIST_KEY,
  ) {
    super(ctx, serviceName)
    this.store = deps.watchlists
    this.selection = deps.selection
    this.groups = deps.groups
  }
}

/** Host plugin body：file store provide + 4 工具注册（host 平面，全会话可见）。 */
export function apply(ctx: Context): void {
  const watchlists = createFileWatchlistStore(defaultWatchlistStorePath())
  const selection = createFileSelectionStore(defaultSelectionStorePath())
  const groups = createFileWatchlistGroupsStore(defaultWatchlistGroupsStorePath())
  // Service 单实例（审查 H1）：桥经 ctx.get 解包 .store/.selection/.groups 复用同一 file store。
  new WatchlistStoreService(ctx, { watchlists, selection, groups })
  registerWatchlistTools(ctx, { watchlists, selection, groups })
}

// 单测便利再导出（内存版）。
export { createMemorySelectionStore, createMemoryWatchlistGroupsStore, createMemoryWatchlistStore }
