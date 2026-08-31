import { defineTool } from '@deepseek-ai/dsh-tools'
import { presetDefinitions, type IndicatorDefinition } from './presets.ts'
import type { IndicatorParamSpec, Kline } from './types.ts'
import type { CustomIndicatorStore } from './custom.ts'
import { validateCustomIndicatorNode } from './validate-node.ts'

export { createFileCustomIndicatorStore } from './custom-fs.ts'
export { validateCustomIndicatorNode, nodeVmComputeRunner } from './validate-node.ts'

/** 最小行情服务面（结构类型——与 @dsh-trading/api 的 MarketDataService 兼容）。 */
export interface IndicatorsMarketDataLike {
  getKlines(symbol: string, interval: string, limit?: number): Promise<Kline[]>
}

export interface GetIndicatorsToolOptions {
  marketData: IndicatorsMarketDataLike
  /** 市场前缀（工具名 <market>_get_indicators），默认 crypto。 */
  market?: string
  /** 数据源标签（进输出，供 Agent 溯源），如 'okx'。 */
  providerLabel?: string
  /** 取 K 线根数：需覆盖最长 warm-up（MACD 12/26/9），默认 300。 */
  klineLimit?: number
}

const DEFAULT_POINTS = 30
const MAX_POINTS = 100

const DEFAULT_INDICATOR_IDS = presetDefinitions().map((d) => d.id)

/** 按 schema 生成默认参数。 */
function defaultParams(definition: IndicatorDefinition): Record<string, number> {
  return Object.fromEntries(definition.params.map((p) => [p.key, p.default]))
}

/** Series 取尾 n 点；JSON 化时 undefined → null（JSON.stringify 已处理）。 */
function tail(values: ReadonlyArray<number | undefined>, n: number): Array<number | null> {
  return values.slice(-n).map((v) => (v === undefined ? null : v))
}

