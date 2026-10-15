/**
 * indicator_get_values —— 指标数值读数工具（host 平面）。
 *
 * 为什么挂 host 平面：关键日的唯一权威是图表激活名册（`tradingChartActivations`
 * 单实例 → $DSH_HOME/indicators/chart.json），它与市场无关，故一个工具覆盖全市场、
 * 工具名不带市场前缀。
 *
 * 三条不可让渡的纪律：
 * 1. **关键日取现场权威值**：`ChartActivationStore.list()` 里 id=`kdas` 实例的
 *    `symbolParams[`${market}:${symbol}`]` 命中即**整体替代**全局 params（issue #72
 *    的 effectiveInstanceParams 语义，与 GUI 图表同一读法）。绝不硬编码关键日，
 *    也绝不读文档里的旧值。
 * 2. **算法不在这里重写**：computeSource 经 `runSourceInVmSandbox` 执行（与 GUI
 *    试算/图表同一条执行路径）。本模块只做「取数 → 跑指标 → 读数」和 fail-closed
 *    判据，一个事实只有一个家。
 * 3. **取数面与 GUI 图表同源解析**：候选序与桥 `/klines` 一致（active 在前，其余
 *    registry.list(market) 条目按 provider 名升序），且**只有**
 *    TRADING_UNSUPPORTED_INTERVAL 才换源；其它错误原样抛。无激活 provider 报
 *    TRADING_NO_PROVIDER，绝不返回空序列冒充「无数据」。
 *
 * fail-closed（与 `.agents/skills/weekly-trading-plan/scripts/kdas.py` 的 `kdas_lines`
 * 逐条对齐）：
 * - **锚点被窗口截断**（窗口第一根的交易日 > 关键日）→ 真锚点不在数据内，任何数字都是
 *   错的 → 该线 `truncated=true` 且**不给 value**；
 * - **关键日未生效**（关键日 > 最新一根的交易日）→ 指标根本不输出该线 → 补一条
 *   `ineffective=true`、无 value 的记录；
 * - **没有关键日 / 没有 K 线** → 整体不给数，只报缺什么（`blocked_reason`）。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { IndicatorOutput, IndicatorParamSpec, Kline } from './types.ts'
import type { CustomIndicatorStore } from './custom.ts'
import type { ChartActivationStore } from './chart-activations.ts'
import { effectiveInstanceParams } from './chart-activations.ts'
import { presetDefinitions } from './presets.ts'
import { runSourceInVmSandbox } from './validate-node.ts'

/** 市场 slug（与 base/connector 同一词汇表）。 */
export const MARKETS = ['crypto', 'us', 'cn', 'hk', 'futures', 'global'] as const
export type MarketSlug = (typeof MARKETS)[number]

/**
 * 读数只对日线有定义：KDAS 用 openTime 的 UTC 日做交易日判定，周/月线的 openTime
 * 只落在区间内某一天，锚定会把「第一根 dayNum>=关键日 的 K 线」错算成整根周线/月线
 * 的锚点。名册的 applyScope 里有 1w 也不放行——applyScope 管「挂在哪显示」，
 * 不管「本口径在该级别是否成立」。
 */
export const VALUES_INTERVAL = '1d'

/**
 * 单次请求根数上限：取路由 provider 的诚实承接上限量级（cn/hk 的 tencent 单请求
 * 天花板 `TENCENT_KLINE_MAX_BARS = 800`，超过即**静默降级到 320 根**而不是报错，
 * 见 packages/connector-tencent/src/rest.ts）。取 800 是「拿到多少就是多少」的前提；
 * provider 自带 `klineCapabilities()` 声明时按声明再收紧（见 resolveRequestLimit）。
 */
export const MAX_BARS_REQUEST = 800

/**
 * 沙箱超时：默认 100ms 只够死循环熔断，真实长度序列（数百~上千根 × 最多 8 条锚点线）
 * 的合法计算会超过它，故本工具显式放宽。实测耗时见 spikes/impl-kdas-values/EVIDENCE.md。
 */
export const DEFAULT_COMPUTE_TIMEOUT_MS = 2000

/** 日线陈旧判定（自然日）：超过即认为上游未更新（含长假余量）；出参同时回带实际间隔天数。 */
export const STALE_AFTER_DAYS = 7

