/**
 * 驾驶舱的展示块（P4 步骤 3 信息架构）。
 *
 * 全部是**纯展示**：输入是 /v1 下发的卡片，输出是 DOM；没有取数、没有副作用。
 * 这样做的理由是可验证性 —— 卡片协议已经把"界面能长什么样"限定住了（封闭 Field/Action），
 * 于是"渲染对不对"可以用字符串断言直接钉住，不需要跑浏览器。
 *
 * 两条卡片硬要求在这里落地：
 *   - **观测面不依赖 tick 流**：每块只吃 %%Card[]%% 与一个 %%fetchedAtMs%%；
 *   - **未知枚举的卡片渲染为不可操作态**：%%operable === false%% 时禁用全部动作并明说原因。
 */
import type { Card } from '@dshtrading/contract'

/** 卡片渲染所需的最小视图（/v1 会在协议字段之外附上 operable 与 problems）。 */
export interface CockpitCard extends Card {
  readonly operable?: boolean | undefined
  readonly problems?: readonly string[] | undefined
}

/** 新鲜度文案：观测面唯一的"时间感"来源（没有 tick 流）。 */
export function freshnessText(fetchedAtMs: number | undefined, nowMs: number): string {
  if (fetchedAtMs === undefined) return '尚未取到数据'
  const seconds = Math.max(0, Math.round((nowMs - fetchedAtMs) / 1000))
  if (seconds < 5) return '数据是新的（' + String(seconds) + ' 秒前）'
  if (seconds < 60) return '数据 ' + String(seconds) + ' 秒前'
  return '数据已陈旧：' + String(Math.round(seconds / 60)) + ' 分钟前'
}

/** 一张卡片的渲染（不可操作时禁用全部动作）。 */
export function CardView({ card }: { readonly card: CockpitCard }): JSX.Element {
  const operable = card.operable !== false
  return (
    <li data-card-id={card.cardId} data-card-type={card.cardType} data-operable={operable ? 'true' : 'false'}>
      <strong>{card.cardType}</strong>
      <span> · rev {card.revision}</span>
      <p>{card.fallbackText}</p>
      {operable ? (
        card.actions.length === 0 ? (
          <p>无可用动作</p>
        ) : (
          <p>
            可用动作：
            {card.actions.map((action) => (
              <button key={action.kind} type="button" disabled={false}>
                {action.label}
              </button>
            ))}
          </p>
        )
      ) : (
        <p role="status">此卡片需要升级客户端后才能操作（含本客户端不认识的取值）</p>
      )}
    </li>
  )
}

/** 首页：desk 概览 —— 只显示 desk/风险/指令状态类卡片。 */
export function DeskHome({ cards }: { readonly cards: readonly CockpitCard[] }): JSX.Element {
  const home = cards.filter((card) => card.cardType === 'desk-summary' || card.cardType === 'risk-state' || card.cardType === 'control-panel' || card.cardType === 'freshness')
  return (
    <section aria-label="desk">
      <h2>Desk</h2>
      {home.length === 0 ? <p>没有 desk 卡片</p> : <ul>{home.map((card) => <CardView key={card.cardId} card={card} />)}</ul>}
    </section>
  )
}

/** 决策动态流：决策/触发/升级三类卡片按 revision 倒序（新的在上）。 */
export function DecisionFeed({ cards }: { readonly cards: readonly CockpitCard[] }): JSX.Element {
  const feed = cards
    .filter((card) => card.cardType === 'decision' || card.cardType === 'trigger-trace' || card.cardType === 'escalation')
    .slice()
    .sort((left, right) => right.revision - left.revision)
  return (
    <section aria-label="decisions">
      <h2>决策动态</h2>
      {feed.length === 0 ? <p>还没有决策</p> : <ul>{feed.map((card) => <CardView key={card.cardId} card={card} />)}</ul>}
    </section>
  )
}

/** 持仓与挂单：只显示 position/order；**这里没有下单入口**（卡片硬要求）。 */
export function PositionsAndOrders({ cards }: { readonly cards: readonly CockpitCard[] }): JSX.Element {
  const rows = cards.filter((card) => card.cardType === 'position' || card.cardType === 'order')
  return (
    <section aria-label="positions">
      <h2>持仓与挂单</h2>
      {rows.length === 0 ? <p>当前没有持仓或挂单</p> : <ul>{rows.map((card) => <CardView key={card.cardId} card={card} />)}</ul>}
    </section>
  )
}

/** 升级收件箱：需要人决策的卡片。 */
export function EscalationInbox({ cards }: { readonly cards: readonly CockpitCard[] }): JSX.Element {
  const inbox = cards.filter((card) => card.cardType === 'escalation')
  return (
    <section aria-label="escalations">
      <h2>升级收件箱</h2>
      {inbox.length === 0 ? <p>没有待处理升级</p> : <ul>{inbox.map((card) => <CardView key={card.cardId} card={card} />)}</ul>}
    </section>
  )
}
