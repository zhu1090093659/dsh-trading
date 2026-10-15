/**
 * 插件入口（host 平面数据行 + agent 工具行；市场无关的跨市场信息源 → 归 base 所有，README 铁律 #1）。
 *
 * 为什么在 host 平面而不是某个市场的 preset 平面：FOMC 决议概率是**跨市场**信息
 * （美联储路径影响 crypto / us / cn / hk / global 全部会话），任何单一市场都不该
 * 独家拥有它；host 行注册一次全会话可见（与 @dshtrading/connector-jin10 同款形态，
 * 2026-09-13 先例）。
 *
 * 凭证：**无**。Polymarket gamma 是公开只读 API，本连接器不引入任何密钥，
 * 也不触达下单/交易端点（只用 `/events`）。
 *
 * 快照落盘：trading home 下（`@dshtrading/dsh-home` 解析），不写包内、不写仓库数据。
 */
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { GammaClient, DEFAULT_TIMEOUT_MS } from './gamma.js'
import { TRADING_PREDICTION_FEED_KEY, PolymarketService, createPolymarketPredictionFeed } from './service.js'
import { SnapshotStore } from './snapshot.js'
import { createPolymarketTools } from './tools.js'

/** Cordis 插件名 = patch 行 id（TEMPLATES §8）。 */
export const name = 'dsh-trading-connector-polymarket'

/** 注册 agent 工具面需要宿主 tools 服务（与 connector-jin10 同款；缺 inject 会让整棵树加载失败）。 */
export const inject = ['tools']

export interface Config {
  enabled: boolean
  /** 单次 gamma 请求超时（ms）。 */
  timeoutMs: number
  /** 是否启用本地快照（Δ 标注）。关闭后 `changeSincePrevious` 一律缺省。 */
  snapshots: boolean
  /** 快照文件覆盖（绝对路径；缺省 `$DSH_HOME/polymarket/snapshots.json`）。 */
  snapshotPath: string
}

export const Config: Schema<Config> = Schema.object({
  enabled: Schema.boolean().default(true).description('是否启用 Polymarket 预测市场数据面'),
  timeoutMs: Schema.number().default(DEFAULT_TIMEOUT_MS).description('单次 gamma-api 请求超时（ms）'),
  snapshots: Schema.boolean().default(true).description('是否用本地快照标注概率变动（存 trading home）'),
  snapshotPath: Schema.string().default('').description('快照文件绝对路径（留空 = $DSH_HOME/polymarket/snapshots.json）'),
})

export interface ApplyOverrides {
  /** 注入的 fetch（单测用契约化替身）。 */
  readonly fetchImpl?: typeof globalThis.fetch
  /** 基址覆盖（单测指向本地夹具服务）。 */
  readonly baseUrl?: string
  /** 时钟注入（单测固定 fetchedAt）。 */
  readonly now?: (() => number) | undefined
}

/** 组装取数服务（测试可直接注入 fetchImpl，无需 mock 全局）。 */
export function createPolymarketService(config: Config, overrides: ApplyOverrides = {}): PolymarketService {
  const gamma = new GammaClient({
    timeoutMs: config.timeoutMs,
    ...(overrides.fetchImpl !== undefined ? { fetchImpl: overrides.fetchImpl } : {}),
    ...(overrides.baseUrl !== undefined ? { baseUrl: overrides.baseUrl } : {}),
  })
  const snapshots = config.snapshots
    ? new SnapshotStore(config.snapshotPath === '' ? {} : { filePath: config.snapshotPath })
    : undefined
  return new PolymarketService({
    gamma,
    ...(snapshots !== undefined ? { snapshots } : {}),
    ...(overrides.now !== undefined ? { now: overrides.now } : {}),
  })
}

/**
 * 插件钩子（宿主签名 `apply(ctx, config)`）。
 *
 * **一个 service 实例供两处消费**：桥/面板面（`tradingPredictionFeed`）与 agent 工具面
 * 共用下面这个 `service`——两份取数逻辑漂移是这类数据面最容易犯的错（同一场会议在面板
 * 与工具里给出不同概率）。工具用同名先到先得注册，不覆盖别人的工具。
 *
 * 不接收注入参数：测试用的 fetch/时钟替身走 {@link createPolymarketService}，不往
 * 生产钩子的签名里加测试专用面（connector-jin10 同款纪律）。
 */
export function apply(ctx: Context, config: Config): void {
  if (!config.enabled) return
  const service = createPolymarketService(config)
  ctx.reflect.provide(TRADING_PREDICTION_FEED_KEY, createPolymarketPredictionFeed(service))
  const tools = ctx.tools as unknown as { register(definition: unknown): void; get(name: string): unknown }
  for (const tool of createPolymarketTools(service)) {
    // 同名先到先得，绝不重复注册（dsh-tools 对同名重复注册直接抛错）。
    if (tools.get(tool.name) === undefined) tools.register(tool)
  }
}
