/**
 * @dsh-trading/indicators/plugin —— 指标能力 host 半插件（issue #33 / P4）。
 *
 * patch 行：id `dsh-trading-indicators` / name `@dsh-trading/indicators/plugin`
 * （base 拥有该共享行）。职责：
 * - provide `tradingCustomIndicators` 服务（file store 单实例：桥 GET/DELETE 与
 *   indicator_author 共享同一缓存，避免双实例 stale-flush 分裂）；
 * - host 平面注册 `indicator_author`（从 kit/client-ui-trading 双注册收口）与
 *   `indicator_delete`（新增——桥 DELETE 能力的工具面）；
 * - 写成功 emit tradingEvents('indicators')（issue #30 通道）。
 */
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import os from 'node:os'
import path from 'node:path'
import { createFileCustomIndicatorStore } from './custom-fs.ts'
import type { CustomIndicatorRecord, CustomIndicatorStore } from './custom.ts'
import { createAuthorIndicatorTool } from './tool.ts'

// 桥经本子路径取 file store（knowledge/tool 同款再导出先例）。
export { createFileCustomIndicatorStore }

/** Cordis 插件名 = patch 行 id（TEMPLATES §8）。 */
export const name = 'dsh-trading-indicators'

/** 本插件不硬依赖任何服务。 */
export const inject: string[] = []

/** SDK 服务键：自定义指标 store 单实例（桥与工具共享）。 */
export const TRADING_CUSTOM_INDICATORS_KEY = 'tradingCustomIndicators'

/** tradingEvents 的最小发布面（鸭式；总线缺席时静默降级）。 */
export interface TradingEventsPublisher {
  emit(store: 'indicators'): void
}

/** 默认存储路径：~/.dsh/indicators/custom.json（与 client-ui-trading 旧路径一致）。 */
export function defaultStorePath(): string {
  return path.join(os.homedir(), '.dsh', 'indicators', 'custom.json')
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
      onWritten: () => events()?.emit('indicators'),
    }))
    register(createIndicatorDeleteTool({
      store: deps.store,
      onDeleted: () => events()?.emit('indicators'),
    }))
  })
}

/** Host plugin body：store 服务 provide + 工具注册。 */
export function apply(ctx: Context): void {
  const store = createFileCustomIndicatorStore(defaultStorePath())
  // Service 单实例：桥（GET/DELETE 端点）与工具共享同一缓存。
  new CustomIndicatorsService(ctx, store)
  registerIndicatorsTools(ctx, { store })
}

/** 自定义指标 store 服务（桥与工具的单实例共享点）。 */
export class CustomIndicatorsService extends Service {
  readonly store: CustomIndicatorStore
  constructor(ctx: Context, store: CustomIndicatorStore, serviceName: string = TRADING_CUSTOM_INDICATORS_KEY) {
    super(ctx, serviceName)
    this.store = store
  }
}

// 单测便利再导出。
export type { CustomIndicatorRecord, CustomIndicatorStore }
