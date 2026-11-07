/**
 * 特殊指标 agent 工具面（五只只读工具）——四组专有指标（IF/IM 期现基差、
 * A 股恐慌指数、恒科前十大权重股卖空、板块融资余额）直接进模型上下文。
 *
 * 纪律（与浏览器半同源，取自 docs/api.md 与桥的既有裁决）：
 *
 * 1. **同一取数实例**：工具只调 `FinanceClient.getWithMeta`——即 apply() 里那个
 *    client（同一 TTL/落盘缓存、in-flight 去重、SWR 陈旧回源、同一凭据链）。
 *    路径一律经 src/routes.ts 的白名单子路由拼装，绝不自行拼 URL、绝不读写
 *    cache.json 文件当数据源（文件只是缓存镜像）。
 * 2. **只读 GET**：不新增写方法，工具面拿不到下单/撤单/改参/改台账能力。
 * 3. **不可用 ≠ 空数据**：上游失败、凭据缺失、路由拒绝一律抛错，错误文案带
 *    FinanceError 的 code 并写明「没拿到数据」，绝不返回空列表冒充成功。
 * 4. **日期与滞后如实**：`expected_data_date` 上游有就原样透传，没有就用
 *    payload 里的日期字段推导并标注 `expected_data_date_source`；推不出来就
 *    省略该字段并留 note，绝不编造。`stale` 同理：上游声明优先（原样透传，不
 *    与其它信号做或运算），没有声明时按「数据日 < 应有数据日」派生；桥缓存档
 *    返回的过期条目单独放 `cache_stale`，两者由 `stale_source` 写明——`stale`
 *    是**数据面**的滞后，`cache_stale` 是**读取面**的陈旧，别混成一个布尔。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { FinanceClient } from './finance-client.ts'
import { FinanceError } from './finance-client.ts'
import { SECTOR_CODE_RE, buildUpstreamPath, tierOf, tierTtlMs, type CacheTierConfig, type RouteConfig } from './routes.ts'

/** 工具面配置面（apply() 的 Config 结构上兼容；只需要这几项）。 */
export interface IndicatorToolConfig extends RouteConfig, CacheTierConfig {
  /** 自有 finance 服务地址（只用于出参 source，凭据永不进出参）。 */
  baseUrl: string
}

/** 五只工具名（patch/门禁/测试引用同一份清单）。 */
export const INDICATOR_TOOL_NAMES = [
  'special_indicators_get_snapshot',
  'special_indicators_get_sentiment_history',
  'special_indicators_get_sector_ranking',
  'special_indicators_get_sector_series',
  'special_indicators_get_hk_short_top10',
] as const

const SNAPSHOT_GROUPS = ['basis', 'sentiment', 'hk_short', 'sectors'] as const
type SnapshotGroup = typeof SNAPSHOT_GROUPS[number]

/** 数组类出参的截断上限（超过即带 truncated: true）。 */
const MAX_PRODUCTS = 20
const MAX_SECTOR_ROWS = 60
const MAX_KEY_LIST = 20

const textOutput = {
  schema: { type: 'string' as const },
  render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
}

/* --------------------------------- 取数 ---------------------------------- */

interface ReadResult {
  payload: unknown
  /** 上游路径（出参 source 与错误文案都要写清打到哪个路径）。 */
  path: string
  /** 桥缓存档返回了过期条目（SWR 陈旧服役）——与上游数据滞后是两件事。 */
  cacheStale: boolean
}

async function read(client: FinanceClient, config: IndicatorToolConfig, tool: string, label: string, sub: string, params: Record<string, string | number> = {}): Promise<ReadResult> {
  const tier = tierOf(sub)
  if (tier === undefined) throw new Error(tool + ': 内部错误：' + sub + ' 不在白名单子路由表里')
  const path = buildUpstreamPath(sub, params, config)
  if (path === null) throw new Error(tool + ': ' + label + ' 参数未通过白名单子路由校验（' + sub + '），未发出请求')
  try {
    const { payload, meta } = await client.getWithMeta(path, tierTtlMs(tier, config))
    return { payload, path, cacheStale: meta.stale === true }
  } catch (error) {
    const detail = error instanceof FinanceError ? error.code + ': ' + error.message : error instanceof Error ? error.message : String(error)
    throw new Error(tool + ': ' + label + ' 没拿到数据（上游 GET ' + path + '）— ' + detail)
  }
}

