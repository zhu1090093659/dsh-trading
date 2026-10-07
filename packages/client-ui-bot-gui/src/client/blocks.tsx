/**
 * @dshtrading/client-ui-bot-gui 纯卡片展示块。
 * 复用 satellite packages/cockpit/src/blocks.tsx 设计，提取为参数化 t 函数国际化支持。
 * 零第三方依赖。
 */
// Pure React block components
import { useMemo, useState } from 'react'
import { CARD_TYPES, type Card, type CardAction, type CardField } from './contract.ts'
import styles from './cockpit.module.css'

/** 决策记录每页最多展示的条数（owner 定：5 条）。 */
export const DECISION_PAGE_SIZE = 5

/** 机器人当前运行档位（由卡片协议的通道字段推导，客户端不发明数据）。 */
export type RunMode = 'paper' | 'dry-run' | 'unknown'

/**
 * 从卡片推导运行档位：取**最新**的 trigger-trace 卡（freshnessMs 最小，平局取数组靠后者 =
 * journal 更靠尾部 = 更新），读它的通道字段。
 * - %%'demo'%% / %%'paper'%% → paper（模拟盘真实派发）；
 * - %%'dry-run'%% / %%'shadow'%% → dry-run（只记录意图）；
 * - 没有任何通道证据 → unknown（不猜）。
 *
 * 为什么不另开接口：档位已经由服务端按卡片协议下发（投影器把 %%trigger.dispatch.*%% 的
 * %%channel%%/%%mode%% 写进字段），客户端照字段渲染即与服务端同源，不发明第二套事实。
 */
export function detectRunMode(cards: readonly CockpitCard[]): RunMode {
  let latest: { readonly freshness: number; readonly paper: boolean } | undefined
  for (let index = 0; index < cards.length; index += 1) {
    const card = cards[index]
    if (card === undefined || card.cardType !== 'trigger-trace') continue
    const channel = card.fields.find((f) => f.key === 'channel' || f.key === 'mode')
    if (channel === undefined) continue
    const value = String(channel.value)
    const paper = value === 'demo' || value === 'paper'
    const dryRun = value === 'dry-run' || value === 'shadow'
    if (!paper && !dryRun) continue
    const freshness = card.freshnessMs ?? Number.MAX_SAFE_INTEGER
    if (latest === undefined || freshness <= latest.freshness) {
      latest = { freshness, paper }
    }
  }
  if (latest === undefined) return 'unknown'
  return latest.paper ? 'paper' : 'dry-run'
}

export interface CockpitCard extends Card {
  readonly operable?: boolean | undefined
  readonly problems?: readonly string[] | undefined
}

export type CardActionHandler = (action: CardAction, card: CockpitCard) => void

export interface BlockRenderProps {
  readonly onAction?: CardActionHandler | undefined
  readonly disabled?: boolean | undefined
  readonly t: (key: string, params?: Record<string, unknown>) => string
}

export function fieldValueText(field: CardField, t: (key: string) => string): string {
  const raw = field.value
  switch (field.kind) {
    case 'timestamp':
      return typeof raw === 'number' ? new Date(raw).toISOString() : String(raw)
    case 'duration':
      return typeof raw === 'number' ? String(raw) + (field.unit ?? 'ms') : String(raw)
    case 'bool':
      return raw === true ? t('bot.boolean.true') : raw === false ? t('bot.boolean.false') : String(raw)
    case 'currency':
      return String(raw) + (field.unit ?? '')
    case 'percent':
      return String(raw) + (field.unit ?? '%')
    default:
      return String(raw)
  }
}

export function freshnessText(fetchedAtMs: number | undefined, nowMs: number, t: (key: string, params?: Record<string, unknown>) => string): string {
  if (fetchedAtMs === undefined) return t('bot.noData')
  const seconds = Math.max(0, Math.round((nowMs - fetchedAtMs) / 1000))
  if (seconds < 5) return t('bot.dataFresh', { sec: seconds })
  if (seconds < 60) return t('bot.dataRecent', { sec: seconds })
  return t('bot.dataStale', { min: Math.round(seconds / 60) })
}

