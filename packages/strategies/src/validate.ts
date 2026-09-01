/**
 * 自定义策略安全校验器（issue #31 / P2）。浏览器端与宿主两侧共用（纯库，零 Node 依赖）：
 *
 * 1. 结构校验：id / title / horizon / summary / paramsJson / computeSource
 * 2. 源码体积与编译检查（16KB 上限，语法必须可编译）
 * 3. 多场景样例试算（复用 indicators 的特征 K 线：上涨/下跌/平盘/缺口/极短）
 * 4. **信号序列专用校验**（不复用指标的等长断言——信号序列语义不同）：
 *    - index 为整数、落在 [0, bars.length) 且严格单调递增；
 *    - time 与 bars[index].openTime 逐位一致；
 *    - action ∈ {entry, exit}、direction ∈ {long, flat} 且与 action 配对
 *      （entry→long、exit→flat）；
 *    - price 为有限数且等于 bars[index].close（i 收盘确认价，浮点容差）；
 *    - 序列可复算：从 flat 起步、entry/exit 严格交替（exit 时必须持仓、entry
 *      时必须空仓）——与回测引擎的成交语义一致（i 收盘确认、i+1 开盘成交）。
 * 5. 可插拔 runner：浏览器默认 Worker 超时熔断（indicators 的 workerComputeRunner），
 *    Node 侧传 vm 熔断 runner（validate-node.ts）。
 */
import {
  createSampleBars,
  workerComputeRunner,
  type AsyncComputeRunner,
  type Kline,
} from '@dsh-trading/indicators'
import type {
  StrategyHorizon,
  StrategyParamSpec,
  StrategySignal,
} from './types.ts'
import type { CustomStrategyRecord } from './custom.ts'

const ID_PATTERN = /^[a-z0-9_][a-z0-9_-]{1,31}$/
const PARAM_KEY_PATTERN = /^[a-zA-Z0-9_]{1,16}$/
const MAX_SOURCE_LENGTH = 16 * 1024 // 16KB
const MAX_PARAMS_COUNT = 8
const MAX_SUMMARY_LENGTH = 120
const MAX_REASON_LENGTH = 200
/** 6 大范式 id 是系统保留名（custom_* 前缀或自定义名避免冲突）。 */
const RESERVED_IDS = new Set([
  'donchian-breakout', 'rsi-reversion', 'ema-crossover',
  'bollinger-reversion', 'sma-baseline', 'momentum-12m',
])
const HORIZONS: readonly StrategyHorizon[] = ['short', 'swing', 'long']
const DEFAULT_TIMEOUT_MS = 100

export type StrategyValidationResult =
  | { ok: true; definition: import('./types.ts').StrategyDefinition; record: CustomStrategyRecord }
  | { ok: false; reason: string }

/** 将策略源码解析为可执行纯函数（浏览器端 new Function；Node 侧走 vm runner 试算）。 */
export function compileStrategySource(
  source: string,
): (bars: readonly Kline[], params: Readonly<Record<string, number>>) => StrategySignal[] {
  const trimmed = source.trim()
  if (
    /^(?:\([a-zA-Z0-9_,\s]*\)|[a-zA-Z0-9_]+)\s*=>/.test(trimmed)
    || /^function\b/.test(trimmed)
  ) {
    const factory = new Function(`"use strict"; return (${trimmed});`)
    return factory() as (bars: readonly Kline[], params: Readonly<Record<string, number>>) => StrategySignal[]
  }
  const factory = new Function('bars', 'params', `"use strict";\n${trimmed}`)
  return factory as unknown as (bars: readonly Kline[], params: Readonly<Record<string, number>>) => StrategySignal[]
}

/**
 * 信号序列专用校验（引擎语义对齐：i 收盘确认、i+1 开盘成交可复算）。
 * 返回 undefined = 通过；否则返回人话诊断（模型与 UI 直接可读）。
 */