function describe(value: unknown): string {
  const text = JSON.stringify(value)
  if (text === undefined) return String(value)
  return text.length > 120 ? text.slice(0, 120) + '…' : text
}

/** 载荷必须是对象（数组/标量/error 信封都不算）——坏形状响亮抛错，不静默当空。 */
function asRecord(tool: string, label: string, result: ReadResult): Record<string, unknown> {
  const { payload, path } = result
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(tool + ': ' + label + ' 没拿到数据（上游 GET ' + path + ' 返回非对象载荷：' + describe(payload) + '）')
  }
  return payload as Record<string, unknown>
}

function asRows(tool: string, label: string, result: ReadResult): Record<string, unknown>[] {
  const { payload, path } = result
  if (!Array.isArray(payload)) {
    throw new Error(tool + ': ' + label + ' 没拿到数据（上游 GET ' + path + ' 返回非数组载荷：' + describe(payload) + '）')
  }
  return payload.filter((row): row is Record<string, unknown> => row !== null && typeof row === 'object' && !Array.isArray(row))
}

/* ------------------------------- 取值与日期 ------------------------------- */

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function bool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

/** 标量对象（非数组、非 null）；其它形状 = undefined。 */
function asPlainRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function rows(value: unknown): Record<string, unknown>[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.filter((row): row is Record<string, unknown> => row !== null && typeof row === 'object' && !Array.isArray(row))
}

/** 取对象里的标量字段（缺字段 = undefined，出参里随之省略；不补零、不编造）。 */
function fields(row: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of keys) {
    const value = row[key]
    if (value === undefined) continue
    out[key] = value
  }
  return out
}

function firstRow(list: readonly Record<string, unknown>[]): Record<string, unknown> | undefined {
  return list.length > 0 ? list[0] : undefined
}

function lastRow(list: readonly Record<string, unknown>[]): Record<string, unknown> | undefined {
  return list.length > 0 ? list[list.length - 1] : undefined
}

/** `YYYY-MM-DD` 或 `YYYY-MM-DD HH:MM[:SS]` → 日期部分；其它形状 = undefined。 */
function datePart(value: unknown): string | undefined {
  const text = str(value)
  if (text === undefined) return undefined
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(text)
  return match === null ? undefined : match[1]
}

function maxDate(values: readonly (string | undefined)[]): string | undefined {
  const defined = values.filter((value): value is string => value !== undefined)
  if (defined.length === 0) return undefined
  return defined.reduce((max, value) => (value > max ? value : max))
}

/** 数据日早于应有数据日才算滞后（与浏览器半 isDataBehind 同口径）。 */
function dataBehind(dataDate: string | undefined, expectedDate: string | undefined): boolean {
  if (dataDate === undefined || expectedDate === undefined) return false
  return dataDate < expectedDate
}

/** 参数夹取（上限口径与白名单子路由同源，见 test 里的路由对齐用例）。 */
function clampArg(value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined || value === null) return fallback
  const parsed = Math.floor(Number(value))
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

/* -------------------------------- 出参信封 -------------------------------- */

function sourceOf(config: IndicatorToolConfig, paths: readonly string[]): string {
  return '自有 finance 服务（owner self-hosted，HTTP Basic，' + config.baseUrl + '）—上游 GET ' + paths.join(' + ')
}

interface StaleInput {
  /** 上游声明的 stale（有则原样透传，优先于派生）。 */
  declared?: boolean | undefined
  /** 派生的数据滞后（调用方只在可推导时给值）。 */
  lag?: boolean | undefined
  /** 上游声明字段的路径，如 /api/sentiment/snapshot.stale。 */
  upstreamSource?: string | undefined
  /** 派生滞后的依据，如 'snapshot data_date < expected_data_date'。 */
  lagSource?: string | undefined
  cacheStale: boolean
}

/** stale = 上游声明（原样透传，优先）→ 无可声明时按日期派生；来源写进 stale_source。 */
function staleOf(input: StaleInput): { stale: boolean; stale_source: string; cache_stale: boolean } {
  const parts: string[] = []
  if (input.declared !== undefined) parts.push('upstream: ' + (input.upstreamSource ?? 'payload.stale'))
  else if (input.lagSource !== undefined) parts.push('derived: ' + input.lagSource)
  else parts.push('no upstream stale/date signal')
  if (input.cacheStale) parts.push('bridge cache served an expired entry (cache_stale)')
  return {
    stale: input.declared ?? input.lag ?? false,
    stale_source: parts.join('; '),
    cache_stale: input.cacheStale,
  }
}

