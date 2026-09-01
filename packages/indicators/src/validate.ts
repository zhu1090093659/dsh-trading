/**
 * 纯函数安全校验器（Custom Indicator Validator）。
 *
 * 浏览器端与宿主两侧共用（零 Node.js 运行时依赖，浏览器纯净安全）：
 * 1. 结构与参数合法性断言
 * 2. 源码体积与格式检查
 * 3. 多场景样例 K 线试算（上涨/下跌/平盘/缺口/极短序列）
 * 4. 支持可插拔 runner（Node 侧传入 nodeVmRunner 开启 100ms 超时熔断保护）
 * 5. 输出形状等长断言（values.length === bars.length）
 * 6. 有限数值与 warm-up 断言（严禁 NaN/Infinity/非法类型）
 */
import type {
  IndicatorDefinition,
  IndicatorOutput,
  IndicatorPane,
  IndicatorParamSpec,
  Kline,
} from './types.ts'
import type { CustomIndicatorRecord } from './custom.ts'

const ID_PATTERN = /^[a-z0-9_]{2,32}$/
const PARAM_KEY_PATTERN = /^[a-zA-Z0-9_]{1,16}$/
const MAX_SOURCE_LENGTH = 16 * 1024 // 16KB
const MAX_PARAMS_COUNT = 8
const RESERVED_IDS = new Set(['ma', 'ema', 'boll', 'macd', 'rsi', 'kdj'])
const DEFAULT_TIMEOUT_MS = 100

export type ValidationResult =
  | { ok: true; definition: IndicatorDefinition; record: CustomIndicatorRecord }
  | { ok: false; reason: string }

export type ComputeRunner = (
  computeSource: string,
  bars: readonly Kline[],
  params: Record<string, number>,
  timeoutMs: number,
) => IndicatorOutput[]

/** 生成特征测试 K 线序列。 */
export function createSampleBars(): Record<'uptrend' | 'downtrend' | 'flat' | 'gap' | 'short', Kline[]> {
  const baseTime = 1700000000000
  const minute = 60 * 1000

  // 1. 30 根平稳上涨
  const uptrend: Kline[] = Array.from({ length: 30 }, (_, i) => {
    const open = 100 + i * 2
    const close = open + 1.5
    return {
      openTime: baseTime + i * minute,
      open,
      high: close + 1,
      low: open - 0.5,
      close,
      volume: 1000 + i * 50,
    }
  })

  // 2. 30 根平稳下跌
  const downtrend: Kline[] = Array.from({ length: 30 }, (_, i) => {
    const open = 200 - i * 2.5
    const close = open - 2
    return {
      openTime: baseTime + i * minute,
      open,
      high: open + 0.5,
      low: close - 1,
      close,
      volume: 2000 - i * 30,
    }
  })

  // 3. 30 根平盘震荡
  const flat: Kline[] = Array.from({ length: 30 }, (_, i) => {
    const delta = (i % 2 === 0 ? 1 : -1) * (i % 3 === 0 ? 0.8 : 0.2)
    const open = 150
    const close = open + delta
    return {
      openTime: baseTime + i * minute,
      open,
      high: Math.max(open, close) + 0.5,
      low: Math.min(open, close) - 0.5,
      close,
      volume: 1500,
    }
  })

  // 4. 15 根跳空大缺口
  const gap: Kline[] = Array.from({ length: 15 }, (_, i) => {
    const jump = i === 7 ? 30 : 0
    const open = 100 + i * 2 + jump
    const close = open + 1
    return {
      openTime: baseTime + i * minute,
      open,
      high: close + 2,
      low: open - 1,
      close,
      volume: 3000,
    }
  })

  // 5. 3 根极短序列（测试短历史下的 warm-up 处理）
  const short: Kline[] = [
    { openTime: baseTime, open: 100, high: 102, low: 99, close: 101, volume: 500 },
    { openTime: baseTime + minute, open: 101, high: 104, low: 100, close: 103, volume: 600 },
    { openTime: baseTime + 2 * minute, open: 103, high: 105, low: 102, close: 102, volume: 550 },
  ]

  return { uptrend, downtrend, flat, gap, short }
}

/** 将源码解析为可执行纯函数。 */
export function compileComputeSource(source: string): (bars: readonly Kline[], params: Readonly<Record<string, number>>) => IndicatorOutput[] {
  const trimmed = source.trim()
  if (
    /^(?:\([a-zA-Z0-9_,\s]*\)|[a-zA-Z0-9_]+)\s*=>/.test(trimmed)
    || /^function\b/.test(trimmed)
  ) {
    // 表达式形式：(bars, params) => { ... } 或 function(bars, params) { ... }
    const factory = new Function(`"use strict"; return (${trimmed});`)
    return factory() as (bars: readonly Kline[], params: Readonly<Record<string, number>>) => IndicatorOutput[]
  }
  // 函数体语句形式：const closes = bars.map(b => b.close); ... return [...]
  const factory = new Function('bars', 'params', `"use strict";\n${trimmed}`)
  return factory as unknown as (bars: readonly Kline[], params: Readonly<Record<string, number>>) => IndicatorOutput[]
}

