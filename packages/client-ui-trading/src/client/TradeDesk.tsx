/**
 * 交易工作台底栏（issue #40，QuoteStage 图表下方可折叠）。
 *
 * **安全边界（实现即边界，不是 UI 承诺）**：
 * - 本组件的下单请求经桥 `POST /trade/order`，桥层强制 `dryRun=true`——GUI 在
 *   结构上没有实盘下单通道；「实盘」只展示当前服务状态，路径唯一在 Agent 会话
 *   （dryRun=false → 服务缝 liveTrading 闸门 → base 统一审批闸门）。
 * - 持仓/余额/挂单/流水为只读查询；凭证缺失时 fail-closed（结构化错误 → 分区
 *   显示错误说明，不静默空白）。
 *
 * 纯展示 + 表单；数据轮询在 QuoteStage（15s，仅面板打开时）。
 */
import { useState } from 'react'
import { fmtPrice } from './format.ts'
import { directionColor } from './format.ts'
import type { ColorMode } from './color-mode.ts'
import type { AccountBalance, Order, Position, TradeFill } from './types.ts'
import type { MarketLocaleKey } from './contract.ts'
import type { GuiOrderInput } from './api.ts'
import css from './trade-desk.module.css'

export type TradeDeskTranslate = (key: MarketLocaleKey, params?: Record<string, unknown>) => string

export interface TradeDeskProps {
  t: TradeDeskTranslate
  symbol: string
  positions: Position[] | null
  balances: AccountBalance[] | null
  orders: Order[] | null
  fills: TradeFill[] | null
  colorMode: ColorMode
  onClose: () => void
  onSubmit: (input: GuiOrderInput) => Promise<Order | null>
}

