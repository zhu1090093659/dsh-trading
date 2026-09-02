/**
 * 盘口与分笔竖栏（issue #39，QuoteStage 右侧可折叠）。
 *
 * 三段：
 * - 五档/十档深度：asks（上）+ bids（下），背景条按档位量占比；卖一/买一之间夹
 *   价差行；顶部买卖力道比（∑bids / ∑asks 量占比，条形）。
 * - 逐笔成交流水（时间倒序展示，最新在上）：时间/价格/量，价格按主动方向着色。
 * - 降级：连接器未实现 getOrderbook（yahoo/stooq/腾讯 r_hk）→ fetchOrderbook 返回
 *   null → 显示「未提供盘口」提示；分笔同理（腾讯沪深行情行无逐笔端点）。
 *
 * 纪律：纯展示组件，轮询在 QuoteStage（fetch 失败静默保留上一帧）。
 */
import { directionColor, fmtPrice } from './format.ts'
import type { ColorMode } from './color-mode.ts'
import type { Orderbook, TradeTick } from './types.ts'
import type { MarketLocaleKey } from './contract.ts'
import css from './orderbook-pane.module.css'

export type OrderbookTranslate = (key: MarketLocaleKey) => string

export interface OrderbookPaneProps {
  t: OrderbookTranslate
  /** 桥 /orderbook 快照；null = 该市场数据源不提供盘口（降级提示）。 */
  orderbook: Orderbook | null
  /** 桥 /trades 流水（时间升序，组件内倒序展示）；null = 数据源不提供。 */
  trades: TradeTick[] | null
  orderbookLoading: boolean
  colorMode: ColorMode
  onClose: () => void
}

const MAX_LEVELS = 10

export function OrderbookPane({ t, orderbook, trades, orderbookLoading, colorMode, onClose }: OrderbookPaneProps): React.JSX.Element {
  const degraded = orderbook === null && !orderbookLoading

  const buyVolume = orderbook?.bids.reduce((sum, level) => sum + level.amount, 0) ?? 0
  const sellVolume = orderbook?.asks.reduce((sum, level) => sum + level.amount, 0) ?? 0
  const total = buyVolume + sellVolume
  const buyRatio = total > 0 ? buyVolume / total : undefined

  const bestBid = orderbook?.bids[0]?.price
  const bestAsk = orderbook?.asks[0]?.price
  const spread = bestBid !== undefined && bestAsk !== undefined ? bestAsk - bestBid : undefined

  // 档位条宽度基准：买卖两侧取同一最大档位量，深度条才可比。
  const maxLevelAmount = orderbook === null ? 0 : Math.max(
    ...orderbook.bids.slice(0, MAX_LEVELS).map(level => level.amount),
    ...orderbook.asks.slice(0, MAX_LEVELS).map(level => level.amount),
    1,
  )
  // 展示顺序：asks 倒序（卖五在顶、卖一贴价差行），bids 正序（买一贴价差行）。
  const askLevels = (orderbook?.asks ?? []).slice(0, MAX_LEVELS).slice().reverse()
  const bidLevels = (orderbook?.bids ?? []).slice(0, MAX_LEVELS)
  // 流水：服务端时间升序 → 倒序展示（最新在上）。
  const tradeRows = (trades ?? []).slice().reverse()

  return (
    <div className={css.root} data-dshtrading-orderbook="">
      <div className={css.head}>
        <span>{t('orderbook.title')}</span>
        <button type="button" className={css.close} aria-label={t('orderbook.close')} onClick={onClose}>×</button>
      </div>
      <div className={css.body}>
        {degraded && <div className={css.degraded}>{t('orderbook.unavailable')}</div>}
        {orderbook !== null && (
          <>
            {buyRatio !== undefined && (
              <div className={css.depthMeter}>
                <div className={css.meterBar}>
                  <span className={css.meterBuy} style={{ width: `${(buyRatio * 100).toFixed(1)}%` }} />
                  <span className={css.meterSell} style={{ width: `${((1 - buyRatio) * 100).toFixed(1)}%` }} />
                </div>
                <span>
                  {t('orderbook.buyForce')} {(buyRatio * 100).toFixed(1)}% · {t('orderbook.sellForce')} {((1 - buyRatio) * 100).toFixed(1)}%
                </span>
              </div>
            )}
            <div className={css.levels}>
              {askLevels.map((level, index) => (
                <LevelRow key={`a${index}`} kind="asks" level={level} max={maxLevelAmount} />
              ))}
              {spread !== undefined && (
                <div className={css.spread}>{t('orderbook.spread')} {fmtPrice(spread)}</div>
              )}
              {bidLevels.map((level, index) => (
                <LevelRow key={`b${index}`} kind="bids" level={level} max={maxLevelAmount} />
              ))}
            </div>
          </>
        )}
        {orderbookLoading && orderbook === null && !degraded && (
          <div className={css.spread}>…</div>
        )}
        {trades !== null && tradeRows.length > 0 && (
          <>
            <div className={css.sectionTitle}>{t('orderbook.trades')}</div>
            <div className={css.trades}>
              {tradeRows.slice(0, 50).map((trade, index) => (
                <div key={`${trade.id}-${index}`} className={css.trade}>
                  <span className={css.time}>{new Date(trade.timestamp).toLocaleTimeString()}</span>
                  <span
                    style={trade.side === 'unknown' ? undefined : { color: directionColor(trade.side === 'buy' ? 1 : -1, colorMode) }}
                  >
                    {fmtPrice(trade.price)}
                  </span>
                  <span className={css.amount}>{compactAmount(trade.amount)}</span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

/** 单档位：背景条按量占比（bar 宽 = amount/max），价格 + 量。 */
function LevelRow(props: {
  kind: 'bids' | 'asks'
  level: { price: number; amount: number }
  max: number
}): React.JSX.Element {
  const { kind, level, max } = props
  const width = `${Math.min(100, (level.amount / (max || 1)) * 100).toFixed(1)}%`
  return (
    <div className={`${css.level} ${css[kind]}`}>
      <span className={css.levelBar} style={{ width }} />
      <span className={css.levelPrice}>{fmtPrice(level.price)}</span>
      <span className={css.levelAmount}>{compactAmount(level.amount)}</span>
    </div>
  )
}

/** 档位/成交量紧凑展示（≥1万缩写；股票单位=股、crypto=币）。 */
function compactAmount(value: number): string {
  if (!Number.isFinite(value)) return '—'
  if (Math.abs(value) >= 100_000_000) return `${(value / 100_000_000).toFixed(2)}亿`
  if (Math.abs(value) >= 10_000) return `${(value / 10_000).toFixed(2)}万`
  return value % 1 === 0 ? String(value) : value.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')
}
