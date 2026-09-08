/**
 * @dshtrading/holdings/plugin —— 统一资产台账 host 半插件（issue #65）。
 *
 * patch 行：id `dsh-trading-holdings` / name `@dshtrading/holdings/plugin`
 * （base 拥有该共享行）。职责：
 * - provide `tradingHoldings` 服务（file store + fx 服务单实例：/dshtrading/api
 *   桥的 GET /holdings、GET /fx 与 holdings_stage/holdings_list 共享同一缓存——
 *   client-ui-trading 桥侧经 ctx.get('tradingHoldings') 解包 .store/.fx，
 *   服务缺席回退自建，tradingKnowledgeCards 同款先例）；
 * - host 平面注册 `holdings_stage` / `holdings_confirm` / `holdings_discard` /
 *   `holdings_add` / `holdings_update` / `holdings_remove` / `holdings_list`
 *   （全会话可见；记账面全量可控，与下单闸门无关——契约 §5），
 *   外加只读 `fx_get`（缺口卡 G7：与桥 GET /fx 共享同一 fx 服务实例与缓存）；
 * - 写成功 emit tradingEvents('holdings')（issue #30 通道，SSE store 名 'holdings'）。
 */
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import path from 'node:path'
import { dshHomeDir } from '@dshtrading/dsh-home'
import type { HoldingsStore } from './types.ts'
import type { FxService } from './fx.ts'
import { createFxService } from './fx.ts'
import { createFileHoldingsStore } from './store-fs.ts'
import {
  createFxGetTool,
  createHoldingsAddTool,
  createHoldingsConfirmTool,
  createHoldingsDiscardTool,
  createHoldingsListTool,
  createHoldingsRemoveTool,
  createHoldingsStageTool,
  createHoldingsUpdateTool,
} from './tool.ts'

// 桥经本子路径取 file store 与 fx 服务工厂（knowledge/tool 同款再导出先例）。
export { createFileHoldingsStore, createFxService }

/** Cordis 插件名 = patch 行 id（TEMPLATES §8）。 */
export const name = 'dsh-trading-holdings'

/** 本插件不硬依赖任何服务；tools 经 ctx.inject 声明。 */
export const inject: string[] = []

/** SDK 服务键：台账 store + fx 服务单实例（桥解包 .store/.fx）。 */
export const TRADING_HOLDINGS_KEY = 'tradingHoldings'

/** tradingEvents 的最小发布面（鸭式；总线缺席时静默降级）。 */
export interface TradingEventsPublisher {
  emit(store: 'holdings'): void
}

/** 默认台账路径：$DSH_HOME/holdings/book.json（缺省 ~/.dsh；契约 §2）。 */
export function defaultHoldingsStorePath(): string {
  return path.join(dshHomeDir(), 'holdings', 'book.json')
}

/** 默认 fx 文件缓存路径：$DSH_HOME/holdings/fx-cache.json（契约 §4）。 */
export function defaultFxCachePath(): string {
  return path.join(dshHomeDir(), 'holdings', 'fx-cache.json')
}

export interface HoldingsPluginDeps {
  store: HoldingsStore
  /** 可选：注入后额外注册只读 `fx_get`（缺省不注册，保持既有 7 工具面兼容）。 */
  fx?: FxService
}

export function registerHoldingsTools(ctx: Context, deps: HoldingsPluginDeps): void {
  ctx.inject(['tools'] as never, (toolCtx) => {
    const tools = (toolCtx as unknown as { tools?: { register(t: unknown): void; get(name: string): unknown } }).tools
    if (!tools || typeof tools.register !== 'function') return

    const events = (): TradingEventsPublisher | undefined =>
      (ctx as unknown as { get?: (key: string, strict?: boolean) => unknown }).get?.('tradingEvents', false) as TradingEventsPublisher | undefined

    const register = (tool: ReturnType<typeof defineTool>) => {
      if (tools.get(tool.name) === undefined) tools.register(tool)
    }
    const onWritten = () => events()?.emit('holdings')
    register(createHoldingsStageTool(deps.store, { onWritten }))
    register(createHoldingsConfirmTool(deps.store, { onWritten }))
    register(createHoldingsDiscardTool(deps.store, { onWritten }))
    register(createHoldingsAddTool(deps.store, { onWritten }))
    register(createHoldingsUpdateTool(deps.store, { onWritten }))
    register(createHoldingsRemoveTool(deps.store, { onWritten }))
    register(createHoldingsListTool(deps.store))
    if (deps.fx !== undefined) register(createFxGetTool({ fx: deps.fx }))
  })
}

/** 台账服务（桥与工具的 store/fx 单实例共享点）。 */
export class HoldingsService extends Service {
  readonly store: HoldingsStore
  readonly fx: FxService
  constructor(ctx: Context, store: HoldingsStore, fx: FxService, serviceName: string = TRADING_HOLDINGS_KEY) {
    super(ctx, serviceName)
    this.store = store
    this.fx = fx
  }
}

/** Host plugin body：store + fx 服务 provide + 工具注册。 */
export function apply(ctx: Context): void {
  const store = createFileHoldingsStore(defaultHoldingsStorePath())
  const fx = createFxService({ cacheFilePath: defaultFxCachePath() })
  new HoldingsService(ctx, store, fx)
  registerHoldingsTools(ctx, { store, fx })
}
