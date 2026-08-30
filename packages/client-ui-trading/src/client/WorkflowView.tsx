/**
 * 量化/回测占位视图：中栏第二视图的机制验证（视图注册表切换、互斥
 * 挂载、持久化）。真实回测工作流 UI 待需求落地后按注册表接入——
 * 回测引擎当前是 repo 明确的 non-goal（docs/crypto-slice-plan.md）。
 */
import type { MarketLocaleKey } from './contract.ts'
import css from './stage.module.css'

export type Translate = (key: MarketLocaleKey) => string

export function WorkflowView({ t }: { t: Translate }): React.JSX.Element {
  return (
    <div className={css.workflow}>
      <div className={css.workflowTitle}>{t('workflow.title')}</div>
      <div className={css.workflowHint}>{t('workflow.placeholder')}</div>
      {/* workflow 画布的形态示意：数据 → 策略 → 回测 三节点骨架（纯装饰）。 */}
      <div className={css.workflowNodes} aria-hidden="true">
        <span className={css.workflowNode} />
        <i className={css.workflowLink} />
        <span className={css.workflowNode} />
        <i className={css.workflowLink} />
        <span className={css.workflowNode} />
      </div>
    </div>
  )
}
