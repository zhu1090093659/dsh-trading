/**
 * Agent 指标工具工厂（WS1b，docs/analysis-roadmap.md）：把指标计算暴露成
 * <market>_get_indicators 工具。放本包子路径导出而非独立包——与 connectors 的
 * 接入面就一个函数，单独建包过重（铁律 #4 不过早抽象）。
 *
 * 为什么由 connector 注册而非 kit：preset 平面插件（kit）拿不到 host/connector
 * isolate 里的 MarketDataService（isolate 键互不可见，crypto_funding_rate 自取数
 * 正是为此绕行）；connector 注册则天然走路由选中的数据源，语义正确。
 *
 * 入参 symbol 用市场规范词汇（docs/symbol-vocabulary.md），翻译归连接器。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { presetDefinitions, type IndicatorDefinition } from './presets.ts'
import type { Kline } from './types.ts'

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
