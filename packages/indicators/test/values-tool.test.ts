/**
 * indicator_get_values 工厂单测（零 mock：行情服务用注入缝的普通对象替身，指标库/名册用内存 store）。
 *
 * 判据全部来自合成日 K 的手算值：TP = (high+low+close)/3 恒等于 100+i，
 * 故「自锚点 i 起的 AVWAP」= i..9 的 TP 算术平均（volume 恒为 1）：
 *   kd=20250108 → 锚点 i=2 → (102+…+109)/8 = 105.5
 *   kd=20250112 → 锚点 i=6 → (106+…+109)/4 = 107.5
 *   kd=20250104（早于窗口首根）→ 锚点被截断 → 不给数
 *   kd=20250120（晚于最新一根）→ 未生效 → 不给数
 */
import { describe, expect, it } from 'vitest'
import type { Kline } from '../src/types.ts'
import { createMemoryCustomIndicatorStore, type CustomIndicatorStore } from '../src/custom.ts'
import { createMemoryChartActivationStore } from '../src/chart-activations.ts'
import {
  createIndicatorValuesTool,
  keyDayOfLineKey,
  requestedKeyDays,
  type MarketDataRegistryLike,
  type MarketDataServiceLike,
} from '../src/values-tool.ts'

const DAY_MS = 86_400_000
/** 窗口首根 = 2025-01-06，最后一根 = 2025-01-15（10 根日 K，逐日连续）。 */
const START = Date.UTC(2025, 0, 6)

function syntheticBars(count = 10): Kline[] {
  return Array.from({ length: count }, (_, i) => ({
    openTime: START + i * DAY_MS,
    open: 100 + i,
    high: 101 + i,
    low: 99 + i,
    close: 100 + i,
    volume: 1,
  }))
}

/** 用户自编 KDAS 形态指标（源码面，走 vm 沙箱；命名与线上 kdas 同约定）。 */
const KDAS_SOURCE = `(bars, params) => {
  const len = bars.length;
  const keys = [];
  for (let k = 1; k <= 8; k++) {
    const raw = Math.round(Number(params['kd' + k] || 0));
    if (raw < 20000101 || raw > 20991231 || keys.indexOf(raw) >= 0) continue;
    keys.push(raw);
  }
  const outputs = [];
  for (const kd of keys) {
    let idx = -1;
    for (let i = 0; i < len; i++) {
      const d = new Date(bars[i].openTime);
      const dayNum = d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
      if (dayNum >= kd) { idx = i; break; }
    }
    if (idx < 0) continue;
    const values = new Array(len).fill(undefined);
    let accA = 0, accV = 0;
    for (let i = idx; i < len; i++) {
      const v = bars[i].volume > 0 ? bars[i].volume : 0;
      accA += ((bars[i].high + bars[i].low + bars[i].close) / 3) * v;
      accV += v;
      if (accV > 0) values[i] = accA / accV;
    }
    const s = String(kd);
    outputs.push({ key: 'KDAS_' + s.slice(2, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8), kind: 'line', color: '#FFD700', values, precision: 3 });
  }
  return outputs;
}`

const KD = { kd1: 20250108, kd2: 20250112, kd3: 20250120, kd4: 20250104 }

function storeWith(record: { computeSource: string; params?: unknown }): CustomIndicatorStore {
  return createMemoryCustomIndicatorStore([{
    id: 'kdas',
    title: 'KDAS',
    pane: 'main',
    params: [
      { key: 'kd1', label: '关键日1', default: 0, min: 0, max: 20991231 },
      { key: 'kd2', label: '关键日2', default: 0, min: 0, max: 20991231 },
      { key: 'kd3', label: '关键日3', default: 0, min: 0, max: 20991231 },
      { key: 'kd4', label: '关键日4', default: 0, min: 0, max: 20991231 },
    ],
    computeSource: record.computeSource,
    createdAt: 1,
  }])
}

/** 注入缝的行情服务替身（普通对象，记录调用；可选地按错误码失败）。 */
function marketService(options: {
  bars?: Kline[]
  failCode?: string
  calls?: string[]
  capabilities?: ReadonlyArray<{ interval: string; maxBars: number }>
} = {}): MarketDataServiceLike {
  return {
    async getKlines(symbol, interval, limit) {
      options.calls?.push(`${symbol}:${interval}:${String(limit)}`)
      if (options.failCode !== undefined) {
        throw Object.assign(new Error(`injected failure for ${symbol}`), { code: options.failCode })
      }
      return options.bars ?? syntheticBars()
    },
    ...(options.capabilities !== undefined ? { klineCapabilities: () => options.capabilities! } : {}),
  }
}

