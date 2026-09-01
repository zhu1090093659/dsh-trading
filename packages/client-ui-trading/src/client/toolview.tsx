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
import css from './toolview.module.css'

/** 从 owner.block 取（argsRaw, result 文本）。 */
function readCall(block: ToolCallOwnerProps['block']): { argsRaw: string; resultText: string | null; isError: boolean } {
  if (block.kind === 'tool-result') {
    const text = block.content
      .map(part => (typeof part === 'object' && part !== null && 'text' in part ? String((part as { text?: unknown }).text ?? '') : ''))
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
export function OrderCard({ block }: ToolCallOwnerProps) {
  const call = readCall(block)
  if (call.resultText === null) return null
  const parsed = parsePlaceOrderPayload(call.argsRaw, call.resultText)
  if (parsed === null) return null

  return (
    <div className={css.card} data-dshtrading-toolview="place-order" data-state={parsed.state}>
      <div className={css.head}>
        <span className={css.badge} data-state={parsed.state}>
          {parsed.state === 'rejected' ? '已拒绝' : parsed.dryRun ? '模拟单' : '实盘单'}
        </span>
        <span className={css.title}>{parsed.symbol}</span>
        <span className={css.chip}>{parsed.side === 'buy' ? '买入' : '卖出'}</span>
        <span className={css.chip}>{parsed.type === 'limit' ? '限价' : '市价'}</span>
      </div>
      <div className={css.params}>
        {parsed.type === 'limit' && parsed.price !== null ? `价格 ${parsed.price} · ` : ''}
        {`数量 ${parsed.quantity ?? '—'}`}
        {parsed.referencePrice !== null ? ` · 参考价 ${parsed.referencePrice}` : ''}
      </div>
      {parsed.state === 'rejected' && parsed.message !== '' && <div className={css.reason}>{parsed.message}</div>}
    </div>
  )
}

/** watchlist_add / watchlist_select 卡：标的 chip + 动作结果。 */
export function WatchlistChipCard({ toolName, block }: ToolCallOwnerProps) {
  const call = readCall(block)
  if (call.resultText === null) return null
  const parsed = parseWatchlistPayload(toolName, call.argsRaw, call.resultText)
  if (parsed === null) return null

  return (
    <div className={css.card} data-dshtrading-toolview="watchlist">
      <div className={css.head}>
        <span className={css.title}>{parsed.action === 'select' ? '已切换选中' : parsed.added ? '已加入自选' : '已在自选中'}</span>
        <span className={css.chip}>{parsed.symbol}</span>
        <span className={css.chip}>{parsed.market}</span>
        {parsed.name !== '' && <span className={css.meta}>{parsed.name}</span>}
      </div>
      {parsed.note !== '' && <div className={css.params}>{parsed.note}</div>}
    </div>
  )
}