function noteIf(condition: boolean, note: string): string[] {
  return condition ? [note] : []
}

/* ------------------------------ 快照：四组分组面 ------------------------------ */

interface GroupResult {
  value: Record<string, unknown>
  stale: boolean
  staleSource: string
  cacheStale: boolean
  notes: string[]
}

async function basisGroup(client: FinanceClient, config: IndicatorToolConfig, tool: string): Promise<GroupResult> {
  const result = await read(client, config, tool, 'snapshot:group=basis', '/basis/snapshot')
  const payload = asRecord(tool, 'snapshot:group=basis', result)
  const products = rows(payload.products) ?? []
  const stats = asPlainRecord(payload.stats) ?? {}
  const statFields = ['min', 'max', 'mean', 'last', 'pct', 'p25', 'p75', 'n'] as const
  const statsOut: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(stats)) {
    const row = asPlainRecord(value)
    statsOut[key] = row === undefined ? value : fields(row, statFields)
  }
  const productsOut = products.slice(0, MAX_PRODUCTS).map((row) => fields(row, ['key', 'name', 'last_spot', 'last_fut', 'last_dt']))
  // /api/snapshot 不声明数据日：用各产品日内行情时间 last_dt 的日期部分推导（基差是实时快照）。
  const expected = maxDate(products.map((row) => datePart(row.last_dt)))
  const stale = staleOf({ cacheStale: result.cacheStale })
  return {
    value: {
      ready: bool(payload.ready),
      stats: statsOut,
      products: productsOut,
      products_count: products.length,
      ...(products.length > productsOut.length ? { products_truncated: true } : {}),
      ...(expected !== undefined ? { expected_data_date: expected, expected_data_date_source: 'derived: products[].last_dt 的最大日期（日内行情时间，非上游声明的应有数据日）' } : {}),
      ...stale,
    },
    stale: stale.stale,
    staleSource: stale.stale_source,
    cacheStale: result.cacheStale,
    notes: noteIf(expected === undefined, 'products[].last_dt 推不出日期，expected_data_date 已省略（不编造）'),
  }
}

async function sentimentGroup(client: FinanceClient, config: IndicatorToolConfig, tool: string): Promise<GroupResult> {
  const result = await read(client, config, tool, 'snapshot:group=sentiment', '/sentiment/snapshot')
  const payload = asRecord(tool, 'snapshot:group=sentiment', result)
  const components = rows(payload.components) ?? []
  const missing = Array.isArray(payload.missing_components) ? payload.missing_components : []
  const declared = bool(payload.stale)
  const stale = staleOf({ declared, upstreamSource: '/api/sentiment/snapshot.stale', cacheStale: result.cacheStale })
  return {
    value: {
      ...fields(payload, ['market', 'score', 'label', 'label_text', 'date', 'expected_data_date', 'average_5d', 'vs_5d', 'methodology_version', 'source_version', 'coverage']),
      components_count: components.length,
      missing_components: missing.slice(0, MAX_KEY_LIST),
      ...(missing.length > MAX_KEY_LIST ? { missing_components_truncated: true } : {}),
      ...stale,
    },
    stale: stale.stale,
    staleSource: stale.stale_source,
    cacheStale: result.cacheStale,
    notes: noteIf(missing.length > 0, 'missing_components 非空：上游有分项缺数据，分数按有效分项口径给出'),
  }
}

async function hkShortGroup(client: FinanceClient, config: IndicatorToolConfig, tool: string): Promise<GroupResult> {
  const result = await read(client, config, tool, 'snapshot:group=hk_short', '/hk-short/snapshot')
  const payload = asRecord(tool, 'snapshot:group=hk_short', result)
  const top10 = rows(payload.top10) ?? []
  const stale = staleOf({ cacheStale: result.cacheStale })
  return {
    value: {
      ...fields(payload, ['ready', 'data_date', 'index_data_date', 'short_data_date', 'last_update', 'data_version', 'updating', 'n_days', 'n_stocks', 'five_day']),
      top10: top10.slice(0, 10).map((row) => fields(row, ['code', 'name', 'weight'])),
      ...(top10.length > 10 ? { top10_truncated: true } : {}),
      ...stale,
    },
    stale: stale.stale,
    staleSource: stale.stale_source,
    cacheStale: result.cacheStale,
    notes: noteIf(
      bool(payload.updating) === true,
      'updating=true：上游仍在更新本轮数据，读数可能随后被改写',
    ).concat('上游 /api/hk-short/snapshot 不提供 expected_data_date；滞后请比对 index_data_date 与 short_data_date 两条源尾日，或用 special_indicators_get_hk_short_top10（含 chart 声明的 stale）'),
  }
}