export function validateSignalSequence(
  signals: readonly unknown[],
  bars: readonly Kline[],
): string | undefined {
  let position: 'flat' | 'long' = 'flat'
  let prevIndex = -1
  for (let i = 0; i < signals.length; i++) {
    const s = signals[i]
    if (typeof s !== 'object' || s === null) {
      return `signals[${i}] 必须是非空对象`
    }
    const signal = s as Partial<StrategySignal>

    // index：整数、范围、严格单调
    if (typeof signal.index !== 'number' || !Number.isInteger(signal.index)
      || signal.index < 0 || signal.index >= bars.length) {
      return `signals[${i}].index 必须是落在 [0, ${bars.length - 1}] 的整数（bar 下标），收到: ${String(signal.index)}`
    }
    if (signal.index <= prevIndex) {
      return `signals[${i}].index (${signal.index}) 必须严格大于前一个信号的 index (${prevIndex})——信号按 bar 下标单调递增`
    }
    prevIndex = signal.index

    // time：与确认 bar 的 openTime 逐位一致
    if (signal.time !== bars[signal.index].openTime) {
      return `signals[${i}].time (${String(signal.time)}) 与 bars[${signal.index}].openTime (${String(bars[signal.index].openTime)}) 不一致——信号 time 必须等于确认 bar 的 openTime`
    }

    // action / direction：合法词汇且配对
    if (signal.action !== 'entry' && signal.action !== 'exit') {
      return `signals[${i}].action 必须是 "entry" 或 "exit"，收到: ${JSON.stringify(signal.action)}`
    }
    if (signal.direction !== 'long' && signal.direction !== 'flat') {
      return `signals[${i}].direction 必须是 "long" 或 "flat"，收到: ${JSON.stringify(signal.direction)}`
    }
    const expectedDirection = signal.action === 'entry' ? 'long' : 'flat'
    if (signal.direction !== expectedDirection) {
      return `signals[${i}].direction (${signal.direction}) 与 action (${signal.action}) 不配对——entry 对应 long，exit 对应 flat`
    }

    // price：有限数且等于确认 bar 收盘价（i 收盘确认；浮点容差 1e-6 相对误差）
    if (typeof signal.price !== 'number' || !Number.isFinite(signal.price)) {
      return `signals[${i}].price 必须是有限数字（确认时收盘价），收到: ${String(signal.price)}`
    }
    const close = bars[signal.index].close
    if (Math.abs(signal.price - close) > Math.max(1e-9, Math.abs(close) * 1e-6)) {
      return `signals[${i}].price (${signal.price}) 与确认 bar 收盘价 (${close}) 不一致——信号在 i 收盘确认，price 必须等于 bars[i].close`
    }

    // reason：非空字符串（UI 与对话卡片直接展示）
    if (typeof signal.reason !== 'string' || !signal.reason.trim()) {
      return `signals[${i}].reason 必须是非空字符串（人话解释）`
    }
    if (signal.reason.length > MAX_REASON_LENGTH) {
      return `signals[${i}].reason 超长（${signal.reason.length} > ${MAX_REASON_LENGTH}）`
    }

    // 可复算：entry/exit 严格交替（exit 必须持仓、entry 必须空仓）
    if (signal.action === 'entry' && position === 'long') {
      return `signals[${i}] 在已持仓（前一个 entry 尚未 exit）时再次 entry——引擎不会重复开仓，序列不可复算`
    }
    if (signal.action === 'exit' && position === 'flat') {
      return `signals[${i}] 在空仓时 exit——没有可平的头寸，序列不可复算（首信号必须是 entry）`
    }
    position = signal.action === 'entry' ? 'long' : 'flat'
  }
  return undefined
}

/**
 * 结构校验（无试算）——browser/node 校验器共用。
 */
