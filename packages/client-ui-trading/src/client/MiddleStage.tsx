/**
 * 中栏舞台：中栏 = 视图注册表 + 顶部切换条（行情 | 策略 | 知识库）。
 * 视图注册表是中栏的扩展点——各视图按 definition 追加，与行情视图并列切换；
 * 同一时刻仅挂载活动视图（切换即卸载，图表态由 store/localStorage 承接，后台视图零渲染开销）。
 */
import { useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { readJson, writeJson } from './store.ts'
import { QuoteStage } from './QuoteStage.tsx'
import { StrategyView } from './StrategyView.tsx'
import { KnowledgeView } from './KnowledgeView.tsx'
import type { MarketLocaleKey } from './contract.ts'
import type { ChartState } from './chart-state.ts'
import type { Observable, SelectionState } from './store.ts'
import css from './stage.module.css'

export type MiddleViewId = 'quote' | 'strategy' | 'knowledge'

export interface MiddleViewDefinition {
  id: MiddleViewId
  titleKey: MarketLocaleKey
}

/** 中栏视图注册表：行情 | 策略 | 知识库。 */
export const MIDDLE_VIEWS: readonly MiddleViewDefinition[] = [
  { id: 'quote', titleKey: 'stage.quote' },
  { id: 'strategy', titleKey: 'stage.strategy' },
  { id: 'knowledge', titleKey: 'stage.knowledge' },
]

const STAGE_KEY = 'dshtrading.stage.v1'

function readStageView(): MiddleViewId {
  const raw = readJson<unknown>(STAGE_KEY, 'quote')
  return MIDDLE_VIEWS.some(view => view.id === raw) ? raw as MiddleViewId : 'quote'
}

function writeStageView(view: MiddleViewId): void {
  writeJson(STAGE_KEY, view)
}

/** Registration-side business face. */
export interface MiddleStageInjected {
  hooks: {
    selection: Observable<SelectionState>
    chart: Observable<ChartState>
  }
  toggleIndicator: (id: string) => void
  setIndicatorParams: (id: string, params: Record<string, number>) => void
  /** 删除自定义指标（issue #30，透传给 QuoteStage 指标选择器）。 */
  deleteIndicator: (id: string) => Promise<boolean>
}

export type MiddleStageProps =
  PropsRuntime<'shell.overlay'>
  & PropsLocale<'dshtrading.market'>
  & InjectFace<MiddleStageInjected>

export function MiddleStage({ t, useSelection, useChart, toggleIndicator, setIndicatorParams, deleteIndicator }: MiddleStageProps) {
  const [view, setView] = useState<MiddleViewId>(readStageView)

  const switchView = (next: MiddleViewId): void => {
    setView(next)
    writeStageView(next)
  }

  return (
    <div className={css.root} data-dshtrading-middle-stage="">
      <div className={css.tabs} role="tablist" aria-label="stage">
        {MIDDLE_VIEWS.map(definition => (
          <button
            key={definition.id}
            type="button"
            role="tab"
            aria-selected={definition.id === view}
            className={css.tab}
            data-active={definition.id === view ? 'true' : undefined}
            onClick={() => { switchView(definition.id) }}
          >
            {t(definition.titleKey)}
          </button>
        ))}
      </div>
      {/* 视图互斥挂载：切走即卸载（图表重建成本 < 双图常驻的内存/重绘成本）。
          prop 面沿用 QuotePane→QuoteStage 的 inject 传递约定（cast 收敛在边界）。 */}
      {view === 'quote' ? (
        <QuoteStage {...({ t, useSelection, useChart, toggleIndicator, setIndicatorParams, deleteIndicator } as never)} />
      ) : view === 'strategy' ? (
        <StrategyView t={t} useSelection={useSelection} />
      ) : (
        <KnowledgeView t={t} />
      )}
    </div>
  )
}