/** 默认浏览器纯 JS runner。 */
const defaultJsRunner: ComputeRunner = (source, bars, params) => {
  const fn = compileComputeSource(source)
  return fn(bars, params)
}

/** 可等待 runner 形状：Worker 熔断版返回 Promise；Node 侧 vm 熔断版直接返回值。 */
export type Awaitable<T> = T | Promise<T>
export type AsyncComputeRunner = (
  computeSource: string,
  bars: readonly Kline[],
  params: Record<string, number>,
  timeoutMs: number,
) => Awaitable<unknown>

/** blob Worker 内执行的编译+试算脚本（自包含，不依赖宿主任何模块）。 */
const WORKER_TRIAL_SCRIPT = `self.onmessage = (event) => {
  const { source, bars, params } = event.data
  try {
    const trimmed = String(source).trim()
    let fn
    if (/^(?:\\([a-zA-Z0-9_,\\s]*\\)|[a-zA-Z0-9_]+)\\s*=>/.test(trimmed) || /^function\\b/.test(trimmed)) {
      fn = (new Function('"use strict"; return (' + trimmed + ');'))()
    } else {
      fn = new Function('bars', 'params', '"use strict";\\n' + trimmed)
    }
    const result = fn(bars, params)
    self.postMessage({ ok: true, result })
  } catch (error) {
    self.postMessage({ ok: false, message: String((error && error.message) || error) })
  }
}`

/**
 * 浏览器端 Worker 超时 runner（issue #31）：compute 源码在 blob URL Worker 内
 * 编译执行，主线程超时即 terminate——补 new Function 裸执行「死循环卡死主线程」
 * 的缺口（策略校验与指标异步校验共用）。非浏览器环境（Node）回退同步直执行
 * （无熔断；Node 侧应传 vm 熔断 runner）。
 */
export function workerComputeRunner(
  computeSource: string,
  bars: readonly Kline[],
  params: Record<string, number>,
  timeoutMs = 100,
): Promise<unknown> {
  if (typeof Worker === 'undefined' || typeof Blob === 'undefined' || typeof URL === 'undefined') {
    try {
      const fn = compileComputeSource(computeSource)
      return Promise.resolve(fn(bars, params))
    } catch (error) {
      return Promise.reject(error)
    }
  }
  return new Promise((resolve, reject) => {
    const blob = new Blob([WORKER_TRIAL_SCRIPT], { type: 'text/javascript' })
    const url = URL.createObjectURL(blob)
    const worker = new Worker(url)
    let settled = false
    const finish = (action: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      worker.terminate()
      URL.revokeObjectURL(url)
      action()
    }
    const timer = setTimeout(() => {
      finish(() => reject(new Error(`compute 执行超时（超过 ${timeoutMs}ms），可能存在死循环（如 while/for 未退出）`)))
    }, timeoutMs)
    worker.onmessage = (event: MessageEvent) => {
      const data = event.data as { ok: boolean; result?: unknown; message?: string }
      finish(() => {
        if (data.ok) resolve(data.result)
        else reject(new Error(data.message ?? 'compute 执行失败'))
      })
    }
    worker.onerror = (event: ErrorEvent) => {
      finish(() => reject(new Error(String(event.message ?? 'worker 执行失败'))))
    }
    worker.postMessage({ source: computeSource, bars: [...bars], params: { ...params } })
  })
}

/**
 * 结构与语法校验（检查 1-6，无试算）——sync / async（Worker 熔断）校验器共用。
 */