/** 关键日参数键：KDAS 声明 kd1..kd8（computeSource 按 k=1..8 读取）。 */
const KEY_DAY_PARAM_RE = /^kd(\d+)$/
/** 最多 8 条关键日线（computeSource 的 `k < 8` 截尾；更多关键日在指标侧本就画不出来）。 */
const MAX_KEY_DAYS = 8
/** 关键日参数的合法区间（与 computeSource 的 20000101..20991231 同口径）。 */
const KEY_DAY_MIN = 20_000_101
const KEY_DAY_MAX = 20_991_231

const MS_PER_DAY = 86_400_000

/** 行情服务最小面（api MarketDataService 的鸭子面，避免本包对 api 的类型依赖）。 */
export interface MarketDataServiceLike {
  getKlines(symbol: string, interval: string, limit?: number): Promise<Kline[]>
  klineCapabilities?(): ReadonlyArray<{ interval: string; maxBars: number }>
}

/** 行情注册表最小面（与 packages/base/src/market-tools.ts 同形；list 可选）。 */
export interface MarketDataRegistryLike {
  active(market: string): { provider: string; service: MarketDataServiceLike } | undefined
  list?(market: string): ReadonlyArray<{ provider: string; service: MarketDataServiceLike }>
}

export interface IndicatorValuesDeps {
  /** 自定义指标库（id=`kdas` 时 computeSource 的唯一来源）。 */
  store: CustomIndicatorStore
  /** 图表激活名册（关键日现场权威值）；缺席时只用定义侧默认参数。 */
  chartStore?: ChartActivationStore | undefined
  /** 行情注册表惰性解析（缺席 = 宿主未装行情面 → TRADING_NO_PROVIDER）。 */
  getMarketRegistry?: (() => MarketDataRegistryLike | undefined) | undefined
  /** 沙箱超时覆盖（单测注入；缺省 DEFAULT_COMPUTE_TIMEOUT_MS）。 */
  computeTimeoutMs?: number | undefined
  /** 当前时刻注入缝（陈旧判定；缺省 Date.now）。 */
  now?: (() => number) | undefined
}

/** 一条线的读数。 */
interface LineReading {
  key: string
  /** 关键日（YYYYMMDD 数字）；线名不含关键日时为 null（非 KDAS 命名的指标）。 */
  key_day: number | null
  /** 锚定 K 线的交易日（YYYY-MM-DD）；线未生效时为 null。 */
  anchored_at: string | null
  value: number | null
  bars_since: number
  latest_close: number
  distance_pct: number | null
  side: string
  truncated: boolean
  ineffective: boolean
  note: string
}

interface SyntheticLine {
  key: null
  key_day: number
  anchored_at: null
  value: null
  bars_since: number
  latest_close: number
  distance_pct: null
  side: string
  truncated: boolean
  ineffective: true
  note: string
}

function parseSymbol(raw: unknown): string {
  const symbol = typeof raw === 'string' ? raw.trim() : ''
  if (symbol.length === 0) throw new Error('indicator_get_values: symbol is required (market-canonical vocabulary, e.g. 002714.SZ / 00700.HK / AAPL / BTCUSDT)')
  return symbol
}

function parseMarket(raw: unknown): MarketSlug {
  const market = typeof raw === 'string' ? raw.trim() : ''
  if (!(MARKETS as readonly string[]).includes(market)) {
    throw new Error(
      `indicator_get_values: market must be one of ${MARKETS.join(' | ')} (got ${JSON.stringify(raw ?? null)}); `
      + 'market keys are lowercase slugs shared with routing_get.',
    )
  }
  return market as MarketSlug
}

/** 交易日 = openTime 的 UTC 日（YYYYMMDD 数字）。与 KDAS 指标 computeSource 的 dayNum 同规则。 */
function utcDayNum(openTime: number): number {
  const d = new Date(openTime)
  if (!Number.isFinite(d.getTime())) return 0
  return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate()
}

