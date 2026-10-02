import type { Card, CardAction } from '@dshtrading/contract'
import { useState } from 'react'
import styles from './cockpit.module.css'
import { DecisionFeed, DeskHome, EscalationInbox, MandateAndLedger, PositionsAndOrders, SystemNotices, UnknownCards, freshnessText, type CockpitCard } from './blocks.tsx'

/**
 * 驾驶舱外壳（**纯展示**）：数据与副作用都在 App.tsx 里，这里只决定"给定数据与错误，长什么样"。
 *
 * 抽出来的理由是一条卡片证据：**行情与 agent 全挂时控制面仍可用**。控制区（pause/resume/kill/flatten）
 * 与 A0 同源，不该依赖数据面 —— 所以它必须渲染在 error 分支**之外**，并且这条性质要能被断言
 * （而不是靠"看代码觉得应该没事"）。
 *
 * A0 六项的界面可达（2026-10-02 补全）：kill/pause/resume + flatten 在控制区；**ack / 升级应答**
 * 走卡片动作（CardView 接线，App 层 POST /v1/commands）；**status** 由 desk/risk-state/freshness 卡
 * 表达；**ping** 的连通性由刷新按钮表达（失败即 error 条）。
 */
export interface CockpitShellProps {
  readonly cards: readonly Card[]
  readonly error: string | undefined
  readonly fetchedAtMs: number | undefined
  readonly nowMs: number
  readonly pending: string | undefined
  readonly onRefresh: () => void
  readonly onCommand: (action: string) => void
  /** 卡片动作接线（升级应答 approve/reject、ack、dismiss、retry-sync 等走这里）。 */
  readonly onCardAction: (action: CardAction, card: CockpitCard) => void
  /** 设备令牌；未配对时渲染配对表单而不是卡片。 */
  readonly token: string | undefined
  readonly onPair: (code: string, name: string) => void
  readonly onUnpair: () => void
}

/** 配对表单（纯展示）：一次性配对码 + 设备名；control 由运维授予，界面如实说明。 */
export function PairingPanel({ onPair }: { readonly onPair: (code: string, name: string) => void }): JSX.Element {
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  return (
    <section className={styles.section} aria-label="pairing">
      <h2 className={styles.sectionTitle}>配对本机</h2>
      <p className={styles.note}>
        输入运维在 bot 侧签发的一次性配对码。配对只拿到 read + command；kill/pause/resume/flatten
        这类 control 动作仍需运维在 bot 侧用 grant-control 显式授予。
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          if (code.trim() !== '') onPair(code, name)
        }}
      >
        <input aria-label="配对码" value={code} onChange={(e) => setCode(e.target.value)} placeholder="配对码" />{' '}
        <input aria-label="设备名" value={name} onChange={(e) => setName(e.target.value)} placeholder="设备名（可空）" />{' '}
        <button type="submit" className={styles.button} disabled={code.trim() === ''}>
          配对
        </button>
      </form>
    </section>
  )
}

/** 控制面上的四个动作（顺序固定：先软后硬，kill/flatten 在后）。 */
export const CONTROL_ACTIONS = ['pause', 'resume', 'kill', 'flatten'] as const

export function CockpitShell(props: CockpitShellProps): JSX.Element {
  const cards = props.cards as readonly CockpitCard[]
  if (props.token === undefined) {
    return (
      <main className={styles.page}>
        <header>
          <h1 className={styles.title}>交易驾驶舱</h1>
          <p className={styles.subtitle}>尚未配对：本机还没有设备令牌，配对后才能读取 bot 的卡片。</p>
        </header>
        {props.error === undefined ? null : (
          <p className={styles.error} role="alert">
            {props.error}
          </p>
        )}
        <PairingPanel onPair={props.onPair} />
      </main>
    )
  }
  return (
    <main className={styles.page}>
      <header>
        <h1 className={styles.title}>交易驾驶舱</h1>
        <p className={styles.subtitle}>
          服务端驱动：界面由卡片协议决定，客户端只渲染。{freshnessText(props.fetchedAtMs, props.nowMs)}
        </p>
        <button type="button" className={styles.button} onClick={props.onRefresh}>
          刷新
        </button>{' '}
        <button type="button" className={styles.button} onClick={props.onUnpair}>
          解除配对
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
      <DeskHome cards={cards} onAction={props.onCardAction} disabled={props.pending !== undefined} />
      <DecisionFeed cards={cards} onAction={props.onCardAction} disabled={props.pending !== undefined} />
      <PositionsAndOrders cards={cards} onAction={props.onCardAction} disabled={props.pending !== undefined} />
      <MandateAndLedger cards={cards} onAction={props.onCardAction} disabled={props.pending !== undefined} />
      <EscalationInbox cards={cards} onAction={props.onCardAction} disabled={props.pending !== undefined} />
      <SystemNotices cards={cards} onAction={props.onCardAction} disabled={props.pending !== undefined} />
    </main>
  )
}