function registryOf(active: { provider: string; service: MarketDataServiceLike }, rest: Array<{ provider: string; service: MarketDataServiceLike }> = []): MarketDataRegistryLike {
  return { active: () => active, list: () => [active, ...rest] }
}

/** 默认装配：cn 名册带 symbolParams、行情替身可用、注入 now（陈旧判定可控）。 */
function makeTool(overrides: {
  chartStore?: ReturnType<typeof createMemoryChartActivationStore>
  registry?: MarketDataRegistryLike | undefined
  bars?: Kline[]
  store?: CustomIndicatorStore
  now?: number
} = {}) {
  const chartStore = overrides.chartStore ?? createMemoryChartActivationStore([{ id: 'kdas', params: { kd1: 0, kd2: 0, kd3: 0, kd4: 0 }, symbolParams: { 'cn:002714.SZ': KD } }])
  const registry = 'registry' in overrides
    ? overrides.registry
    : registryOf({ provider: 'tencent', service: marketService({ bars: overrides.bars }) })
  const tool = createIndicatorValuesTool({
    store: overrides.store ?? storeWith({ computeSource: KDAS_SOURCE }),
    chartStore,
    getMarketRegistry: () => registry,
    now: () => overrides.now ?? Date.UTC(2025, 0, 16),
  })
  return { tool, chartStore }
}

async function read(tool: ReturnType<typeof createIndicatorValuesTool>, args: Record<string, unknown>): Promise<Record<string, any>> {
  return JSON.parse(String(await tool.execute(args))) as Record<string, any>
}