export function TradeDesk({ t, symbol, positions, balances, orders, fills, colorMode, onClose, onSubmit }: TradeDeskProps): React.JSX.Element {
  const [side, setSide] = useState<'buy' | 'sell'>('buy')
  const [type, setType] = useState<'market' | 'limit'>('market')
  const [quantity, setQuantity] = useState('')
  const [price, setPrice] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [receipt, setReceipt] = useState<string | null>(null)

  const submit = (): void => {
    const qty = Number(quantity)
    if (!Number.isFinite(qty) || qty <= 0 || submitting) return
    const limitPrice = type === 'limit' ? Number(price) : undefined
    if (type === 'limit' && (!Number.isFinite(limitPrice) || (limitPrice ?? 0) <= 0)) return
    setSubmitting(true)
    setReceipt(null)
    void onSubmit({
      symbol,
      side,
      type,
      quantity: qty,
      ...(type === 'limit' && Number.isFinite(limitPrice) ? { price: limitPrice } : {}),
    })
      .then((order) => {
        setReceipt(order === null
          ? t('trade.submitFailed')
          : `${t('trade.dryRunFilled')} · id=${order.id} · ${fmtPrice(order.price ?? 0)}`)
      })
      .finally(() => { setSubmitting(false) })
  }

  return (
    <div className={css.root} data-dshtrading-trade-desk="">
      <div className={css.head}>
        <span>{t('trade.title')}</span>
        <span className={css.dryRunBadge}>{t('trade.dryRunOnly')}</span>
        <button type="button" className={css.close} aria-label={t('trade.close')} onClick={onClose}>×</button>
      </div>
      <div className={css.body}>
        <div className={css.form}>
          <div className={css.sideToggle} role="tablist" aria-label="order side">
            <button
              type="button"
              role="tab"
              aria-selected={side === 'buy'}
              className={css.toggleBtn}
              data-active={side === 'buy' ? 'true' : undefined}
              style={side === 'buy' ? { background: 'var(--dsw-futu-up, #e64545)' } : undefined}
              onClick={() => { setSide('buy') }}
            >
              {t('trade.buy')}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={side === 'sell'}
              className={css.toggleBtn}
              data-active={side === 'sell' ? 'true' : undefined}
              style={side === 'sell' ? { background: 'var(--dsw-futu-down, #2dbd85)' } : undefined}
              onClick={() => { setSide('sell') }}
            >
              {t('trade.sell')}
            </button>
          </div>
          <div className={css.typeToggle} role="tablist" aria-label="order type">
            <button type="button" role="tab" aria-selected={type === 'market'} className={css.toggleBtn} data-active={type === 'market' ? 'true' : undefined} onClick={() => { setType('market') }}>
              {t('trade.market')}
            </button>
            <button type="button" role="tab" aria-selected={type === 'limit'} className={css.toggleBtn} data-active={type === 'limit' ? 'true' : undefined} onClick={() => { setType('limit') }}>
              {t('trade.limit')}
            </button>
          </div>
          {type === 'limit' && (
            <div className={css.field}>
              <label htmlFor="trade-price">{t('trade.price')}</label>
              <input id="trade-price" inputMode="decimal" value={price} onChange={(event) => { setPrice(event.target.value) }} />
            </div>
          )}
          <div className={css.field}>
            <label htmlFor="trade-quantity">{t('trade.quantity')}</label>
            <input id="trade-quantity" inputMode="decimal" placeholder="0.00" value={quantity} onChange={(event) => { setQuantity(event.target.value) }} />
          </div>
          <button
            type="button"
            className={css.submit}
            disabled={submitting || quantity === '' || (type === 'limit' && price === '')}
            style={{ background: side === 'buy' ? 'var(--dsw-futu-up, #e64545)' : 'var(--dsw-futu-down, #2dbd85)' }}
            onClick={submit}
          >
            {submitting ? t('trade.submitting') : t('trade.dryRunSubmit')}
          </button>
          {receipt !== null && <div className={css.receipt}>{receipt}</div>}
          <div className={css.hint}>{t('trade.liveHint')}</div>
        </div>
        <div className={css.tables}>
          <div>
            <div className={css.sectionTitle}>{t('trade.positions')}</div>
            {positions === null
              ? <div className={css.empty}>{t('trade.credentialHint')}</div>
              : positions.length === 0
                ? <div className={css.empty}>{t('trade.empty')}</div>
                : (
                  <table className={css.table}>
                    <thead>
                      <tr><th>{t('trade.symbol')}</th><th>{t('trade.side')}</th><th>{t('trade.size')}</th><th>{t('trade.entryPrice')}</th><th>{t('trade.unrealizedPnl')}</th></tr>
                    </thead>
                    <tbody>
                      {positions.map((position, index) => (
                        <tr key={`${position.symbol}-${index}`}>
                          <td>{position.symbol}</td>
                          <td style={{ color: directionColor(position.side === 'long' ? 1 : -1, colorMode) }}>{t(position.side === 'long' ? 'trade.long' : 'trade.short')}</td>
                          <td>{position.size}</td>
                          <td>{position.entryPrice !== undefined ? fmtPrice(position.entryPrice) : '—'}</td>
                          <td style={position.unrealizedPnl !== undefined ? { color: directionColor(position.unrealizedPnl, colorMode) } : undefined}>
                            {position.unrealizedPnl !== undefined ? position.unrealizedPnl.toFixed(2) : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
          </div>
          <div>
            <div className={css.sectionTitle}>{t('trade.openOrders')}</div>
            {orders === null
              ? <div className={css.empty}>{t('trade.unavailable')}</div>
              : orders.length === 0
                ? <div className={css.empty}>{t('trade.empty')}</div>
                : (
                  <table className={css.table}>
                    <thead>
                      <tr><th>{t('trade.symbol')}</th><th>{t('trade.side')}</th><th>{t('trade.type')}</th><th>{t('trade.price')}</th><th>{t('trade.size')}</th><th>{t('trade.filled')}</th></tr>
                    </thead>
                    <tbody>
                      {orders.map((order, index) => (
                        <tr key={`${order.id}-${index}`}>
                          <td>{order.symbol}</td>
                          <td style={{ color: directionColor(order.side === 'buy' ? 1 : -1, colorMode) }}>{t(order.side === 'buy' ? 'trade.buy' : 'trade.sell')}</td>
                          <td>{t(order.type === 'market' ? 'trade.market' : 'trade.limit')}</td>
                          <td>{order.price !== undefined ? fmtPrice(order.price) : '—'}</td>
                          <td>{order.quantity}</td>
                          <td>{order.filledQuantity ?? 0}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
          </div>
          <div>
            <div className={css.sectionTitle}>{t('trade.fills')}</div>
            {fills === null
              ? <div className={css.empty}>{t('trade.unavailable')}</div>
              : fills.length === 0
                ? <div className={css.empty}>{t('trade.empty')}</div>
                : (
                  <table className={css.table}>
                    <thead>
                      <tr><th>{t('trade.time')}</th><th>{t('trade.symbol')}</th><th>{t('trade.side')}</th><th>{t('trade.price')}</th><th>{t('trade.size')}</th></tr>
                    </thead>
                    <tbody>
                      {fills.slice().reverse().map((fill, index) => (
                        <tr key={`${fill.id}-${index}`}>
                          <td className={css.empty}>{new Date(fill.timestamp).toLocaleString()}</td>
                          <td>{fill.symbol}</td>
                          <td style={{ color: directionColor(fill.side === 'buy' ? 1 : -1, colorMode) }}>{t(fill.side === 'buy' ? 'trade.buy' : 'trade.sell')}</td>
                          <td>{fmtPrice(fill.price)}</td>
                          <td>{fill.amount}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
          </div>
          {balances !== null && balances.length > 0 && (
            <div>
              <div className={css.sectionTitle}>{t('trade.balances')}</div>
              <div className={css.empty}>
                {balances.map((balance) => `${balance.asset} ${balance.free.toFixed(4)}`).join(' · ')}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