async function sectorsGroup(client: FinanceClient, config: IndicatorToolConfig, tool: string): Promise<GroupResult> {
  const result = await read(client, config, tool, 'snapshot:group=sectors', '/sectors/snapshot')
  const payload = asRecord(tool, 'snapshot:group=sectors', result)
  const sectors = rows(payload.sectors) ?? []
  const missing = Array.isArray(payload.missing_margin) ? payload.missing_margin : []
  const expected = str(payload.expected_data_date)
  const dataDate = str(payload.data_date)
  const lag = dataBehind(dataDate, expected)
  const lagSource = expected !== undefined && dataDate !== undefined ? 'snapshot data_date < expected_data_date' : undefined
  const stale = staleOf({ lag, lagSource, cacheStale: result.cacheStale })
  return {
    value: {
      ...fields(payload, ['data_date', 'expected_data_date', 'index_data_date', 'last_update', 'data_version', 'updating', 'n_ready', 'n_total', 'n_loaded', 'five_day']),
      sectors: sectors.slice(0, MAX_SECTOR_ROWS).map((row) => fields(row, ['code', 'name', 'type'])),
      sectors_count: sectors.length,
      ...(sectors.length > MAX_SECTOR_ROWS ? { sectors_truncated: true } : {}),
      missing_margin: missing.slice(0, MAX_KEY_LIST),
      ...(missing.length > MAX_KEY_LIST ? { missing_margin_truncated: true } : {}),
      stale_sectors: (Array.isArray(payload.stale_sectors) ? payload.stale_sectors : []).slice(0, MAX_KEY_LIST),
      ...stale,
    },
    stale: stale.stale,
    staleSource: stale.stale_source,
    cacheStale: result.cacheStale,
    notes: noteIf(
      lagSource === undefined,
      'data_date/expected_data_date 不同时具备，无法派生数据滞后（不猜）',
    ).concat(noteIf(missing.length > 0, 'missing_margin 非空：部分板块当日融资数据缺失（其 ranking 值可能是零占位）')),
  }
}

/* --------------------------------- 工具工厂 --------------------------------- */

/** 快照工具名：`defineTool.name` 必须写成字面量（scripts/tool-surface-inventory 逐
 *  defineTool 读字面量名，写成常量引用会把契约面记成常量名 SNAPSHOT_TOOL）。 */
const SNAPSHOT_TOOL = 'special_indicators_get_snapshot'

const GROUP_BUILDERS: Record<SnapshotGroup, (client: FinanceClient, config: IndicatorToolConfig, tool: string) => Promise<GroupResult>> = {
  basis: basisGroup,
  sentiment: sentimentGroup,
  hk_short: hkShortGroup,
  sectors: sectorsGroup,
}

