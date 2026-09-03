/**
 * 对话内富卡片（issue #34 / P5 §5.5，shell 半）：tool.call.toolview keyed slot。
 *
 * - OrderCard（key = <market>_place_order，4 市场各注册一把）：订单参数 +
 *   模拟/实盘标识（dryRun 回执 status:'filled'+dryRun:true / 闸门拒绝
 *   status:'rejected'）+ 参考价；
 * - WatchlistChipCard（key = watchlist_add / watchlist_select）：标的 chip。
 *
 * 契约同策略卡：running/解析失败 → null，回落官方通用工具行。
 */
import type { ToolCallOwnerProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import { parsePlaceOrderPayload, parseWatchlistPayload } from './toolview-parse.ts'
import type { MarketLocaleKey } from './contract.ts'
import css from './toolview.module.css'

/** 卡片文案面：keyed slot 注册声明 locale: NS 后，框架沿 owner props 注入
 *  t（宿主内建 SearchRow 同款）；SDK 的 ToolCallOwnerProps 类型不含 t，
 *  组件签名本地宽化，缺席时回落英文常量（词典缺失也不渲染裸键）。 */
type CardProps = ToolCallOwnerProps & { t?: (key: MarketLocaleKey, params?: Record<string, unknown>) => string }

/** 从 owner.block 取（argsRaw, result 文本）。 */
function readCall(block: ToolCallOwnerProps['block']): { argsRaw: string; resultText: string | null; isError: boolean } {
  if (block.kind === 'tool-result') {
    const text = block.content
      .map((part: unknown) => (typeof part === 'object' && part !== null && 'text' in part ? String((part as { text?: unknown }).text ?? '') : ''))
      .join('')
    return { argsRaw: block.call?.argsRaw ?? '', resultText: text, isError: block.isError }
  }
  return { argsRaw: block.argsRaw ?? '', resultText: null, isError: false }
}

/** 下单工具名 → 市场（us/cn/hk/crypto_place_order）。 */
const ORDER_TOOL_RE = /^(crypto|us|cn|hk)_place_order$/

export function isOrderTool(name: string): boolean {
  return ORDER_TOOL_RE.test(name)
}

/** <market>_place_order 卡：订单参数 + 模拟/实盘/拒绝标识 + 参考价。 */
export function OrderCard(props: CardProps) {
  const { block, t } = props
  const call = readCall(block)
  if (call.resultText === null) return null
  const parsed = parsePlaceOrderPayload(call.argsRaw, call.resultText)
  if (parsed === null) return null

  return (
    <div className={css.card} data-dshtrading-toolview="place-order" data-state={parsed.state}>
      <div className={css.head}>
        <span className={css.badge} data-state={parsed.state}>
          {parsed.state === 'rejected'
            ? (t?.('card.order.rejected') ?? 'Rejected')
            : parsed.dryRun
              ? (t?.('card.order.dryRun') ?? 'Dry-run')
              : (t?.('card.order.live') ?? 'Live')}
        </span>
        <span className={css.title}>{parsed.symbol}</span>
        <span className={css.chip}>{parsed.side === 'buy' ? (t?.('trade.buy') ?? 'Buy') : (t?.('trade.sell') ?? 'Sell')}</span>
        <span className={css.chip}>{parsed.type === 'limit' ? (t?.('trade.limit') ?? 'Limit') : (t?.('trade.market') ?? 'Market')}</span>
      </div>
      <div className={css.params}>
        {parsed.type === 'limit' && parsed.price !== null ? `${t?.('card.order.priceLabel') ?? 'Price'} ${parsed.price} · ` : ''}
        {`${t?.('card.order.quantityLabel') ?? 'Qty'} ${parsed.quantity ?? '—'}`}
        {parsed.referencePrice !== null ? ` · ${t?.('card.order.refPriceLabel') ?? 'Ref'} ${parsed.referencePrice}` : ''}
      </div>
      {parsed.state === 'rejected' && parsed.message !== '' && <div className={css.reason}>{parsed.message}</div>}
    </div>
  )
}

/** watchlist_add / watchlist_select 卡：标的 chip + 动作结果。 */
export function WatchlistChipCard(props: CardProps) {
  const { toolName, block, t } = props
  const call = readCall(block)
  if (call.resultText === null) return null
  const parsed = parseWatchlistPayload(toolName, call.argsRaw, call.resultText)
  if (parsed === null) return null

  const title = parsed.action === 'select'
    ? (t?.('card.watchlist.selected') ?? 'Selected')
    : parsed.added
      ? (t?.('card.watchlist.added') ?? 'Added to watchlist')
      : (t?.('card.watchlist.already') ?? 'Already in watchlist')

  return (
    <div className={css.card} data-dshtrading-toolview="watchlist">
      <div className={css.head}>
        <span className={css.title}>{title}</span>
        <span className={css.chip}>{parsed.symbol}</span>
        <span className={css.chip}>{parsed.market}</span>
        {parsed.name !== '' && <span className={css.meta}>{parsed.name}</span>}
      </div>
      {parsed.note !== '' && <div className={css.params}>{parsed.note}</div>}
    </div>
  )
}