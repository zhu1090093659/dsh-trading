import type { Card } from '@dshtrading/contract'
import styles from './cockpit.module.css'
import { DecisionFeed, DeskHome, EscalationInbox, PositionsAndOrders, UnknownCards, freshnessText, type CockpitCard } from './blocks.tsx'

/**
 * 驾驶舱外壳（**纯展示**）：数据与副作用都在 App.tsx 里，这里只决定"给定数据与错误，长什么样"。
 *
 * 抽出来的理由是一条卡片证据：**行情与 agent 全挂时控制面仍可用**。控制区（pause/resume/kill/flatten）
 * 与 A0 同源，不该依赖数据面 —— 所以它必须渲染在 error 分支**之外**，并且这条性质要能被断言
 * （而不是靠"看代码觉得应该没事"）。
 */
export interface CockpitShellProps {
  readonly cards: readonly Card[]
  readonly error: string | undefined
  readonly fetchedAtMs: number | undefined
  readonly nowMs: number
  readonly pending: string | undefined
  readonly onRefresh: () => void
  readonly onCommand: (action: string) => void
}

/** 控制面上的四个动作（顺序固定：先软后硬，kill/flatten 在后）。 */
export const CONTROL_ACTIONS = ['pause', 'resume', 'kill', 'flatten'] as const

export function CockpitShell(props: CockpitShellProps): JSX.Element {
  const cards = props.cards as readonly CockpitCard[]
  return (
    <main className={styles.page}>
      <header>
        <h1 className={styles.title}>交易驾驶舱</h1>
        <p className={styles.subtitle}>
          服务端驱动：界面由卡片协议决定，客户端只渲染。{freshnessText(props.fetchedAtMs, props.nowMs)}
        </p>
        <button type="button" className={styles.button} onClick={props.onRefresh}>
          刷新
        </button>
      </header>
      <section aria-label="control">
        <h2>控制</h2>
        <p className={styles.note}>控制类动作需要二次确认；此处不提供下单入口。</p>
        {CONTROL_ACTIONS.map((action) => (
          <button key={action} type="button" className={styles.buttonControl + ' ' + styles.button} disabled={props.pending !== undefined} onClick={() => props.onCommand(action)}>
            {props.pending === action ? '执行中…' : action}
          </button>
        ))}
      </section>
      {props.error === undefined ? null : (
        <p className={styles.error} role="alert">
          {props.error}
        </p>
      )}
      <UnknownCards cards={cards} />
      <DeskHome cards={cards} />
      <DecisionFeed cards={cards} />
      <PositionsAndOrders cards={cards} />
      <EscalationInbox cards={cards} />
    </main>
  )
}