export function CardView({ card, onAction, disabled = false, t }: { readonly card: CockpitCard } & BlockRenderProps): JSX.Element {
  const operable = card.operable !== false
  return (
    <li
      className={operable ? styles.card : styles.card + ' ' + styles.cardInoperable}
      data-card-id={card.cardId}
      data-card-type={card.cardType}
      data-operable={operable ? 'true' : 'false'}
    >
      <strong>{card.cardType}</strong>
      <span className={styles.cardMeta}> · rev {card.revision}</span>
      <p className={styles.cardBody}>{card.fallbackText}</p>
      {card.fields.length > 0 ? (
        <ul className={styles.fields}>
          {card.fields.map((field) => (
            <li key={field.key} className={styles.fieldRow} data-field-kind={field.kind}>
              <span className={styles.fieldLabel}>{field.label}</span>
              <span className={styles.fieldValue}>{fieldValueText(field, t)}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <div className={styles.actions} role="group" aria-label="card actions">
        {card.actions.length === 0 ? (
          <span className={styles.note}>{t('bot.noActions')}</span>
        ) : (
          <>
            <span className={styles.fieldLabel}>{t('bot.quickAction')}</span>
            {card.actions.map((action) => (
              <button
                key={action.kind}
                type="button"
                className={styles.button}
                disabled={disabled || !operable}
                onClick={() => onAction?.(action, card)}
              >
                {action.label}
              </button>
            ))}
          </>
        )}
      </div>
      {operable ? null : (
        <p className={styles.warning} role="status">
          {t('bot.upgradePrompt')}
        </p>
      )}
    </li>
  )
}

export function DeskHome({ cards, onAction, disabled, t }: { readonly cards: readonly CockpitCard[] } & BlockRenderProps): JSX.Element {
  const home = cards.filter((c) => c.cardType === 'desk-summary' || c.cardType === 'risk-state' || c.cardType === 'freshness')
  return (
    <section className={styles.section} aria-label="desk-home">
      <h2 className={styles.sectionTitle}>{t('bot.deskHome')}</h2>
      {home.length === 0 ? <p className={styles.note}>{t('bot.deskEmpty')}</p> : <ul className={styles.list}>{home.map((card) => <CardView key={card.cardId} card={card} onAction={onAction} disabled={disabled} t={t} />)}</ul>}
    </section>
  )
}

export function DecisionFeed({ cards, onAction, disabled, t }: { readonly cards: readonly CockpitCard[] } & BlockRenderProps): JSX.Element {
  const feed = cards.filter((c) => c.cardType === 'decision' || c.cardType === 'trigger-trace')
  // 最新在前：服务端按 journal 顺序（旧→新）下发，反转成新→旧再切页，第 1 页即最新记录。
  const newestFirst = useMemo(() => [...feed].reverse(), [cards, feed.length])
  const totalPages = Math.max(1, Math.ceil(newestFirst.length / DECISION_PAGE_SIZE))
  // 渲染期收敛页码：数据变少时 current 自动回缩，不靠 effect 回写。
  const [requestedPage, setPage] = useState(1)
  const current = Math.min(requestedPage, totalPages)
  const start = (current - 1) * DECISION_PAGE_SIZE
  const visible = newestFirst.slice(start, start + DECISION_PAGE_SIZE)
  return (
    <section className={styles.section} aria-label="decision-feed">
      <h2 className={styles.sectionTitle}>{t('bot.decisionFeed')}</h2>
      {feed.length === 0 ? (
        <p className={styles.note}>{t('bot.decisionEmpty')}</p>
      ) : (
        <>
          <ul className={styles.list}>
            {visible.map((card) => (
              <CardView key={card.cardId} card={card} onAction={onAction} disabled={disabled} t={t} />
            ))}
          </ul>
          {totalPages > 1 ? (
            <nav className={styles.pager} aria-label="decision-feed-pager">
              <button
                type="button"
                className={styles.button}
                disabled={current <= 1}
                onClick={() => setPage(Math.max(1, current - 1))}
              >
                {t('bot.page.prev')}
              </button>
              <span className={styles.pagerStatus}>{t('bot.page.status', { page: current, total: totalPages })}</span>
              <button
                type="button"
                className={styles.button}
                disabled={current >= totalPages}
                onClick={() => setPage(Math.min(totalPages, current + 1))}
              >
                {t('bot.page.next')}
              </button>
            </nav>
          ) : null}
        </>
      )}
    </section>
  )
}

export function PositionsAndOrders({ cards, onAction, disabled, t }: { readonly cards: readonly CockpitCard[] } & BlockRenderProps): JSX.Element {
  const rows = cards.filter((c) => c.cardType === 'position' || c.cardType === 'order')
  return (
    <section className={styles.section} aria-label="positions-and-orders">
      <h2 className={styles.sectionTitle}>{t('bot.positions')}</h2>
      {rows.length === 0 ? <p className={styles.note}>{t('bot.positionsEmpty')}</p> : <ul className={styles.list}>{rows.map((card) => <CardView key={card.cardId} card={card} onAction={onAction} disabled={disabled} t={t} />)}</ul>}
    </section>
  )
}

export function EscalationInbox({ cards, onAction, disabled, t }: { readonly cards: readonly CockpitCard[] } & BlockRenderProps): JSX.Element {
  const inbox = cards.filter((c) => c.cardType === 'escalation')
  return (
    <section className={styles.section} aria-label="escalation-inbox">
      <h2 className={styles.sectionTitle}>{t('bot.escalation')}</h2>
      {inbox.length === 0 ? <p className={styles.note}>{t('bot.escalationEmpty')}</p> : <ul className={styles.list}>{inbox.map((card) => <CardView key={card.cardId} card={card} onAction={onAction} disabled={disabled} t={t} />)}</ul>}
    </section>
  )
}

export function MandateAndLedger({ cards, onAction, disabled, t }: { readonly cards: readonly CockpitCard[] } & BlockRenderProps): JSX.Element {
  const rows = cards.filter((c) => c.cardType === 'mandate-status' || c.cardType === 'journal-gap')
  return (
    <section className={styles.section} aria-label="mandate-and-ledger">
      <h2 className={styles.sectionTitle}>{t('bot.mandate')}</h2>
      {rows.length === 0 ? <p className={styles.note}>{t('bot.mandateEmpty')}</p> : <ul className={styles.list}>{rows.map((card) => <CardView key={card.cardId} card={card} onAction={onAction} disabled={disabled} t={t} />)}</ul>}
    </section>
  )
}

export function SystemNotices({ cards, onAction, disabled, t }: { readonly cards: readonly CockpitCard[] } & BlockRenderProps): JSX.Element {
  const notices = cards.filter((c) => c.cardType === 'system-notice' || c.cardType === 'control-panel')
  return (
    <section className={styles.section} aria-label="system-notices">
      <h2 className={styles.sectionTitle}>{t('bot.notices')}</h2>
      {notices.length === 0 ? <p className={styles.note}>{t('bot.noticesEmpty')}</p> : <ul className={styles.list}>{notices.map((card) => <CardView key={card.cardId} card={card} onAction={onAction} disabled={disabled} t={t} />)}</ul>}
    </section>
  )
}

export function UnknownCards({ cards, t }: { readonly cards: readonly CockpitCard[]; readonly t: (key: string) => string }): JSX.Element | null {
  const known = new Set<string>(CARD_TYPES)
  const unknown = cards.filter((c) => !known.has(c.cardType))
  if (unknown.length === 0) return null
  return (
    <section className={styles.section} aria-label="unknown-cards">
      <h2 className={styles.sectionTitle}>{t('bot.unknownCards')}</h2>
      <p className={styles.note}>{t('bot.unknownCardsNote')}</p>
      <ul className={styles.list}>
        {unknown.map((c) => (
          <li key={c.cardId} className={styles.card + ' ' + styles.cardInoperable} data-card-id={c.cardId} data-card-type={c.cardType} data-operable="false">
            <strong>{c.cardType}</strong>
            <span className={styles.cardMeta}> · rev {c.revision}</span>
            <p className={styles.cardBody}>{c.fallbackText}</p>
          </li>
        ))}
      </ul>
    </section>
  )
}