/** 交易日 ISO 形态（YYYY-MM-DD）。 */
function utcDayIso(openTime: number): string {
  const d = new Date(openTime)
  if (!Number.isFinite(d.getTime())) return ''
  return d.toISOString().slice(0, 10)
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

/**
 * 线名 → 关键日。KDAS 的 computeSource 自己把关键日编进线名
 * （`KDAS_` + yy-mm-dd，如 20250821 → `KDAS_25-08-21`），故关键日读的是**算法自己
 * 声明的名字**，不在工具里重算一套锚点规则。名字不含关键日的指标返回 null。
 */
export function keyDayOfLineKey(key: string): number | null {
  const m = /^KDAS_(\d{2})-(\d{2})-(\d{2})$/.exec(key)
  if (m === null) return null
  return Number(`20${m[1]}${m[2]}${m[3]}`)
}

/**
 * 请求侧关键日：从参数里取 kd1..kd8（computeSource 同一组键），有序、去重、最多 8 条。
 * 越界值（computeSource 会丢弃）单列 `invalid`，让「配置写错」可见而不是静默消失。
 */
export function requestedKeyDays(params: Readonly<Record<string, number>>): { keys: number[]; invalid: number[] } {
  const ordered: Array<{ n: number; value: number }> = []
  for (const [key, value] of Object.entries(params)) {
    const m = KEY_DAY_PARAM_RE.exec(key)
    if (m === null || typeof value !== 'number' || !Number.isFinite(value)) continue
    const rounded = Math.round(value)
    if (rounded === 0) continue
    ordered.push({ n: Number(m[1]), value: rounded })
  }
  ordered.sort((a, b) => a.n - b.n)
  const keys: number[] = []
  const invalid: number[] = []
  for (const item of ordered) {
    if (item.value < KEY_DAY_MIN || item.value > KEY_DAY_MAX) {
      invalid.push(item.value)
      continue
    }
    if (keys.length >= MAX_KEY_DAYS || keys.includes(item.value)) continue
    keys.push(item.value)
  }
  return { keys, invalid }
}

/** `keys` 覆盖参数解析（逗号/空白分隔的 YYYYMMDD；`0` 视为未指定）。 */
function parseKeysOverride(raw: unknown): number[] {
  if (raw === undefined || raw === null) return []
  const text = typeof raw === 'string' ? raw : String(raw)
  const keys: number[] = []
  for (const token of text.split(/[\s,]+/)) {
    if (token.length === 0 || token === '0') continue
    if (!/^\d{8}$/.test(token)) {
      throw new Error(`indicator_get_values: keys must be comma-separated YYYYMMDD values (got ${JSON.stringify(token)})`)
    }
    const value = Number(token)
    if (value < KEY_DAY_MIN || value > KEY_DAY_MAX) {
      throw new Error(`indicator_get_values: key day ${token} is out of range ${KEY_DAY_MIN}..${KEY_DAY_MAX}`)
    }
    if (!keys.includes(value)) keys.push(value)
  }
  if (keys.length > MAX_KEY_DAYS) {
    throw new Error(`indicator_get_values: at most ${MAX_KEY_DAYS} key days are supported (got ${keys.length}) — the indicator draws at most ${MAX_KEY_DAYS} lines`)
  }
  return keys
}

/** 解析指标定义的可执行面：自定义库优先（源码），其次预置（函数体源码化）。 */
interface ResolvedIndicator {
  title: string
  params: readonly IndicatorParamSpec[]
  /** 自定义指标的源码（走 vm 沙箱）。 */
  computeSource?: string
  /** 预置指标的 compute 函数（本仓自己的代码，不经沙箱）。 */
  compute?: (bars: readonly Kline[], params: Readonly<Record<string, number>>) => IndicatorOutput[]
  /** 需要外部序列（aux/barAux）的指标在读数面拿不到序列 → 如实说明。 */
  needsExternalSeries: boolean
}

function resolveIndicator(id: string, store?: CustomIndicatorStore): Promise<ResolvedIndicator | undefined> | ResolvedIndicator | undefined {
  const preset = presetDefinitions().find(d => d.id === id)
  if (preset !== undefined) {
    return {
      title: preset.title,
      params: preset.params,
      // 预置指标由本仓自己提供（definition.compute），不经沙箱；沙箱那条路径是用户源码专用的。
      compute: preset.compute,
      needsExternalSeries: preset.aux !== undefined || preset.barAux !== undefined,
    }
  }
  if (store === undefined) return undefined
  return store.get(id).then(record => record === undefined
    ? undefined
    : {
        title: record.title,
        params: record.params,
        computeSource: record.computeSource,
        needsExternalSeries: false,
      })
}

/**
 * 候选序（与桥 `#klineCandidates` 同口径）：active 在最前，其后 registry.list 的其余
 * 条目按 provider 名升序。active 缺席 → 空候选（用户设置是权威，不为它换源）。
 */
export function klineCandidates(registry: MarketDataRegistryLike, market: string): Array<{ provider: string; service: MarketDataServiceLike }> {
  const active = registry.active(market)
  if (active === undefined) return []
  const candidates = [{ provider: active.provider, service: active.service }]
  const rest = [...(registry.list?.(market) ?? [])]
    .filter(entry => entry.service !== active.service)
    .sort((a, b) => (a.provider < b.provider ? -1 : a.provider > b.provider ? 1 : 0))
  for (const entry of rest) candidates.push({ provider: entry.provider, service: entry.service })
  return candidates
}

/** 声明侧覆盖判定（桥 `#resolveKlinesSources` 的 covers：声明该周期且深度够）。 */
function covers(service: MarketDataServiceLike, interval: string, limit: number): boolean {
  const caps = service.klineCapabilities?.() ?? []
  return caps.some(cap => cap.interval === interval && cap.maxBars >= limit)
}

/** 候选序重排（与桥一致：active 有能力就用 active；否则第一个声明覆盖的候选提到最前）。 */
function resolveKlinesSources(candidates: Array<{ provider: string; service: MarketDataServiceLike }>, interval: string, limit: number): Array<{ provider: string; service: MarketDataServiceLike }> {
  if (candidates.length <= 1) return candidates
  const active = candidates[0]
  if (active !== undefined && covers(active.service, interval, limit)) return candidates
  const chosen = candidates.find((candidate, index) => index > 0 && covers(candidate.service, interval, limit))
  if (chosen === undefined) return candidates
  return [chosen, ...candidates.filter(candidate => candidate !== chosen)]
}

/** 请求根数：不超过 MAX_BARS_REQUEST，且不越过 provider 声明的该周期深度。 */
function resolveRequestLimit(candidates: Array<{ service: MarketDataServiceLike }>, interval: string): number {
  let limit = MAX_BARS_REQUEST
  for (const candidate of candidates) {
    for (const cap of candidate.service.klineCapabilities?.() ?? []) {
      if (cap.interval === interval && cap.maxBars > 0) limit = Math.min(limit, cap.maxBars)
    }
  }
  return limit
}

function errorCodeOf(error: unknown): string {
  const raw = (error as { code?: unknown } | null | undefined)?.code
  return typeof raw === 'string' ? raw : 'TRADING_UNKNOWN'
}

/** 交易日判定的读入面：K 线数组（只认 openTime/ohlc/volume）。 */
function sanitizeBars(raw: unknown): Kline[] {
  if (!Array.isArray(raw)) return []
  const bars: Kline[] = []
  for (const item of raw) {
    const bar = item as Partial<Kline> | null
    if (bar === null || typeof bar !== 'object') continue
    if (typeof bar.openTime !== 'number' || !Number.isFinite(bar.openTime)) continue
    const { open, high, low, close } = bar
    if (typeof open !== 'number' || typeof high !== 'number' || typeof low !== 'number' || typeof close !== 'number') continue
    bars.push({
      openTime: bar.openTime,
      open,
      high,
      low,
      close,
      volume: typeof bar.volume === 'number' && Number.isFinite(bar.volume) ? bar.volume : 0,
    })
  }
  return bars.sort((a, b) => a.openTime - b.openTime)
}

/** 指标输出防御：只收有 key 与 values 数组的线。 */
function sanitizeOutputs(raw: unknown): IndicatorOutput[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((item): item is IndicatorOutput => {
    const line = item as Partial<IndicatorOutput> | null
    return line !== null && typeof line === 'object' && typeof line.key === 'string' && Array.isArray(line.values)
  })
}

export function createIndicatorValuesTool(deps: IndicatorValuesDeps) {
  const computeTimeoutMs = deps.computeTimeoutMs ?? DEFAULT_COMPUTE_TIMEOUT_MS
  const now = deps.now ?? (() => Date.now())

  return defineTool({
    name: 'indicator_get_values',
    description:
      'Read an activated indicator\'s numeric values for one instrument on the daily chart, using the key days (KDAS) '
      + 'or parameters currently in effect in the chart roster — the same definitions, parameters and compute source the GUI chart uses, '
      + 'so the numbers never drift from what the chart shows. '
      + 'Scope: interval is fixed to 1d (the anchored key-day reading is only defined on daily bars). '
      + 'Reads chart-scoped parameter overrides (symbolParams) for the requested market:symbol, falling back to global params; '
      + '`keys` overrides them for a one-off experiment and is flagged as such in the output. '
      + 'Market data comes from the active routed provider (cross-source fallback only when it structurally lacks the interval); '
      + 'an unconfigured provider fails loudly (TRADING_NO_PROVIDER), never as an empty result. '
      + 'Fail-closed: a line whose anchor is cut off by the fetch window, a key day later than the newest bar, or too few bars returns no value — '
      + 'only the reason. Units: price levels in quote currency; distance_pct in percent (value vs latest close).',
    parameters: {
      market: { type: 'string', enum: [...MARKETS], required: true, description: 'Market slug: crypto | us | cn | hk | futures | global' },
      symbol: { type: 'string', required: true, description: 'Market-canonical symbol, e.g. 002714.SZ / 00700.HK / AAPL / BTCUSDT' },
      interval: { type: 'string', default: VALUES_INTERVAL, description: 'Only 1d is supported (KDAS anchoring is defined on daily bars; weekly/monthly bars would anchor a whole period)' },
      id: { type: 'string', default: 'kdas', description: 'Indicator id: a custom indicator in the library (default kdas) or a preset id (e.g. ma)' },
      keys: { type: 'string', description: 'Optional YYYYMMDD key days, comma-separated — a one-off override of the chart-scoped key days (flagged keys_source=override in the output)' },
    },
    output: {
      schema: { type: 'string' as const },
      render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
    },
    async execute(raw) {
      const args = (raw ?? {}) as Record<string, unknown>
      const market = parseMarket(args.market)
      const symbol = parseSymbol(args.symbol)
      const interval = typeof args.interval === 'string' && args.interval.trim().length > 0 ? args.interval.trim() : VALUES_INTERVAL
      if (interval !== VALUES_INTERVAL) {
        throw new Error(
          `indicator_get_values: interval ${JSON.stringify(interval)} is not supported — the key-day anchored reading is defined on daily bars only `
          + '(the indicator decides the trading day from the bar openTime\'s UTC date, so a weekly/monthly bar would anchor a whole period, '
          + 'and an intraday bar would anchor the wrong day). Re-run with interval=1d.',
        )
      }
      const id = typeof args.id === 'string' && args.id.trim().length > 0 ? args.id.trim() : 'kdas'
      const overrideKeys = parseKeysOverride(args.keys)

      const resolved = await resolveIndicator(id, deps.store)
      if (resolved === undefined) {
        throw new Error(`indicator_get_values: unknown indicator id ${JSON.stringify(id)} — not in the chart roster library (custom indicators) nor in the preset set; call indicator_list for the ids that exist.`)
      }

      // 关键日现场权威值：symbolParams 命中 `${market}:${symbol}` 即整体替代全局 params。
      const instances = deps.chartStore === undefined ? [] : await deps.chartStore.list()
      const instance = instances.find(item => item.id === id)
      const scopedHit = instance !== undefined
        && instance.symbolParams !== undefined
        && instance.symbolParams[`${market}:${symbol}`] !== undefined
      const chartParams: Record<string, number> = instance === undefined
        ? Object.fromEntries(resolved.params.map(spec => [spec.key, spec.default]))
        : { ...effectiveInstanceParams(instance, market, symbol) }

      // keys 覆盖 = 一次性实验参数（keys_source=override 在出参里明示，绝不伪装成权威值）。
      const params: Record<string, number> = overrideKeys.length > 0
        ? Object.fromEntries([...resolved.params.map(spec => [spec.key, 0]), ...overrideKeys.map((value, index) => [`kd${index + 1}`, value])])
        : chartParams
      const keysSource: 'symbolParams' | 'override' = overrideKeys.length > 0 ? 'override' : 'symbolParams'
      const { keys: requested, invalid: invalidKeyParams } = requestedKeyDays(params)
      const paramsScope = keysSource === 'override'
        ? 'override'
        : scopedHit
          ? `${market}:${symbol}`
          : instance !== undefined ? 'global' : 'definition-default'

      const payload: Record<string, unknown> = {
        market, symbol, interval, id, title: resolved.title,
        keys_source: keysSource,
        keys: requested,
        params,
        params_scope: paramsScope,
        ...(invalidKeyParams.length > 0 ? { invalid_key_days: invalidKeyParams } : {}),
      }

      // 行情面：候选序与桥一致；无激活 provider 直接报错，不返回空数。
      const registry = deps.getMarketRegistry?.()
      const candidates = registry === undefined ? [] : klineCandidates(registry, market)
      if (candidates.length === 0) {
        throw new Error(
          `TRADING_NO_PROVIDER: no active market-data provider for market "${market}" — market keys are lowercase slugs `
          + '(crypto | us | cn | hk | futures | global); if the key is right, check routing_get and installed connectors.',
        )
      }
      const requestLimit = resolveRequestLimit(candidates, interval)
      const ordered = resolveKlinesSources(candidates, interval, requestLimit)
      let served: { provider: string; service: MarketDataServiceLike } | undefined
      let bars: Kline[] = []
      let lastError: unknown
      for (const candidate of ordered) {
        try {
          bars = sanitizeBars(await candidate.service.getKlines(symbol, interval, requestLimit))
          served = candidate
          break
        } catch (error) {
          // 只有「结构性不支持该周期」才换源（与桥 /klines 同规则）；其它错误原样抛。
          if (errorCodeOf(error) !== 'TRADING_UNSUPPORTED_INTERVAL') throw error
          lastError = error
        }
      }
      if (served === undefined) throw lastError ?? new Error(`indicator_get_values: no candidate provider could serve ${market}:${symbol} ${interval}`)

      const fromActive = served.provider === candidates[0]?.provider
      const fetchedAt = new Date(now()).toISOString()
      const firstBarDay = bars.length > 0 ? utcDayNum(bars[0]!.openTime) : 0
      const lastBar = bars.length > 0 ? bars[bars.length - 1]! : undefined
      const lastClose = lastBar?.close ?? null
      payload.provider = served.provider
      payload.parity = fromActive ? 'same-source' : 'cross-source-fallback'
      payload.parity_note = fromActive
        ? 'Same registry resolution as the GUI chart route: the bridge /klines candidate order also puts this market\'s active provider first, so both read the same provider.'
        : `The active provider was structurally unable to serve ${interval} (TRADING_UNSUPPORTED_INTERVAL), so this reading came from the fallback candidate "${served.provider}" — the same fallback order the bridge /klines uses. Chart and reading can legitimately differ here.`
      payload.bars = bars.length
      payload.bars_requested = requestLimit
      payload.window_first_bar = bars.length > 0 ? utcDayIso(bars[0]!.openTime) : null
      payload.window_last_bar = lastBar === undefined ? null : utcDayIso(lastBar.openTime)
      payload.as_of = payload.window_last_bar
      payload.fetched_at = fetchedAt
      const barAgeDays = lastBar === undefined ? null : Math.floor((now() - lastBar.openTime) / MS_PER_DAY)
      payload.bar_age_days = barAgeDays
      payload.stale = barAgeDays !== null && barAgeDays > STALE_AFTER_DAYS
      payload.stale_note = barAgeDays === null
        ? 'No bar was returned, so freshness is unknown.'
        : `Newest daily bar is ${barAgeDays} day(s) old (stale above ${STALE_AFTER_DAYS}); a market holiday can legitimately exceed this.`

      // 关键日驱动的指标（声明了 kd<N> 参数，如 kdas）：没有任何可用关键日 = 不可判。
      // 非关键日指标（如 ma）没有 kd 参数，照常计算，只按「出不出线」判空。
      const keyDayDriven = resolved.params.some(spec => KEY_DAY_PARAM_RE.test(spec.key))
      if (bars.length === 0 || (keyDayDriven && requested.length === 0)) {
        payload.latest_close = lastClose
        payload.lines = []
        payload.nearest_support = null
        payload.nearest_resistance = null
        payload.blocked_reason = bars.length === 0
          ? `No daily bars were returned by provider "${served.provider}" for ${market}:${symbol} — nothing to read.`
          : `No key days are configured for ${market}:${symbol} (params scope "${String(payload.params_scope)}" carries no usable kd value), so this reading is not adjudicable. Set the key days on the chart roster for this symbol, or pass keys=YYYYMMDD explicitly.`
        return JSON.stringify(payload)
      }

      const outputs = sanitizeOutputs(resolved.computeSource !== undefined
        ? runSourceInVmSandbox(resolved.computeSource, bars, params, computeTimeoutMs, '指标读数')
        : resolved.compute?.(bars, params))
      if (outputs.length === 0) {
        payload.latest_close = lastClose
        payload.lines = []
        payload.nearest_support = null
        payload.nearest_resistance = null
        payload.blocked_reason = resolved.needsExternalSeries
          ? `Indicator "${id}" renders from an external series (aux/barAux) that this reading tool does not fetch, so it produced no line here — use the chart for it.`
          : `Indicator "${id}" produced no line for the configured key days (nothing anchored inside the fetched window).`
        return JSON.stringify(payload)
      }

      const lines: Array<LineReading | SyntheticLine> = []
      const seenKeyDays = new Set<number>()
      for (const output of outputs) {
        const values = output.values as ReadonlyArray<number | undefined>
        let anchorIndex = -1
        let lastValue: number | undefined
        for (let i = 0; i < bars.length; i++) {
          const value = values[i]
          if (typeof value !== 'number' || !Number.isFinite(value)) continue
          if (anchorIndex < 0) anchorIndex = i
          lastValue = value
        }
        const keyDay = keyDayOfLineKey(output.key)
        if (keyDay !== null) seenKeyDays.add(keyDay)
        const truncated = keyDay !== null && anchorIndex === 0 && firstBarDay > keyDay
        const effective = anchorIndex >= 0 && !truncated && lastValue !== undefined
        const value = effective ? round(lastValue!, 3) : null
        lines.push({
          key: output.key,
          key_day: keyDay,
          anchored_at: anchorIndex >= 0 ? utcDayIso(bars[anchorIndex]!.openTime) : null,
          value,
          bars_since: anchorIndex >= 0 ? bars.length - anchorIndex : 0,
          latest_close: lastClose ?? 0,
          distance_pct: value === null || lastClose === null ? null : round((lastClose - value) / value * 100, 2),
          side: value === null ? (truncated ? '锚点截断' : '未生效') : lastClose !== null && lastClose >= value ? '价格在上' : '价格在下',
          truncated,
          ineffective: value === null,
          note: truncated
            ? `锚点被截断：窗口首根 ${String(payload.window_first_bar)} 已晚于关键日 ${keyDay}，真锚点不在数据内 → 不给数（加大窗口或补更早的日 K）`
            : value === null
              ? '该线在窗口内没有任何有效读数'
              : '',
        })
      }

      // 请求了但指标没出线的关键日：补记录（未生效 / 锚点与更早关键日重合被去重），不静默消失。
      for (const keyDay of requested) {
        if (seenKeyDays.has(keyDay)) continue
        const beyondWindow = lastBar !== undefined && keyDay > utcDayNum(lastBar.openTime)
        lines.push({
          key: null,
          key_day: keyDay,
          anchored_at: null,
          value: null,
          bars_since: 0,
          latest_close: lastClose ?? 0,
          distance_pct: null,
          side: beyondWindow ? '未生效' : '无对应线',
          truncated: false,
          ineffective: true,
          note: beyondWindow
            ? `未生效：关键日 ${keyDay} 晚于最新 K 线（${String(payload.window_last_bar)}）→ 指标不输出该线，不给数`
            : `指标未输出关键日 ${keyDay} 的线：锚点与更早关键日重合时指标按锚点去重只保留一条线（同名线不存在），核对名册里的关键日是否重复。`,
        })
      }
      lines.sort((a, b) => (a.key_day ?? 0) - (b.key_day ?? 0))

      const effectiveLines = lines.filter((line): line is LineReading => line.value !== null && line.key !== null)
      const close = lastClose ?? 0
      const supports = effectiveLines.filter(line => line.value !== null && line.value <= close).sort((a, b) => (b.value ?? 0) - (a.value ?? 0))
      const resistances = effectiveLines.filter(line => line.value !== null && line.value > close).sort((a, b) => (a.value ?? 0) - (b.value ?? 0))
      const brief = (line: LineReading | undefined): Record<string, unknown> | null => line === undefined
        ? null
        : { key: line.key, key_day: line.key_day, value: line.value, distance_pct: line.distance_pct }

      payload.latest_close = lastClose
      payload.lines = lines
      payload.nearest_support = brief(supports[0])
      payload.nearest_resistance = brief(resistances[0])
      payload.notes = [
        resolved.computeSource !== undefined
          ? 'Values come from the indicator\'s own computeSource executed in the Node vm sandbox (same source the chart renders).'
          : 'Values come from the preset definition\'s compute function (same code the chart renders).',
        keysSource === 'override'
          ? 'keys was passed explicitly: the key days below are a one-off override, NOT the chart roster\'s authoritative symbolParams values.'
          : 'Key days were read live from the chart roster (symbolParams for this market:symbol, else the global params).',
      ]
      return JSON.stringify(payload)
    },
  })
}