function checkCustomIndicatorStructure(raw: unknown):
  | { ok: false; reason: string }
  | { ok: true; id: string; title: string; pane: IndicatorPane; params: IndicatorParamSpec[]; computeSource: string; defaultParamsMap: Record<string, number>; input: Partial<CustomIndicatorRecord> } {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, reason: '指标配置必须是一个非空对象' }
  }

  const input = raw as Partial<CustomIndicatorRecord>

  // 1. id 校验
  const id = typeof input.id === 'string' ? input.id.trim().toLowerCase() : ''
  if (!id) {
    return { ok: false, reason: '缺少指标 id' }
  }
  if (!ID_PATTERN.test(id)) {
    return { ok: false, reason: `指标 id "${id}" 不合法：必须由 2-32 位小写字母、数字或下划线组成` }
  }
  if (RESERVED_IDS.has(id)) {
    return { ok: false, reason: `指标 id "${id}" 是系统预置保留名称，请使用其他名称（如 custom_${id}）` }
  }

  // 2. title 校验
  const title = typeof input.title === 'string' ? input.title.trim() : ''
  if (!title || title.length > 32) {
    return { ok: false, reason: '指标 title 必须是 1-32 字符的非空字符串' }
  }

  // 3. pane 校验
  const pane = input.pane as IndicatorPane
  if (pane !== 'main' && pane !== 'sub') {
    return { ok: false, reason: `指标 pane 必须是 "main"（主图叠加）或 "sub"（副图），收到: ${JSON.stringify(input.pane)}` }
  }

  // 4. params 校验
  const params: IndicatorParamSpec[] = []
  if (input.params !== undefined) {
    if (!Array.isArray(input.params)) {
      return { ok: false, reason: '指标 params 必须是数组' }
    }
    if (input.params.length > MAX_PARAMS_COUNT) {
      return { ok: false, reason: `指标 params 数量超出上限（至多 ${MAX_PARAMS_COUNT} 个参数）` }
    }
    for (let index = 0; index < input.params.length; index++) {
      const p = input.params[index]
      if (typeof p !== 'object' || p === null) {
        return { ok: false, reason: `params[${index}] 必须是一个对象` }
      }
      const key = typeof p.key === 'string' ? p.key.trim() : ''
      if (!PARAM_KEY_PATTERN.test(key)) {
        return { ok: false, reason: `params[${index}].key "${key}" 不合法：必须是 1-16 位字母数字或下划线` }
      }
      const label = typeof p.label === 'string' ? p.label.trim() : key
      const defVal = Number(p.default)
      const minVal = Number(p.min)
      const maxVal = Number(p.max)
      if (!Number.isFinite(defVal) || !Number.isFinite(minVal) || !Number.isFinite(maxVal)) {
        return { ok: false, reason: `params[${index}] (${key}) 的 default、min、max 必须是有限数字` }
      }
      if (minVal >= maxVal) {
        return { ok: false, reason: `params[${index}] (${key}) 的 min (${minVal}) 必须严格小于 max (${maxVal})` }
      }
      if (defVal < minVal || defVal > maxVal) {
        return { ok: false, reason: `params[${index}] (${key}) 的 default (${defVal}) 必须在 [min, max] (${minVal}..${maxVal}) 范围内` }
      }
      params.push({ key, label, default: defVal, min: minVal, max: maxVal })
    }
  }

  // 5. computeSource 源码校验
  const computeSource = typeof input.computeSource === 'string' ? input.computeSource.trim() : ''
  if (!computeSource) {
    return { ok: false, reason: '缺少 computeSource 源码' }
  }
  if (computeSource.length > MAX_SOURCE_LENGTH) {
    return { ok: false, reason: `computeSource 源码长度 (${computeSource.length} B) 超出限制 (${MAX_SOURCE_LENGTH} B / 16KB)` }
  }

  // 6. 编译语法验证
  try {
    compileComputeSource(computeSource)
  } catch (error) {
    return { ok: false, reason: `源码语法错误或无法编译: ${String((error as { message?: string })?.message ?? error)}` }
  }

  const defaultParamsMap: Record<string, number> = {}
  for (const p of params) defaultParamsMap[p.key] = p.default

  return { ok: true, id, title, pane, params, computeSource, defaultParamsMap, input }
}

/** 试算输出的形状与逐点校验（sync/async 共用）；返回 undefined = 通过。 */
function checkIndicatorTrialOutputs(outputs: unknown, barsLength: number): string | undefined {
  if (!Array.isArray(outputs)) {
    return `compute 返回值必须是 IndicatorOutput[] 数组，实际返回类型为: ${typeof outputs}`
  }
  if (outputs.length === 0) {
    return 'compute 返回的 IndicatorOutput[] 数组不能为空（至少需要一个输出系列）'
  }
  if (outputs.length > 8) {
    return `compute 返回的输出系列过多 (${outputs.length} > 8)`
  }

  for (let outIdx = 0; outIdx < outputs.length; outIdx++) {
    const output = outputs[outIdx]
    if (typeof output !== 'object' || output === null) {
      return `outputs[${outIdx}] 必须是非空对象`
    }
    if (typeof output.key !== 'string' || !output.key.trim()) {
      return `outputs[${outIdx}].key 必须是非空字符串`
    }
    if (output.kind !== 'line' && output.kind !== 'histogram' && output.kind !== 'area') {
      return `outputs[${outIdx}].kind 必须是 "line"、"histogram" 或 "area"`
    }
    if (typeof output.color !== 'string' || !output.color.trim()) {
      return `outputs[${outIdx}].color 必须是非空颜色字符串`
    }
    if (!Array.isArray(output.values)) {
      return `outputs[${outIdx}].values 必须是数组`
    }
    if (output.values.length !== barsLength) {
      return `outputs[${outIdx}] (${output.key}) 的 values 长度 (${output.values.length}) 与输入的 bars 长度 (${barsLength}) 不一致（必须逐条对齐）`
    }

    // 逐点数值有限性与 warm-up 校验
    for (let valIdx = 0; valIdx < output.values.length; valIdx++) {
      const v = output.values[valIdx]
      if (v === undefined) {
        // 合法的 warm-up
        continue
      }
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        return `outputs[${outIdx}] (${output.key}) 在下标 ${valIdx} 处包含非法数值: ${String(v)}（只允许有限数字或 undefined 作为 warm-up）`
      }
    }
  }
  return undefined
}