/** 工具集合：传入 apply() 里那个 FinanceClient 即得全部工具（测试可注入 fake fetch 的 client）。 */
export function createSpecialIndicatorTools(client: FinanceClient, config: IndicatorToolConfig): Array<ReturnType<typeof defineTool>> {
  return [
    defineTool({
      name: 'special_indicators_get_snapshot',
      description:
        'Special-indicator snapshots from the owner\'s self-hosted finance service, read through this plugin\'s local bridge (read-only GET, same client and cache as the UI tab). '
        + 'Four groups: `basis` = IF/IM index-futures basis (intraday stats + per-product last values), `sentiment` = A-share fear & greed index (0-100, lower = more fear), '
        + '`hk_short` = HSTECH top-10 heavyweight short-selling, `sectors` = sector margin-financing readiness. Omit `group` for all four. '
        + 'Every group carries `as_of` (this read), `stale` with `stale_source` (upstream-declared, date-derived, or bridge-cache), and `source`; null/empty upstream values are NOT filled with zeros. '
        + 'An upstream failure, missing credential or rejected route raises an error naming the FinanceError code — it never returns an empty result.',
      parameters: {
        group: {
          type: 'string',
          enum: [...SNAPSHOT_GROUPS],
          description: 'Which indicator group to read (omit = all four): basis | sentiment | hk_short | sectors',
        },
      },
      output: textOutput,
      async execute(raw) {
        const args = (raw ?? {}) as Record<string, unknown>
        const requested = readGroupArg(args.group)
        const built = await Promise.all(requested.map(async (group) => {
          const result = await GROUP_BUILDERS[group](client, config, SNAPSHOT_TOOL)
          return [group, result] as const
        }))
        const groups: Record<string, unknown> = {}
        const allPaths: string[] = []
        const notes: string[] = []
        let stale = false
        let cacheStale = false
        const staleSources: string[] = []
        for (const [group, result] of built) {
          groups[group] = result.value
          stale = stale || result.stale
          cacheStale = cacheStale || result.cacheStale
          staleSources.push(group + ': ' + result.staleSource)
          notes.push(...result.notes.map((note) => group + ': ' + note))
        }
        for (const sub of requested.map(groupSub)) allPaths.push(buildUpstreamPath(sub, {}, config) ?? sub)
        return JSON.stringify({
          as_of: new Date().toISOString(),
          source: sourceOf(config, allPaths),
          groups,
          groups_read: requested,
          stale,
          stale_source: staleSources.join(' | '),
          cache_stale: cacheStale,
          ...(notes.length > 0 ? { notes } : {}),
        })
      },
    }),
    defineTool({
      name: 'special_indicators_get_sentiment_history',
      description:
        'A-share fear & greed index history from the owner\'s self-hosted finance service (read-only GET through this plugin\'s bridge, same cache as the UI tab). '
        + 'Returns the scored daily series metadata: methodology/formula versions, the scored point count, first/last date and the latest series element. '
        + '`days` is the requested window (integer 30..800, default 750, clamped) — the upstream may return fewer rows than requested (its history excludes data before 2024-09-22 and is bounded by source availability). '
        + '`expected_data_date` and `stale` describe freshness; `stale_source` says whether staleness was declared upstream, derived (series tail vs expected date) or came from the bridge cache. '
        + 'Upstream failure / missing credential / rejected route raises an error carrying the FinanceError code instead of an empty series.',
      parameters: {
        days: { type: 'integer', description: 'Trading-day window to request (integer 30..800, default 750, out-of-range is clamped)' },
      },
      output: textOutput,
      async execute(raw) {
        const tool = 'special_indicators_get_sentiment_history'
        const args = (raw ?? {}) as Record<string, unknown>
        const days = clampArg(args.days, 750, 30, 800)
        const result = await read(client, config, tool, 'sentiment history days=' + days, '/sentiment/history', { days })
        const payload = asRecord(tool, 'sentiment history', result)
        const series = rows(payload.series)
        if (series === undefined) {
          throw new Error(tool + ': sentiment history 没拿到数据（上游 GET ' + result.path + ' 的 series 不是数组：' + describe(payload.series) + '）')
        }
        const firstDate = series.length > 0 ? datePart(firstRow(series)?.date) : undefined
        const lastDate = series.length > 0 ? datePart(lastRow(series)?.date) : undefined
        const expected = str(payload.expected_data_date)
        const declared = bool(payload.stale)
        const derivable = expected !== undefined && lastDate !== undefined
        const stale = staleOf({
          declared,
          upstreamSource: '/api/sentiment/history.stale',
          lag: derivable ? dataBehind(lastDate, expected) : false,
          lagSource: derivable ? 'series[] 尾日 < expected_data_date' : undefined,
          cacheStale: result.cacheStale,
        })
        const latest = lastRow(series)
        return JSON.stringify({
          as_of: new Date().toISOString(),
          source: sourceOf(config, [result.path]),
          days,
          ...fields(payload, ['market', 'methodology_version', 'formula_version', 'source_version', 'expected_data_date', 'overlay_name']),
          points: series.length,
          first_date: firstDate,
          last_date: lastDate,
          latest: latest === undefined ? undefined : fields(latest, ['date', 'score', 'label', 'label_text', 'valid_components', 'total_components']),
          ...stale,
          ...(series.length === 0 ? { notes: ['上游返回空 series（请求窗口内没有已评分点位）——这是空数据，不是取数失败'] } : {}),
        })
      },
    }),
    defineTool({
      name: 'special_indicators_get_sector_ranking',
      description:
        'Sector margin-financing ranking from the owner\'s self-hosted finance service (read-only GET through this plugin\'s bridge). '
        + 'Rows are ranked by the margin-balance change rate `chg_pct` over the last `window` trading days — NOT by same-day net buying. '
        + 'Units: `latest_margin` / `daily_change` / `avg_5d_change` / `vs_5d_change` / `total_5d_flow` are 亿元 (100M CNY); `chg_pct` / `index_5d_pct` are percent; `latest_close` is the sector index level. '
        + 'The second read (`/api/sectors/snapshot`, same client and cache) supplies `data_date` / `expected_data_date` / readiness coverage / the all-sector `five_day` summary. '
        + 'An unloaded sector\'s `latest_margin` may be a 0 placeholder (check `missing_margin`); null values are never filled with zeros. '
        + 'Upstream failure / missing credential / rejected route raises an error carrying the FinanceError code.',
      parameters: {
        window: { type: 'integer', description: 'Ranking window in trading days (integer 1..120, default 20, out-of-range is clamped)' },
        limit: { type: 'integer', description: 'Max rows to return (integer 1..60, default 20; fewer rows = `truncated: true`)' },
      },
      output: textOutput,
      async execute(raw) {
        const tool = 'special_indicators_get_sector_ranking'
        const args = (raw ?? {}) as Record<string, unknown>
        const window = clampArg(args.window, 20, 1, 120)
        const limit = clampArg(args.limit, 20, 1, 60)
        const [rankingResult, snapshotResult] = await Promise.all([
          read(client, config, tool, 'sector ranking window=' + window, '/sectors/ranking', { window }),
          read(client, config, tool, 'sector snapshot', '/sectors/snapshot'),
        ])
        const ranking = asRows(tool, 'sector ranking', rankingResult)
        const snapshot = asRecord(tool, 'sector snapshot', snapshotResult)
        const dataDate = str(snapshot.data_date)
        const expected = str(snapshot.expected_data_date)
        const derivable = dataDate !== undefined && expected !== undefined
        const lag = derivable ? dataBehind(dataDate, expected) : undefined
        const stale = staleOf({
          lag,
          lagSource: derivable ? 'snapshot data_date < expected_data_date' : undefined,
          cacheStale: rankingResult.cacheStale || snapshotResult.cacheStale,
        })
        const list = ranking.slice(0, limit).map((row) => fields(row, [
          'code', 'name', 'type', 'chg_pct', 'latest_margin', 'latest_close',
          'daily_change', 'avg_5d_change', 'vs_5d_change', 'total_5d_flow', 'index_5d_pct',
        ]))
        return JSON.stringify({
          as_of: new Date().toISOString(),
          source: sourceOf(config, [rankingResult.path, snapshotResult.path]),
          window,
          limit,
          list,
          list_count: list.length,
          ranking_rows_upstream: ranking.length,
          ...(ranking.length > list.length ? { truncated: true } : {}),
          units: {
            latest_margin: '亿元',
            daily_change: '亿元',
            avg_5d_change: '亿元',
            vs_5d_change: '亿元',
            total_5d_flow: '亿元',
            chg_pct: '%',
            index_5d_pct: '%',
            latest_close: '板块指数点',
          },
          ...fields(snapshot, ['data_date', 'expected_data_date', 'index_data_date', 'last_update', 'data_version', 'n_ready', 'n_total', 'five_day']),
          missing_margin: (Array.isArray(snapshot.missing_margin) ? snapshot.missing_margin : []).slice(0, MAX_KEY_LIST),
          ...stale,
          ...(ranking.length === 0 ? { notes: ['上游返回空排行（此窗口没有可排板块）——空数据，不是取数失败'] } : {}),
        })
      },
    }),
    defineTool({
      name: 'special_indicators_get_sector_series',
      description:
        'One sector\'s daily series from the owner\'s self-hosted finance service (read-only GET through this plugin\'s bridge, same cache as the UI tab): sector index close and margin balance `rzye` (unit: 元, raw — divide by 1e8 for 亿元). '
        + '`code` must be a sector code from special_indicators_get_snapshot / the sectors snapshot (whitelisted pattern [0-9A-Za-z]{1,12}); an unknown or not-ready sector fails loudly instead of returning an empty series. '
        + '`days` is the requested window (integer 10..500, default 200, clamped). `stale` is the upstream\'s own flag (exposed as `stale_source: upstream`); the upstream detail route declares no expected data date, so `expected_data_date` is omitted rather than guessed. '
        + 'Upstream failure / missing credential / rejected route raises an error carrying the FinanceError code.',
      parameters: {
        code: { type: 'string', required: true as const, description: 'Sector code, e.g. 801737 (from the sectors snapshot; [0-9A-Za-z]{1,12})' },
        days: { type: 'integer', description: 'Trading-day window to request (integer 10..500, default 200, out-of-range is clamped)' },
      },
      output: textOutput,
      async execute(raw) {
        const tool = 'special_indicators_get_sector_series'
        const args = (raw ?? {}) as Record<string, unknown>
        const code = typeof args.code === 'string' ? args.code.trim() : ''
        if (!SECTOR_CODE_RE.test(code)) {
          throw new Error(tool + ': 板块代码 ' + describe(args.code) + ' 不在白名单（[0-9A-Za-z]{1,12}）内，未发出请求')
        }
        const days = clampArg(args.days, 200, 10, 500)
        const result = await read(client, config, tool, 'sector series code=' + code + ' days=' + days, '/sectors/detail', { code, days })
        const payload = asRecord(tool, 'sector series', result)
        const index = rows(payload.index) ?? []
        const margin = rows(payload.margin) ?? []
        const indexFirst = firstRow(index)
        const indexLast = lastRow(index)
        const marginFirst = firstRow(margin)
        const marginLast = lastRow(margin)
        const dataDate = maxDate([indexLast === undefined ? undefined : datePart(indexLast.date), marginLast === undefined ? undefined : datePart(marginLast.date)])
        const declared = bool(payload.stale)
        const stale = staleOf({ declared, upstreamSource: '/api/v2/sectors/{code}.stale', cacheStale: result.cacheStale })
        return JSON.stringify({
          as_of: new Date().toISOString(),
          source: sourceOf(config, [result.path]),
          code: str(payload.code) ?? code,
          ...fields(payload, ['name', 'type']),
          days,
          points: { index: index.length, margin: margin.length },
          index_first: indexFirst === undefined ? undefined : fields(indexFirst, ['date', 'close']),
          index_last: indexLast === undefined ? undefined : fields(indexLast, ['date', 'close']),
          margin_first: marginFirst === undefined ? undefined : fields(marginFirst, ['date', 'rzye']),
          margin_last: marginLast === undefined ? undefined : fields(marginLast, ['date', 'rzye']),
          ...(dataDate !== undefined ? { data_date: dataDate, data_date_source: 'derived: index[]/margin[] 尾日取最大' } : {}),
          units: { index_close: '板块指数点', margin_rzye: '元（原始口径；除以 1e8 为亿元）' },
          expected_data_date_note: '上游 /api/v2/sectors/{code} 不提供 expected_data_date（只有自声明的 stale），派生不出，故该字段省略而非编造',
          ...stale,
          ...(index.length === 0 && margin.length === 0 ? { notes: ['上游返回空 index/margin（该板块此窗口没有数据）——空数据，不是取数失败'] } : {}),
        })
      },
    }),
    defineTool({
      name: 'special_indicators_get_hk_short_top10',
      description:
        'HSTECH (Hang Seng TECH) top-10 heavyweight short-selling from the owner\'s self-hosted finance service (read-only GET through this plugin\'s bridge, same cache as the UI tab). '
        + 'Reads `/api/hk-short/snapshot` (source dates, data_version, readiness, 5-day aggregate) and `/api/hk-short/chart` (per-stock latest short ratio + history depth) with the same client. '
        + 'Per-stock `latest_pct` is the short-selling turnover share of that stock (percent, same basis as the aggregate `five_day.current_pct`); `latest_value` is 亿港元 and `vs_5d_pct` is in percentage points. '
        + 'Caveat from the upstream contract: a missing stock can come back as a 0 placeholder — check `history_days` before reading a 0 as a real observation. '
        + '`stale` is the chart payload\'s own flag (passed through, `stale_source: upstream`); no expected data date exists upstream, so it is omitted rather than guessed. '
        + 'Upstream failure / missing credential / rejected route raises an error carrying the FinanceError code.',
      parameters: {
        limit: { type: 'integer', description: 'Max constituents to return (integer 1..10, default 10 = the full top-10 set)' },
      },
      output: textOutput,
      async execute(raw) {
        const tool = 'special_indicators_get_hk_short_top10'
        const args = (raw ?? {}) as Record<string, unknown>
        const limit = clampArg(args.limit, 10, 1, 10)
        const [snapshotResult, chartResult] = await Promise.all([
          read(client, config, tool, 'hk-short snapshot', '/hk-short/snapshot'),
          read(client, config, tool, 'hk-short chart', '/hk-short/chart'),
        ])
        const snapshot = asRecord(tool, 'hk-short snapshot', snapshotResult)
        const chart = asRecord(tool, 'hk-short chart', chartResult)
        const chartRows = rows(chart.top10) ?? []
        const snapshotRows = rows(snapshot.top10) ?? []
        const byCode = new Map(chartRows.filter((row) => str(row.code) !== undefined).map((row) => [str(row.code) as string, row]))
        const merged = snapshotRows.map((row) => {
          const code = str(row.code)
          const extra = code === undefined ? undefined : byCode.get(code)
          return {
            ...fields(row, ['code', 'name', 'weight']),
            ...(extra === undefined ? {} : fields(extra, ['latest_pct', 'vs_5d_pct', 'history_days', 'latest_value', 'previous_pct', 'pct_delta'])),
          }
        })
        const top10 = merged.slice(0, limit)
        const declared = bool(chart.stale)
        const stale = staleOf({ declared, upstreamSource: '/api/hk-short/chart.stale', cacheStale: snapshotResult.cacheStale || chartResult.cacheStale })
        const missingDetail = merged.filter((row) => row.latest_pct === undefined).map((row) => str(row.code) ?? '?')
        return JSON.stringify({
          as_of: new Date().toISOString(),
          source: sourceOf(config, [snapshotResult.path, chartResult.path]),
          ...fields(snapshot, ['ready', 'data_date', 'short_data_date', 'index_data_date', 'last_update', 'data_version', 'updating', 'n_days', 'n_stocks', 'five_day']),
          limit,
          top10,
          top10_count: top10.length,
          ...(merged.length > top10.length ? { truncated: true } : {}),
          units: {
            weight: '权重（%）',
            latest_pct: '该股卖空成交额占其成交额比例（%，与聚合占比同口径）',
            vs_5d_pct: '百分点（latest_pct 与 5 日均值之差）',
            latest_value: '亿港元',
            five_day_current_value: '亿港元',
            five_day_pct_difference: '百分点',
          },
          notes: [
            '上游契约：缺失个股的 latest_pct/latest_value 可能是 0 占位（须结合 history_days 与 short_ratio 判断，0 不证明存在真实观测）',
            '上游不提供 expected_data_date：滞后以下列 short_data_date/index_data_date 两条源尾日与 chart 的 stale 判定',
            ...noteIf(missingDetail.length > 0, 'chart 缺 ' + missingDetail.join(',') + ' 的逐股明细（对应 latest_pct/vs_5d_pct 已省略，不补零）'),
          ],
          ...stale,
        })
      },
    }),
  ]
}

function readGroupArg(value: unknown): SnapshotGroup[] {
  if (value === undefined || value === null || value === '') return [...SNAPSHOT_GROUPS]
  const group = typeof value === 'string' ? value.trim() : String(value)
  if (!(SNAPSHOT_GROUPS as readonly string[]).includes(group)) {
    throw new Error(SNAPSHOT_TOOL + ': group ' + describe(value) + ' 不是可选组（' + SNAPSHOT_GROUPS.join(' | ') + '），未发出请求')
  }
  return [group as SnapshotGroup]
}

/** 组 → 白名单子路由（出参 source 里的上游路径）。 */
function groupSub(group: SnapshotGroup): string {
  switch (group) {
    case 'basis': return '/basis/snapshot'
    case 'sentiment': return '/sentiment/snapshot'
    case 'hk_short': return '/hk-short/snapshot'
    case 'sectors': return '/sectors/snapshot'
  }
}