describe('indicator_get_values', () => {
  it('用户读 cn 日线的 kdas：关键日取自名册 symbolParams，每条线算出手算 AVWAP 并标注锚定日', async () => {
    // Given 名册里 cn:002714.SZ 的 kd1=20250108 / kd2=20250112，窗口为 10 根合成日 K
    const { tool } = makeTool()
    // When 以日线读取该标的
    const payload = await read(tool, { market: 'cn', symbol: '002714.SZ' })
    // Then 关键日来自现场 symbolParams，两条线的手算值与锚定日一一对上
    expect(payload.keys_source).toBe('symbolParams')
    expect(payload.params_scope).toBe('cn:002714.SZ')
    expect(payload.keys).toEqual([20250108, 20250112, 20250120, 20250104])
    const kd1 = payload.lines.find((line: any) => line.key_day === 20250108)
    const kd2 = payload.lines.find((line: any) => line.key_day === 20250112)
    expect(kd1.value).toBe(105.5)
    expect(kd1.anchored_at).toBe('2025-01-08')
    expect(kd1.bars_since).toBe(8)
    expect(kd2.value).toBe(107.5)
    expect(kd2.anchored_at).toBe('2025-01-12')
    expect(payload.latest_close).toBe(109)
    expect(kd1.distance_pct).toBe(3.32)
    expect(kd1.side).toBe('价格在上')
    expect(payload.window_first_bar).toBe('2025-01-06')
    expect(payload.window_last_bar).toBe('2025-01-15')
    expect(payload.as_of).toBe('2025-01-15')
    expect(payload.bars).toBe(10)
    expect(payload.provider).toBe('tencent')
    expect(payload.parity).toBe('same-source')
  })

  it('用户按最近上下方线判支撑压力：比收盘低的线取最大值作支撑，比收盘高的取最小值作压力', async () => {
    // Given 同一组关键日（105.5 与 107.5 都在收盘 109 之下）
    const { tool } = makeTool()
    // When 读取
    const payload = await read(tool, { market: 'cn', symbol: '002714.SZ' })
    // Then 最近支撑 = 107.5（kd2），无上方线故压力为 null
    expect(payload.nearest_support.key_day).toBe(20250112)
    expect(payload.nearest_support.value).toBe(107.5)
    expect(payload.nearest_resistance).toBeNull()
  })

  it('用户遇到锚点被窗口截断：早于窗口首根的关键日不给数，只报截断原因', async () => {
    // Given 名册里 kd4=20250104 早于窗口首根 2025-01-06
    const { tool } = makeTool()
    // When 读取
    const payload = await read(tool, { market: 'cn', symbol: '002714.SZ' })
    // Then 该线 truncated=true、value 为 null、ineffective=true，且原因写明窗口首根
    const line = payload.lines.find((item: any) => item.key_day === 20250104)
    expect(line.truncated).toBe(true)
    expect(line.value).toBeNull()
    expect(line.ineffective).toBe(true)
    expect(line.note).toContain('2025-01-06')
    expect(line.note).toContain('锚点被截断')
  })

  it('用户遇到关键日未生效：晚于最新一根的关键日不给数，并补一条未生效记录', async () => {
    // Given 名册里 kd3=20250120 晚于最新一根 2025-01-15
    const { tool } = makeTool()
    // When 读取
    const payload = await read(tool, { market: 'cn', symbol: '002714.SZ' })
    // Then 该关键日以 ineffective 记录出现，无 value、无锚定日
    const line = payload.lines.find((item: any) => item.key_day === 20250120)
    expect(line.ineffective).toBe(true)
    expect(line.value).toBeNull()
    expect(line.anchored_at).toBeNull()
    expect(line.side).toBe('未生效')
    expect(line.note).toContain('晚于最新 K 线')
  })

  it('用户遇到没有关键日的标的：全局 params 全 0 → 不给数并说明缺什么', async () => {
    // Given 名册里没有该标的的 symbolParams（全局 params 全 0）
    const { tool } = makeTool()
    // When 读取一个名册里没有覆盖的标的
    const payload = await read(tool, { market: 'cn', symbol: '999999.SZ' })
    // Then 无关键日 → lines 为空、params_scope=global、blocked_reason 说明不可判
    expect(payload.params_scope).toBe('global')
    expect(payload.keys).toEqual([])
    expect(payload.lines).toEqual([])
    expect(payload.blocked_reason).toContain('No key days are configured')
    expect(payload.nearest_support).toBeNull()
  })

  it('用户传 keys 覆盖关键日：出参标注 keys_source=override，不伪装成名册权威值', async () => {
    // Given 名册里的关键日是 20250108/20250112，调用方另传 keys=20250110
    const { tool } = makeTool()
    // When 带 keys 读取
    const payload = await read(tool, { market: 'cn', symbol: '002714.SZ', keys: '20250110' })
    // Then 只有被覆盖的关键日出线（锚点 i=4 → (104+…+109)/6 = 106.5），并如实标注 override
    expect(payload.keys_source).toBe('override')
    expect(payload.params_scope).toBe('override')
    expect(payload.keys).toEqual([20250110])
    expect(payload.lines).toHaveLength(1)
    expect(payload.lines[0].value).toBe(106.5)
    expect(payload.lines[0].anchored_at).toBe('2025-01-10')
  })

  it('用户传了非法 keys 值：显式报错并给出期望格式，不静默忽略', async () => {
    // Given keys 里混入了非 YYYYMMDD 的记号
    const { tool } = makeTool()
    // When 读取
    // Then 抛错说明格式（不返回一份看似正常的读数）
    await expect(tool.execute({ market: 'cn', symbol: '002714.SZ', keys: '2025-01-10' })).rejects.toThrow(/YYYYMMDD/)
  })

  it('用户在非日线级别请求读数：显式拒绝并说明周线锚定口径不成立', async () => {
    // Given 名册的 applyScope 里 hk/cn 都含 1w，但读数口径只对日线成立
    const { tool } = makeTool()
    // When 以 1w 读取
    // Then 拒绝并给出原因（不拿周 K 凑日线）
    await expect(tool.execute({ market: 'cn', symbol: '002714.SZ', interval: '1w' })).rejects.toThrow(/daily bars only/)
  })

  it('用户在无激活行情 provider 时请求读数：报 TRADING_NO_PROVIDER，不返回空读数', async () => {
    // Given 行情注册表缺席（或该市场无 active）
    const { tool } = makeTool({ registry: undefined })
    // When 读取
    // Then 抛 TRADING_NO_PROVIDER（未装数据面 ≠ 没有读数）
    await expect(tool.execute({ market: 'cn', symbol: '002714.SZ' })).rejects.toThrow(/TRADING_NO_PROVIDER/)
  })

  it('用户在 active 结构性不支持该周期时换源：沿用桥的候选序并标注 cross-source-fallback', async () => {
    // Given active 抛 TRADING_UNSUPPORTED_INTERVAL，次候选可用
    const calls: string[] = []
    const tool = createIndicatorValuesTool({
      store: storeWith({ computeSource: KDAS_SOURCE }),
      chartStore: createMemoryChartActivationStore([{ id: 'kdas', params: { kd1: 20250108 } }]),
      getMarketRegistry: () => registryOf(
        { provider: 'aaa', service: marketService({ failCode: 'TRADING_UNSUPPORTED_INTERVAL', calls }) },
        [{ provider: 'zzz', service: marketService({ bars: syntheticBars(), calls }) }],
      ),
      now: () => Date.UTC(2025, 0, 16),
    })
    // When 读取
    const payload = await read(tool, { market: 'cn', symbol: '002714.SZ' })
    // Then 供数 provider 是兜底候选，parity 如实标注跨源
    expect(payload.provider).toBe('zzz')
    expect(payload.parity).toBe('cross-source-fallback')
    expect(payload.parity_note).toContain('TRADING_UNSUPPORTED_INTERVAL')
    expect(calls).toHaveLength(2)
  })

  it('用户在 active 因非结构性错误失败时：原样抛错，绝不换源', async () => {
    // Given active 抛网络/上游类错误（TRADING_EXCHANGE_ERROR）
    const calls: string[] = []
    const tool = createIndicatorValuesTool({
      store: storeWith({ computeSource: KDAS_SOURCE }),
      chartStore: createMemoryChartActivationStore([{ id: 'kdas', params: { kd1: 20250108 } }]),
      getMarketRegistry: () => registryOf(
        { provider: 'aaa', service: marketService({ failCode: 'TRADING_EXCHANGE_ERROR', calls }) },
        [{ provider: 'zzz', service: marketService({ bars: syntheticBars(), calls }) }],
      ),
    })
    // When 读取
    // Then 错误原样抛出，且只试过 active 一个候选（不把「现在答不出」掩盖成「另一个源的数据」）
    await expect(tool.execute({ market: 'cn', symbol: '002714.SZ' })).rejects.toThrow(/injected failure/)
    expect(calls).toEqual(['002714.SZ:1d:800'])
  })

  it('用户读到窗口与数据新鲜度信息：bars/bars_requested/窗口首末日期/stale 一并回带', async () => {
    // Given 行情替身声明该周期只能承接 300 根，且注入的 now 距最后一根 17 天
    const tool = createIndicatorValuesTool({
      store: storeWith({ computeSource: KDAS_SOURCE }),
      chartStore: createMemoryChartActivationStore([{ id: 'kdas', params: { kd1: 20250108 } }]),
      getMarketRegistry: () => registryOf({
        provider: 'tencent',
        service: marketService({ bars: syntheticBars(), capabilities: [{ interval: '1d', maxBars: 300 }] }),
      }),
      now: () => Date.UTC(2025, 1, 1),
    })
    // When 读取
    const payload = await read(tool, { market: 'cn', symbol: '002714.SZ' })
    // Then 请求根数被 provider 声明收紧，实际根数与陈旧判定如实回带
    expect(payload.bars_requested).toBe(300)
    expect(payload.bars).toBe(10)
    expect(payload.window_first_bar).toBe('2025-01-06')
    expect(payload.window_last_bar).toBe('2025-01-15')
    expect(payload.bar_age_days).toBe(17)
    expect(payload.stale).toBe(true)
  })

  it('用户读预置指标也一样：走定义侧 compute 与默认参数，不因非自定义而失能', async () => {
    // Given 名册只挂了 kdas，请求预置 id=ma（定义侧默认 5/10/…）
    const { tool } = makeTool()
    // When 读取 ma
    const payload = await read(tool, { market: 'cn', symbol: '002714.SZ', id: 'ma' })
    // Then 出线且参数取定义默认（MA5 覆盖窗口后 6 根：i=5..9 → 105..109 → 107）
    expect(payload.id).toBe('ma')
    expect(payload.params.n1).toBe(5)
    expect(payload.params_scope).toBe('definition-default')
    const ma5 = payload.lines.find((line: any) => line.key === 'MA5')
    expect(ma5).toBeDefined()
    expect(ma5.value).toBe(107)
  })

  it('用户遇到未知指标 id：显式报错并指向 indicator_list，不返回空读数', async () => {
    // Given 请求一个既不在自定义库也不在预置集的 id
    const { tool } = makeTool()
    // When 读取
    // Then 抛错说明去 indicator_list 查可用 id
    await expect(tool.execute({ market: 'cn', symbol: '002714.SZ', id: 'nope' })).rejects.toThrow(/unknown indicator id/)
  })

  it('用户核对线的关键日解析与参数读取：线名里的关键日与 kd1..kd8 的读取口径各自单测', () => {
    // Given 一条 KDAS 命名线与一组含 0/越界/重复的关键日参数
    // When 解析线名与参数
    const keyDay = keyDayOfLineKey('KDAS_25-08-21')
    const parsed = requestedKeyDays({ kd1: 20250821, kd2: 0, kd3: 19990101, kd4: 20250821, kd5: 20260905 })
    // Then 线与参数两侧都按同一口径给出关键日，越界值单列而不是静默吞掉
    expect(keyDay).toBe(20250821)
    expect(keyDayOfLineKey('MA5')).toBeNull()
    expect(parsed.keys).toEqual([20250821, 20260905])
    expect(parsed.invalid).toEqual([19990101])
  })
})
