/**
 * @dshtrading/indicators/plugin —— 指标能力 host 半插件（issue #33 / P4）。
 *
 * patch 行：id `dsh-trading-indicators` / name `@dshtrading/indicators/plugin`
 * （base 拥有该共享行）。职责：
 * - provide `tradingCustomIndicators` / `tradingChartActivations` 服务（file store
 *   单实例：桥与工具共享同一缓存，避免双实例 stale-flush 分裂）；
 * - host 平面注册 `indicator_author`（从 kit/client-ui-trading 双注册收口）、
 *   `indicator_delete`（桥 DELETE 能力的工具面）与 `indicator_list` /
 *   `indicator_activate` / `indicator_deactivate`（issue #63 图表激活名册工具面）；
 * - 写成功 emit tradingEvents('indicators' | 'chart')（issue #30 通道，issue #63 扩展）。
 */
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import os from 'node:os'
import path from 'node:path'
import { createFileCustomIndicatorStore } from './custom-fs.ts'
import type { CustomIndicatorRecord, CustomIndicatorStore } from './custom.ts'
import type { ChartActivationStore } from './chart-activations.ts'
import { createFileChartActivationStore } from './chart-activations-fs.ts'
import { createChartActivationTools } from './chart-tools.ts'
import { createAuthorIndicatorTool } from './tool.ts'

// 桥经本子路径取 file store（knowledge/tool 同款再导出先例）。
export { createFileCustomIndicatorStore }
export { createFileChartActivationStore }

/** Cordis 插件名 = patch 行 id（TEMPLATES §8）。 */
export const name = 'dsh-trading-indicators'

/** 本插件不硬依赖任何服务。 */
export const inject: string[] = []

/** SDK 服务键：自定义指标 store 单实例（桥与工具共享）。 */
export const TRADING_CUSTOM_INDICATORS_KEY = 'tradingCustomIndicators'

/** SDK 服务键：图表激活名册 store 单实例（issue #63，桥与工具共享）。 */
export const TRADING_CHART_ACTIVATIONS_KEY = 'tradingChartActivations'

/** tradingEvents 的最小发布面（鸭式；总线缺席时静默降级）。 */
export interface TradingEventsPublisher {
  emit(store: 'indicators' | 'chart'): void
}

/** 默认存储路径：~/.dsh/indicators/custom.json（与 client-ui-trading 旧路径一致）。 */
export function defaultStorePath(): string {
  return path.join(os.homedir(), '.dsh', 'indicators', 'custom.json')
}

/** 默认激活名册路径：~/.dsh/indicators/chart.json（issue #63）。 */
export function defaultChartStorePath(): string {
  return path.join(os.homedir(), '.dsh', 'indicators', 'chart.json')
}

export interface IndicatorDeleteToolOptions {
  store: CustomIndicatorStore
  onDeleted?: (id: string, removed: boolean) => void
}

/** indicator_delete 工厂（issue #33 新增；对应桥 DELETE /indicators/custom 能力）。 */
export function createIndicatorDeleteTool(options: IndicatorDeleteToolOptions) {
  const { store, onDeleted } = options
  return defineTool({
    name: 'indicator_delete',
    description:
      'Delete a custom technical indicator by id (the persisted definition is removed from the library; '
      + 'preset indicators cannot be deleted). The open GUI chart roster refreshes live over the SSE channel.',
    parameters: {
      id: {
        type: 'string',
        required: true,
        description: 'Custom indicator id to delete (authored via indicator_author)',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(raw) {
      const args = (raw ?? {}) as { id?: unknown }
      const id = typeof args.id === 'string' ? args.id.trim() : ''
      if (!id) {
        throw new Error('indicator_delete: id is required')
      }
      const removed = await store.remove(id)
      onDeleted?.(id, removed)
      return JSON.stringify({
        ok: true,
        removed,
        note: removed
          ? `Deleted custom indicator "${id}".`
          : `"${id}" was not found in the custom indicator library (presets cannot be deleted).`,
      })
    },
  })
}

export interface IndicatorsPluginDeps {
  store: CustomIndicatorStore
  /** 可选：图表激活名册 store（issue #63；缺席时激活工具族不注册）。 */
  chartStore?: ChartActivationStore
}

export function registerIndicatorsTools(ctx: Context, deps: IndicatorsPluginDeps): void {
  ctx.inject(['tools'] as never, (toolCtx) => {
    const tools = (toolCtx as unknown as { tools?: { register(t: unknown): void; get(name: string): unknown } }).tools
    if (!tools || typeof tools.register !== 'function') return

    const events = (): TradingEventsPublisher | undefined =>
      (ctx as unknown as { get?: (key: string, strict?: boolean) => unknown }).get?.('tradingEvents', false) as TradingEventsPublisher | undefined

    const register = (tool: ReturnType<typeof defineTool>) => {
      if (tools.get(tool.name) === undefined) tools.register(tool)
    }
    register(createAuthorIndicatorTool({
      store: deps.store,
      chartStore: deps.chartStore,
      onWritten: () => { events()?.emit('indicators') },
      onActivated: () => { events()?.emit('chart') },
    }))
    register(createIndicatorDeleteTool({
      store: deps.store,
      onDeleted: () => events()?.emit('indicators'),
    }))
    // 图表激活名册工具族（issue #63）：写成功 emit('chart')，GUI 经 SSE 即时同步。
    if (deps.chartStore !== undefined) {
      const chartTools = createChartActivationTools({
        customStore: deps.store,
        chartStore: deps.chartStore,
        onWritten: () => { events()?.emit('chart') },
        onDeleted: () => { events()?.emit('chart') },
      })
      register(chartTools.list)
      register(chartTools.activate)
      register(chartTools.deactivate)
    }
  })
}

/** Host plugin body：store 服务 provide + 工具注册。 */
export function apply(ctx: Context): void {
  const store = createFileCustomIndicatorStore(defaultStorePath())
  const chartStore = createFileChartActivationStore(defaultChartStorePath())
  // Service 单实例：桥（GET/DELETE 端点）与工具共享同一缓存。
  new CustomIndicatorsService(ctx, store)
  new ChartActivationsService(ctx, chartStore)
  registerIndicatorsTools(ctx, { store, chartStore })
}

/** 自定义指标 store 服务（桥与工具的单实例共享点）。 */
export class CustomIndicatorsService extends Service {
  readonly store: CustomIndicatorStore
  constructor(ctx: Context, store: CustomIndicatorStore, serviceName: string = TRADING_CUSTOM_INDICATORS_KEY) {
    super(ctx, serviceName)
    this.store = store
  }
}

/** 图表激活名册 store 服务（issue #63，桥与工具的单实例共享点）。 */
export class ChartActivationsService extends Service {
  readonly store: ChartActivationStore
  constructor(ctx: Context, store: ChartActivationStore, serviceName: string = TRADING_CHART_ACTIVATIONS_KEY) {
    super(ctx, serviceName)
    this.store = store
  }
}

// 单测便利再导出。
export type { CustomIndicatorRecord, CustomIndicatorStore }
