/**
 * 中栏视图注册表（issue #34 / P5）：MIDDLE_VIEWS 常量升格为开放注册面。
 *
 * 形态 = cordis client 服务（provide 'tradingStageViews'，仿 client-ui-indicators
 * 的 tradingIndicators）。注册表本身框架无关、零依赖；client-ui-trading 的
 * client apply 里 provide —— 插件 fiber 持有，插件卸载时服务随之注销。
 *
 * 第三方视图包的接入方式（与 tradingIndicators 完全同款）：
 *   ctx.inject(['tradingStageViews'] as never, scope => {
 *     scope.tradingStageViews.register({ id: 'myview', titleKey: 'myview.title', render: ... })
 *   })
 *
 * 跨 bundle 不能用模块级单例：ESM 各 bundle 独立打包，模块单例会双 Map 静默
 * 分裂（indicators/registry.ts 同款教训），共享只能经 cordis 服务单例。同
 * bundle 内的 MiddleStage 直接 import 本模块拿同一实例。
 */
import type { ComponentType } from 'react'
import type { MarketLocaleKey } from './contract.ts'

/** 视图组件收到的运行时面：t 为 dshtrading.market 词典的翻译函数。 */
export interface StageViewProps {
  t: (key: MarketLocaleKey) => string
  /** 中栏当前视图 id（useSyncExternalStore 驱动的响应式值）。 */
  view: string
}

/**
 * 一个中栏 tab 的注册 definition：id 全仓唯一（'quote' 保留给 shell 行情视图，
 * 第三方不得仿冒——与闸门正则同款词汇纪律）。
 */
export interface StageViewDefinition {
  /** 稳定 id：localStorage 持久化值 + tab 排序基准。 */
  id: string
  /** tab 文案（dshtrading.market 词典 key）。 */
  titleKey: MarketLocaleKey
  /** 排序权重：quote 固定 0，插件视图从 10 起步（插入顺序为次级排序）。 */
  order?: number
  /** 视图组件（互斥挂载：切走即卸载，图表态由视图自己持久化承接）。 */
  render: ComponentType<StageViewProps>
}

export interface StageViewRegistry {
  /** 注册视图；同 id 覆盖（重载友好），并通知订阅者。未知/保留 id 拒绝。 */
  register(definition: StageViewDefinition): void
  /** 注销视图；未知 id 静默跳过。 */
  unregister(id: string): void
  /** 全部已注册视图（order 升序，次级按注册序）。 */
  list(): StageViewDefinition[]
  get(id: string): StageViewDefinition | undefined
  /** 订阅名册变化；返回退订函数。 */
  subscribe(listener: () => void): () => void
  /** 名册修订号（单调递增），配合 subscribe 供 useSyncExternalStore。 */
  getVersion(): number
}

/** shell 保留 id：行情视图是 registry 的内建种子条目，第三方不得占用。 */
export const RESERVED_STAGE_VIEW_ID = 'quote'

export function createStageViewRegistry(): StageViewRegistry {
  /** 注册序号 = 次级排序键（order 相同时先到先得）。 */
  const entries = new Map<string, { definition: StageViewDefinition; seq: number }>()
  const listeners = new Set<() => void>()
  let version = 0
  let seq = 0

  // 内建种子：quote 视图（tab 条从名册统一渲染；render 不会被调用——
  // MiddleStage 对 quote 走 QuoteStage 直引面）。种子在工厂内写入，
  // 绕过公开 register 的保留 id 检查。
  entries.set(RESERVED_STAGE_VIEW_ID, {
    definition: {
      id: RESERVED_STAGE_VIEW_ID,
      titleKey: 'stage.quote',
      order: 0,
      render: () => { throw new Error('quote view is built into the shell (MiddleStage direct mount)') },
    },
    seq: seq++,
  })

  return {
    register(definition) {
      if (definition.id === RESERVED_STAGE_VIEW_ID) {
        throw new Error(`stage view id "${RESERVED_STAGE_VIEW_ID}" is reserved for the shell quote view`)
      }
      entries.set(definition.id, { definition, seq: seq++ })
      version += 1
      for (const listener of listeners) listener()
    },
    unregister(id) {
      if (!entries.delete(id)) return
      version += 1
      for (const listener of listeners) listener()
    },
    list() {
      return [...entries.values()]
        .sort((a, b) => (a.definition.order ?? 10) - (b.definition.order ?? 10) || a.seq - b.seq)
        .map(entry => entry.definition)
    },
    get: id => entries.get(id)?.definition,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    getVersion: () => version,
  }
}

/** client-ui-trading 的单例注册表（apply 时 provide 为 tradingStageViews 服务）。 */
export const stageViews = createStageViewRegistry()