export function createGetIndicatorsTool(options: GetIndicatorsToolOptions) {
  const { marketData, market = 'crypto', providerLabel, klineLimit = 300 } = options
  return defineTool({
    name: market + '_get_indicators',
    description:
      'Compute technical indicators (MA/EMA/BOLL/MACD/RSI/KDJ) for a symbol over recent klines from the routed market data provider. '
      + 'symbol uses market-canonical vocabulary (e.g. BTCUSDT). '
      + 'Returns per-indicator latest value plus the trailing point series (warm-up leading values are null).',
    parameters: {
      symbol: {
        type: 'string',
        required: true,
        description: 'Instrument symbol in market-canonical vocabulary, e.g. BTCUSDT (crypto) / AAPL (us) / 600519.SH (cn) / 00700.HK (hk)',
      },
      interval: {
        type: 'string',
        required: true,
        description: "Kline interval, e.g. '15m' | '1h' | '4h' | '1d' | '1w' (provider-supported set may vary; unsupported ones are rejected with TRADING_UNSUPPORTED_INTERVAL)",
      },
      indicators: {
        type: 'string',
        description: 'Comma-separated indicator ids to compute (default: all of ' + DEFAULT_INDICATOR_IDS.join(',') + ')',
      },
      points: {
        type: 'number',
        description: 'Trailing points to include per indicator series (1-' + MAX_POINTS + ', default ' + DEFAULT_POINTS + ')',
        default: DEFAULT_POINTS,
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(raw) {
      const args = (raw ?? {}) as { symbol?: unknown; interval?: unknown; indicators?: unknown; points?: unknown }
      const symbol = typeof args.symbol === 'string' ? args.symbol.trim() : ''
      if (!symbol) {
        throw new Error((market + '_get_indicators: invalid symbol ') + JSON.stringify(args.symbol) + ' — expected a market-canonical symbol like BTCUSDT')
      }
      const interval = typeof args.interval === 'string' ? args.interval.trim() : ''
      if (!interval) {
        throw new Error((market + '_get_indicators: invalid interval ') + JSON.stringify(args.interval))
      }
      const requestedIds = typeof args.indicators === 'string' && args.indicators.trim()
        ? args.indicators.split(',').map((s) => s.trim()).filter(Boolean)
        : DEFAULT_INDICATOR_IDS
      const definitions = presetDefinitions()
      const unknown = requestedIds.filter((id) => !definitions.some((d) => d.id === id))
      if (unknown.length > 0) {
        throw new Error((market + '_get_indicators: unknown indicator id(s) ') + unknown.map((s) => JSON.stringify(s)).join(', ')
          + ' — available: ' + DEFAULT_INDICATOR_IDS.join(', '))
      }
      const requestedPoints = typeof args.points === 'number' && Number.isFinite(args.points) ? Math.trunc(args.points) : DEFAULT_POINTS
      const points = Math.min(Math.max(requestedPoints, 1), MAX_POINTS)

      const bars = await marketData.getKlines(symbol, interval, klineLimit)
      if (bars.length === 0) {
        throw new Error((market + '_get_indicators: no klines returned for ') + symbol + ' @ ' + interval)
      }
      const lines: string[] = [
        (market + '_get_indicators ') + symbol + ' @ ' + interval
        + ' — ' + requestedIds.length + ' indicator(s), tail ' + points + ' point(s) of ' + bars.length + ' bar(s)'
        + (providerLabel ? '  provider=' + providerLabel : ''),
      ]
      for (const id of requestedIds) {
        const definition = definitions.find((d) => d.id === id)!
        const params = defaultParams(definition)
        const paramText = definition.params.map((p) => (p.key + '=' + params[p.key])).join(' ')
        lines.push(definition.title + ' (' + paramText + '):')
        for (const output of definition.compute(bars, params)) {
          const last = output.values[output.values.length - 1]
          lines.push('  ' + output.key + ' latest=' + (last === undefined ? 'null' : String(last))
            + ' tail=' + JSON.stringify(tail(output.values, points)))
        }
      }
      return lines.join('\n')
    },
  })
}

export interface AuthorIndicatorToolOptions {
  store: CustomIndicatorStore
}

export function createAuthorIndicatorTool(options: AuthorIndicatorToolOptions) {
  const { store } = options

  return defineTool({
    name: 'indicator_author',
    description:
      'Author, validate, and persist a custom technical indicator from JavaScript compute source. '
      + 'Executes full sandbox test calculations across multiple kline scenarios (uptrend, downtrend, flat, gaps, short series). '
      + 'If valid, the indicator is immediately persisted and available for charting; if invalid, detailed diagnostic reasons are returned.',
    parameters: {
      id: {
        type: 'string',
        required: true,
        description: 'Unique indicator id (2-32 lowercase alphanumeric or underscore, e.g. "td9", "supertrend", "obv_ma34")',
      },
      title: {
        type: 'string',
        required: true,
        description: 'Display title for the indicator (1-32 chars, e.g. "TD9", "SuperTrend", "OBV+MA34")',
      },
      pane: {
        type: 'string',
        required: true,
        description: 'Indicator pane placement: "main" (overlay on main price chart, e.g. TD9, SuperTrend) or "sub" (separate sub-chart pane, e.g. OBV, MACD)',
      },
      computeSource: {
        type: 'string',
        required: true,
        description:
          'JavaScript pure compute function source, signature (bars, params) => IndicatorOutput[]. '
          + 'bars has { openTime, open, high, low, close, volume }; '
          + 'output values must be strictly aligned with bars.length using undefined for initial warm-up period (no NaN/Infinity allowed).',
      },
      paramsJson: {
        type: 'string',
        description:
          'Optional JSON array of parameter specifications, e.g. [{"key":"period","label":"周期","default":14,"min":2,"max":100}]. Up to 8 parameters.',
      },
      description: {
        type: 'string',
        description: 'Optional human-readable description or usage guidance for the indicator.',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(raw) {
      const args = (raw ?? {}) as {
        id?: unknown
        title?: unknown
        pane?: unknown
        computeSource?: unknown
        paramsJson?: unknown
        description?: unknown
      }

      let parsedParams: IndicatorParamSpec[] = []
      if (typeof args.paramsJson === 'string' && args.paramsJson.trim()) {
        try {
          const parsed = JSON.parse(args.paramsJson)
          if (Array.isArray(parsed)) parsedParams = parsed
        } catch {
          return `[indicator_author] Validation failed: paramsJson is not valid JSON (${args.paramsJson})`
        }
      }

      const candidate = {
        id: typeof args.id === 'string' ? args.id.trim() : '',
        title: typeof args.title === 'string' ? args.title.trim() : '',
        pane: args.pane,
        params: parsedParams,
        computeSource: typeof args.computeSource === 'string' ? args.computeSource : '',
        description: typeof args.description === 'string' ? args.description.trim() : undefined,
      }

      const result = validateCustomIndicatorNode(candidate)
      if (!result.ok) {
        return (
          `[indicator_author] Validation failed: ${result.reason}\n`
          + 'Please review the indicator requirements: values array length must match bars.length, use undefined for warm-up, avoid NaN, and ensure all math is finite.'
        )
      }

      await store.save(result.record)

      const paramSummary = result.record.params.map(p => `${p.key}=${p.default}`).join(', ')
      return (
        `[indicator_author] Successfully authored indicator "${result.record.title}" (id: ${result.record.id}, pane: ${result.record.pane}${paramSummary ? `, params: ${paramSummary}` : ''}). `
        + 'The indicator has passed 5 sandbox verification scenarios and is now persisted and available in the chart quick indicator bar.'
      )
    },
  })
}
