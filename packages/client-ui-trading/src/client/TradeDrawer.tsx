/**
 * 底部全宽资产与订单抽屉（TradingView/同花顺风格）：
 * 占满屏幕底沿，横向平铺展现持仓、活动委托、成交历史与账户资金。
 * 默认可保持纤细状态条（不挤压 K 线主图），点击即刻展开大表格查看与撤单。
 */
import { useState } from 'react'
import type { ColorMode } from './color-mode.ts'
import type { AccountBalance, Order, Position, TradeFill } from './types.ts'
import type { MarketLocaleKey } from './contract.ts'
import { directionColor, fmtPrice } from './format.ts'
import css from './trade-drawer.module.css'

export type TradeDrawerTranslate = (key: MarketLocaleKey) => string

export interface TradeDrawerProps {
  t: TradeDrawerTranslate
  positions: Position[] | null
  balances: AccountBalance[] | null
  orders: Order[] | null
  fills: TradeFill[] | null
  colorMode: ColorMode
  isOpen: boolean
  onToggle: (open: boolean) => void
  onCancelOrder?: (orderId: string, symbol?: string) => Promise<boolean>
}

export function TradeDrawer({
  t,
  positions,
  balances,
  orders,
  fills,
  colorMode,
  isOpen,
  onToggle,
  onCancelOrder,
}: TradeDrawerProps): React.JSX.Element {
  const [activeTab, setActiveTab] = useState<'positions' | 'orders' | 'fills' | 'balances'>('positions')
  const [cancelingId, setCancelingId] = useState<string | null>(null)

  const posCount = positions?.length ?? 0
  const orderCount = orders?.length ?? 0
  const fillCount = fills?.length ?? 0

  const handleTabClick = (tab: typeof activeTab) => {
    if (!isOpen) {
      onToggle(true)
    }
    setActiveTab(tab)
  }

  return (
    <div className={css.root} data-dshtrading-trade-drawer="" style={{ maxHeight: isOpen ? '220px' : '28px' }}>
      <div className={css.bar}>
        <div className={css.tabs} role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'positions'}
            data-active={activeTab === 'positions' ? 'true' : undefined}
            className={css.tabBtn}
            onClick={() => handleTabClick('positions')}
          >
            {t('trade.positions')}
            {posCount > 0 && <span className={css.badge}>{posCount}</span>}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'orders'}
            data-active={activeTab === 'orders' ? 'true' : undefined}
            className={css.tabBtn}
            onClick={() => handleTabClick('orders')}
          >
            {t('trade.openOrders')}
            {orderCount > 0 && <span className={css.badge}>{orderCount}</span>}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'fills'}
            data-active={activeTab === 'fills' ? 'true' : undefined}
            className={css.tabBtn}
            onClick={() => handleTabClick('fills')}
          >
            {t('trade.fills')}
            {fillCount > 0 && <span className={css.badge}>{fillCount}</span>}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'balances'}
            data-active={activeTab === 'balances' ? 'true' : undefined}
            className={css.tabBtn}
            onClick={() => handleTabClick('balances')}
          >
            {t('trade.balances')}
          </button>
        </div>

        <div className={css.actions}>
          <button
            type="button"
            className={css.toggleBtn}
            onClick={() => onToggle(!isOpen)}
            title={isOpen ? t('trade.drawer.collapse') : t('trade.drawer.expand')}
          >
            <span>{isOpen ? `${t('trade.drawer.collapse')} ▼` : `${t('trade.drawer.expand')} ▲`}</span>
          </button>
        </div>
      </div>

      {isOpen && (
        <div className={css.content}>
          {activeTab === 'positions' && (
            positions === null ? (
              <div className={css.empty}>{t('trade.credentialHint')}</div>
            ) : positions.length === 0 ? (
              <div className={css.empty}>{t('trade.empty')}</div>
            ) : (
              <table className={css.table}>
                <thead>
                  <tr>
                    <th>{t('trade.symbol')}</th>
                    <th>{t('trade.side')}</th>
                    <th>{t('trade.size')}</th>
                    <th>{t('trade.entryPrice')}</th>
                    <th>{t('trade.unrealizedPnl')}</th>
                  </tr>
                </thead>
                <tbody>
                  {positions.map((p, idx) => (
                    <tr key={`${p.symbol}-${idx}`}>
                      <td>{p.symbol}</td>
                      <td style={{ color: directionColor(p.side === 'long' ? 1 : -1, colorMode) }}>
                        {t(p.side === 'long' ? 'trade.long' : 'trade.short')}
                      </td>
                      <td>{p.size}</td>
                      <td>{p.entryPrice !== undefined ? fmtPrice(p.entryPrice) : '—'}</td>
                      <td style={p.unrealizedPnl !== undefined ? { color: directionColor(p.unrealizedPnl, colorMode) } : undefined}>
                        {p.unrealizedPnl !== undefined ? `${p.unrealizedPnl >= 0 ? '+' : ''}${fmtPrice(p.unrealizedPnl)}` : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          )}

          {activeTab === 'orders' && (
            orders === null ? (
              <div className={css.empty}>{t('trade.unavailable')}</div>
            ) : orders.length === 0 ? (
              <div className={css.empty}>{t('trade.empty')}</div>
            ) : (
              <table className={css.table}>
                <thead>
                  <tr>
                    <th>{t('trade.symbol')}</th>
                    <th>{t('trade.side')}</th>
                    <th>{t('trade.type')}</th>
                    <th>{t('trade.price')}</th>
                    <th>{t('trade.size')}</th>
                    <th>{t('trade.filled')}</th>
                    {onCancelOrder && <th>{t('trade.action')}</th>}
                  </tr>
                </thead>
                <tbody>
                  {orders.map((order, idx) => (
                    <tr key={`${order.id}-${idx}`}>
                      <td>{order.symbol}</td>
                      <td style={{ color: directionColor(order.side === 'buy' ? 1 : -1, colorMode) }}>
                        {t(order.side === 'buy' ? 'trade.buy' : 'trade.sell')}
                      </td>
                      <td>{t(order.type === 'market' ? 'trade.market' : 'trade.limit')}</td>
                      <td>{order.price !== undefined ? fmtPrice(order.price) : '—'}</td>
                      <td>{order.quantity}</td>
                      <td>{order.filledQuantity ?? 0}</td>
                      {onCancelOrder && (
                        <td>
                          <button
                            type="button"
                            className={css.cancelBtn}
                            disabled={cancelingId === order.id}
                            onClick={() => {
                              setCancelingId(order.id)
                              void onCancelOrder(order.id, order.symbol).finally(() => {
                                setCancelingId(null)
                              })
                            }}
                          >
                            {cancelingId === order.id ? t('trade.canceling') : t('trade.cancel')}
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          )}

          {activeTab === 'fills' && (
            fills === null ? (
              <div className={css.empty}>{t('trade.unavailable')}</div>
            ) : fills.length === 0 ? (
              <div className={css.empty}>{t('trade.empty')}</div>
            ) : (
              <table className={css.table}>
                <thead>
                  <tr>
                    <th>{t('trade.time')}</th>
                    <th>{t('trade.symbol')}</th>
                    <th>{t('trade.side')}</th>
                    <th>{t('trade.price')}</th>
                    <th>{t('trade.size')}</th>
                  </tr>
                </thead>
                <tbody>
                  {fills.slice().reverse().map((fill, idx) => (
                    <tr key={`${fill.id}-${idx}`}>
                      <td style={{ color: 'var(--dsw-futu-text-muted, #787b86)' }}>
                        {new Date(fill.timestamp).toLocaleString()}
                      </td>
                      <td>{fill.symbol}</td>
                      <td style={{ color: directionColor(fill.side === 'buy' ? 1 : -1, colorMode) }}>
                        {t(fill.side === 'buy' ? 'trade.buy' : 'trade.sell')}
                      </td>
                      <td>{fmtPrice(fill.price)}</td>
                      <td>{fill.amount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          )}

          {activeTab === 'balances' && (
            balances === null ? (
              <div className={css.empty}>{t('trade.credentialHint')}</div>
            ) : balances.length === 0 ? (
              <div className={css.empty}>{t('trade.empty')}</div>
            ) : (
              <table className={css.table}>
                <thead>
                  <tr>
                    <th>{t('trade.drawer.asset')}</th>
                    <th>{t('trade.drawer.available')}</th>
                    <th>{t('trade.drawer.locked')}</th>
                    <th>{t('trade.drawer.total')}</th>
                  </tr>
                </thead>
                <tbody>
                  {balances.map((b, idx) => (
                    <tr key={`${b.asset}-${idx}`}>
                      <td style={{ fontWeight: 600 }}>{b.asset}</td>
                      <td>{fmtPrice(b.free)}</td>
                      <td>{fmtPrice(b.locked)}</td>
                      <td>{fmtPrice(b.free + b.locked)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          )}
        </div>
      )}
    </div>
  )
}
