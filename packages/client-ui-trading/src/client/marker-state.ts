/**
 * 图表标记状态 store（Issue #41）：管理策略回测信号标记与知识事件图钉的显隐
 * 与数据。仿 chart-state.ts 模式：无依赖可观测 + localStorage 持久化（仅布尔
 * 开关持久化；回测结果为内存态——切标的时清空，不持久化巨量序列数据）。
 *
 * @module marker-state
 */
import { createObservable, readJson, writeJson } from './store.ts'
import type { WritableObservable } from './store.ts'

const MARKER_KEY = 'dshtrading.markers.v1'

/* ── 策略信号标记数据（从 @dsh-trading/strategies 的 BacktestResult 提取） ── */

/** 图表标记用的信号点（轻量子集，不含完整 BacktestResult）。 */
export interface ChartSignalMarker {
  /** K 线 openTime（epoch ms）。 */
  readonly time: number
  /** 信号动作：entry=入场（绿色买入箭头）、exit=出场（红色卖出箭头）。 */
  readonly action: 'entry' | 'exit'
  /** 信号确认时收盘价（展示参考）。 */
  readonly price: number
  /** 人类可读的原因解释（Tooltip 直接展示）。 */
  readonly reason: string
}

/** 图表标记用的交易记录（Tooltip 展示持仓结果）。 */
export interface ChartTradeRecord {
  readonly entryTime: number
  readonly entryPrice: number
  readonly exitTime: number
  readonly exitPrice: number
  readonly returnPercent: number
  readonly profit: number
  readonly holdingBars: number
  readonly exitReason: string
}

/* ── 知识事件标记数据（从 @dsh-trading/knowledge 的 KnowledgeCard 提取） ── */

/** 图表标记用的知识事件点。 */
export interface ChartKnowledgeMarker {
  /** 事件日期（epoch ms，从 source.publishedAt 或 createdAt 解析）。 */
  readonly time: number
  /** 知识卡片标题。 */
  readonly title: string
  /** 卡片 id（点击时查找完整卡片用）。 */
  readonly cardId: string
  /** 可信度。 */
  readonly credibility: 'high' | 'medium' | 'low'
}

/* ── 状态定义 ── */

export interface MarkerState {
  /** 显示策略回测买卖信号标记。 */
  showSignals: boolean
  /** 显示知识研报/事件图钉。 */
  showKnowledgeEvents: boolean
  /** 当前选中的策略 ID（图表内快速回测用）。 */
  activeStrategyId: string | null
}

/** 持久化到 localStorage 的字段子集。 */
interface PersistedMarkerState {
  showSignals: boolean
  showKnowledgeEvents: boolean
  activeStrategyId: string | null
}

function initialState(): MarkerState {
  const persisted = readJson<PersistedMarkerState | null>(MARKER_KEY, null)
  return {
    showSignals: persisted?.showSignals ?? false,
    showKnowledgeEvents: persisted?.showKnowledgeEvents ?? false,
    activeStrategyId: persisted?.activeStrategyId ?? null,
  }
}

export interface MarkerStateStore extends WritableObservable<MarkerState> {
  /** 切换策略信号标记显隐。 */
  toggleSignals(): void
  /** 切换知识事件图钉显隐。 */
  toggleKnowledgeEvents(): void
  /** 设置当前选中策略 ID（null = 清除选中）。 */
  setActiveStrategy(id: string | null): void
}

export function createMarkerStateStore(): MarkerStateStore {
  const store = createObservable<MarkerState>(initialState())

  const persist = (): void => {
    const s = store.getSnapshot()
    writeJson(MARKER_KEY, {
      showSignals: s.showSignals,
      showKnowledgeEvents: s.showKnowledgeEvents,
      activeStrategyId: s.activeStrategyId,
    })
  }

  return {
    ...store,
    toggleSignals() {
      store.update(s => ({ ...s, showSignals: !s.showSignals }))
      persist()
    },
    toggleKnowledgeEvents() {
      store.update(s => ({ ...s, showKnowledgeEvents: !s.showKnowledgeEvents }))
      persist()
    },
    setActiveStrategy(id) {
      store.update(s => ({ ...s, activeStrategyId: id }))
      persist()
    },
  }
}