function checkCustomStrategyStructure(raw: unknown):
  | { ok: false; reason: string }
  | {
    ok: true
    id: string
    title: string
    horizon: StrategyHorizon
    summary: string
    params: StrategyParamSpec[]
    computeSource: string
    input: Partial<CustomStrategyRecord>
  } {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, reason: '策略配置必须是一个非空对象' }
  }
  const input = raw as Partial<CustomStrategyRecord>

  // 1. id 校验
  const id = typeof input.id === 'string' ? input.id.trim().toLowerCase() : ''
  if (!id) return { ok: false, reason: '缺少策略 id' }
  if (!ID_PATTERN.test(id)) {
    return { ok: false, reason: `策略 id "${id}" 不合法：必须由 2-32 位小写字母、数字、下划线或连字符组成` }
  }
  if (RESERVED_IDS.has(id)) {
    return { ok: false, reason: `策略 id "${id}" 是系统范式保留名称，请使用其他名称（如 custom_${id}）` }
  }

  // 2. title 校验
  const title = typeof input.title === 'string' ? input.title.trim() : ''
  if (!title || title.length > 32) {
    return { ok: false, reason: '策略 title 必须是 1-32 字符的非空字符串' }
  }

  // 3. horizon 校验
  const horizon = input.horizon as StrategyHorizon
  if (!HORIZONS.includes(horizon)) {
    return { ok: false, reason: `策略 horizon 必须是 "short"、"swing" 或 "long"，收到: ${JSON.stringify(input.horizon)}` }
  }

  // 4. summary 校验
  const summary = typeof input.summary === 'string' ? input.summary.trim() : ''
  if (!summary || summary.length > MAX_SUMMARY_LENGTH) {
    return { ok: false, reason: `策略 summary 必须是 1-${MAX_SUMMARY_LENGTH} 字符的非空字符串` }
  }

  // 5. paramsJson 校验：JSON 解析 → 参数规格数组（语义与指标参数一致）
  let params: StrategyParamSpec[] = []
  if (input.paramsJson !== undefined) {
    if (typeof input.paramsJson !== 'string') {
      return { ok: false, reason: '策略 paramsJson 必须是字符串（StrategyParamSpec[] 的 JSON）' }
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(input.paramsJson)
    } catch (error) {
      return { ok: false, reason: `paramsJson 不是合法 JSON: ${String((error as { message?: string })?.message ?? error)}` }
    }
    if (!Array.isArray(parsed)) {
      return { ok: false, reason: 'paramsJson 解析结果必须是数组（StrategyParamSpec[]）' }
    }
    if (parsed.length > MAX_PARAMS_COUNT) {
      return { ok: false, reason: `策略参数数量超出上限（至多 ${MAX_PARAMS_COUNT} 个）` }
    }
    for (let index = 0; index < parsed.length; index++) {
      const p = parsed[index]
      if (typeof p !== 'object' || p === null) {
        return { ok: false, reason: `paramsJson[${index}] 必须是一个对象` }
      }
      const spec = p as Partial<StrategyParamSpec>
      const key = typeof spec.key === 'string' ? spec.key.trim() : ''
      if (!PARAM_KEY_PATTERN.test(key)) {
        return { ok: false, reason: `paramsJson[${index}].key "${key}" 不合法：必须是 1-16 位字母数字或下划线` }
      }
      const label = typeof spec.label === 'string' ? spec.label.trim() : key
      const defVal = Number(spec.default)
      const minVal = Number(spec.min)
      const maxVal = Number(spec.max)
      if (!Number.isFinite(defVal) || !Number.isFinite(minVal) || !Number.isFinite(maxVal)) {
        return { ok: false, reason: `paramsJson[${index}] (${key}) 的 default、min、max 必须是有限数字` }
      }
      if (minVal >= maxVal) {
        return { ok: false, reason: `paramsJson[${index}] (${key}) 的 min (${minVal}) 必须严格小于 max (${maxVal})` }
      }
      if (defVal < minVal || defVal > maxVal) {
        return { ok: false, reason: `paramsJson[${index}] (${key}) 的 default (${defVal}) 必须在 [min, max] (${minVal}..${maxVal}) 范围内` }
      }
      params.push({ key, label, default: defVal, min: minVal, max: maxVal, step: 1 })
    }
  }

  // 6. computeSource 源码校验
  const computeSource = typeof input.computeSource === 'string' ? input.computeSource.trim() : ''
  if (!computeSource) {
    return { ok: false, reason: '缺少 computeSource 源码' }
  }
  if (computeSource.length > MAX_SOURCE_LENGTH) {
    return { ok: false, reason: `computeSource 源码长度 (${computeSource.length} B) 超出限制 (${MAX_SOURCE_LENGTH} B / 16KB)` }
  }

  // 7. 编译语法验证
  try {
    compileStrategySource(computeSource)
  } catch (error) {
    return { ok: false, reason: `源码语法错误或无法编译: ${String((error as { message?: string })?.message ?? error)}` }
  }

  return { ok: true, id, title, horizon, summary, params, computeSource, input }
}

/**
 * 自定义策略校验（异步——试算走可等待 runner，默认浏览器 Worker 超时熔断；
 * Node 宿主侧传 validate-node.ts 的 vm 熔断 runner）。
 */
export async function validateCustomStrategy(
  raw: unknown,
  options?: { runner?: AsyncComputeRunner },
): Promise<StrategyValidationResult> {
  const checked = checkCustomStrategyStructure(raw)
  if (!checked.ok) return checked
  const { id, title, horizon, summary, params, computeSource, input } = checked

  const sampleScenarios = createSampleBars()
  const scenarioNames: Array<keyof typeof sampleScenarios> = ['uptrend', 'downtrend', 'flat', 'gap', 'short']
  const runner = options?.runner ?? workerComputeRunner
  const defaultParamsMap: Record<string, number> = {}
  for (const p of params) defaultParamsMap[p.key] = p.default

  for (const scenario of scenarioNames) {
    const bars = sampleScenarios[scenario]
    let signals: unknown[]
    try {
      const out = await runner(computeSource, bars, { ...defaultParamsMap }, DEFAULT_TIMEOUT_MS)
      signals = out as unknown[]
    } catch (error) {
      return { ok: false, reason: `在 ${scenario} 样例数据上试算执行报错: ${String((error as { message?: string })?.message ?? error)}` }
    }
    if (!Array.isArray(signals)) {
      return { ok: false, reason: `compute 返回值必须是 StrategySignal[] 数组，${scenario} 场景实际返回类型为: ${typeof signals}` }
    }
    const sequenceReason = validateSignalSequence(signals, bars)
    if (sequenceReason !== undefined) {
      return { ok: false, reason: `信号序列校验失败（${scenario} 场景）: ${sequenceReason}` }
    }
  }

  const compute = compileStrategySource(computeSource)
  const definition = { id, horizon, name: title, summary, params, compute }
  const record: CustomStrategyRecord = {
    id,
    title,
    horizon,
    summary,
    paramsJson: JSON.stringify(params),
    computeSource,
    createdAt: typeof input.createdAt === 'number' ? input.createdAt : Date.now(),
  }
  return { ok: true, definition, record }
}
