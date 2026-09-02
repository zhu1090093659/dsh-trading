/**
 * 中栏舞台：中栏 = 视图注册表 + 顶部切换条（行情 | 策略 | 知识库 | …）。
 *
 * 视图注册表是中栏的开放扩展点（issue #34 / P5）：quote 视图由 shell 自注册
 * 到 registry；策略/知识视图由 client-ui-strategies / client-ui-knowledge 经
 * tradingStageViews 服务注册。任何 client 插件 inject 该服务 register 即新增
 * 中栏 tab。同一时刻仅挂载活动视图（切换即卸载，图表态由 store/localStorage
 * 承接，后台视图零渲染开销）。
 */
import { useState, useSyncExternalStore } from 'react'
import type { ComponentType } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { readJson, writeJson } from './store.ts'
import { stageViews } from './stage-views.ts'
import { QuoteStage } from './QuoteStage.tsx'
import type { SendToAgentFn } from './send-to-agent.ts'
import type { MarketLocaleKey } from './contract.ts'
import type { ChartState } from './chart-state.ts'
import type { Observable, SelectionState } from './store.ts'
import css from './stage.module.css'

/** 插件视图的注册 definition 形状（quote 由 shell 内建，不走此面）。 */
export interface MiddleViewDefinition {
  id: string
  titleKey: MarketLocaleKey
  order?: number
  render: ComponentType<import('./stage-views.ts').StageViewProps>
}

const STAGE_KEY = 'dshtrading.stage.v1'

function isRegisteredView(raw: unknown): boolean {
  return typeof raw === 'string' && stageViews.get(raw) !== undefined
}

function readStageView(): string {
  const raw = readJson<unknown>(STAGE_KEY, 'quote')
  // 持久化值指向未安装的插件视图（卸载场景）→ 回落 quote。
  return isRegisteredView(raw) ? raw as string : 'quote'
}

function writeStageView(view: string): void {
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
  /** 行情上下文 → 当前会话（透传给 QuoteStage「发给 Agent」）。 */
  sendToAgent?: SendToAgentFn
}

export type MiddleStageProps =
  PropsRuntime<'shell.overlay'>
  & PropsLocale<'dshtrading.market'>
  & InjectFace<MiddleStageInjected>

export function MiddleStage({ t, useSelection, useChart, toggleIndicator, setIndicatorParams, deleteIndicator, sendToAgent }: MiddleStageProps) {
  // 名册响应式：registry 版本号驱动 tab 条重渲染；当前视图是普通 state
  // （readStageView 净化 localStorage 脏值）。
  useSyncExternalStore(stageViews.subscribe, stageViews.getVersion)
  const [view, setView] = useState<string>(readStageView)

  const switchView = (next: string): void => {
    setView(next)
    writeStageView(next)
  }

  return (
    <div className={css.root} data-dshtrading-middle-stage="">
      <div className={css.tabs} role="tablist" aria-label="stage">
        {stageViews.list().map(definition => (
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
          prop 面沿用 QuotePane→QuoteStage 的 inject 传递约定（cast 收敛在边界）。
          quote 视图 = shell 内建（QuoteStage 直引——需要中栏全部指标动作面）；
          插件视图走 definition.render(props)。 */}
      {view === 'quote' ? (
        <QuoteStage {...({ t, useSelection, useChart, toggleIndicator, setIndicatorParams, deleteIndicator, sendToAgent } as never)} />
      ) : (
        (() => {
          const definition = stageViews.get(view)
          if (definition === undefined) return null
          const View = definition.render
          return <View t={t} view={view} />
        })()
      )}
    </div>
  )
}