export function validateCustomIndicator(raw: unknown, options?: { runner?: ComputeRunner }): ValidationResult {
  const checked = checkCustomIndicatorStructure(raw)
  if (!checked.ok) return checked
  const { id, title, pane, params, computeSource, defaultParamsMap, input } = checked

  const sampleScenarios = createSampleBars()
  const scenarioNames: Array<keyof typeof sampleScenarios> = ['uptrend', 'downtrend', 'flat', 'gap', 'short']
  const runner = options?.runner ?? defaultJsRunner

  for (const scenario of scenarioNames) {
    const bars = sampleScenarios[scenario]
    let outputs: IndicatorOutput[]
    try {
      outputs = runner(computeSource, bars, defaultParamsMap, DEFAULT_TIMEOUT_MS)
    } catch (error) {
      return { ok: false, reason: `在 ${scenario} 样例数据上试算执行报错: ${String((error as { message?: string })?.message ?? error)}` }
    }

    const outputReason = checkIndicatorTrialOutputs(outputs, bars.length)
    if (outputReason !== undefined) return { ok: false, reason: outputReason }
  }

  const computeFn = compileComputeSource(computeSource)

  const definition: IndicatorDefinition = {
    id,
    title,
    pane,
    params,
    compute: computeFn,
  }

  const record: CustomIndicatorRecord = {
    id,
    title,
    pane,
    params,
    computeSource,
    createdAt: typeof input.createdAt === 'number' ? input.createdAt : Date.now(),
    description: typeof input.description === 'string' ? input.description.trim() : undefined,
  }

  return { ok: true, definition, record }
}

/**
 * 异步版校验器（issue #31）：结构与语法校验与同步版同源（checkCustomIndicatorStructure），
 * 试算走可等待 runner——默认 Worker 超时熔断（workerComputeRunner），补浏览器端
 * new Function 裸执行「死循环卡死主线程」的既知缺口。Node 宿主侧继续用
 * validateCustomIndicatorNode（vm 熔断，同步语义）。
 */
export async function validateCustomIndicatorAsync(
  raw: unknown,
  options?: { runner?: AsyncComputeRunner },
): Promise<ValidationResult> {
  const checked = checkCustomIndicatorStructure(raw)
  if (!checked.ok) return checked
  const { id, title, pane, params, computeSource, defaultParamsMap, input } = checked

  const sampleScenarios = createSampleBars()
  const scenarioNames: Array<keyof typeof sampleScenarios> = ['uptrend', 'downtrend', 'flat', 'gap', 'short']
  const runner = options?.runner ?? workerComputeRunner

  for (const scenario of scenarioNames) {
    const bars = sampleScenarios[scenario]
    let outputs: IndicatorOutput[]
    try {
      outputs = await runner(computeSource, bars, { ...defaultParamsMap }, DEFAULT_TIMEOUT_MS) as IndicatorOutput[]
    } catch (error) {
      return { ok: false, reason: `在 ${scenario} 样例数据上试算执行报错: ${String((error as { message?: string })?.message ?? error)}` }
    }
    const outputReason = checkIndicatorTrialOutputs(outputs, bars.length)
    if (outputReason !== undefined) return { ok: false, reason: outputReason }
  }

  const computeFn = compileComputeSource(computeSource)
  const definition: IndicatorDefinition = { id, title, pane, params, compute: computeFn }
  const record: CustomIndicatorRecord = {
    id,
    title,
    pane,
    params,
    computeSource,
    createdAt: typeof input.createdAt === 'number' ? input.createdAt : Date.now(),
    description: typeof input.description === 'string' ? input.description.trim() : undefined,
  }
  return { ok: true, definition, record }
}
