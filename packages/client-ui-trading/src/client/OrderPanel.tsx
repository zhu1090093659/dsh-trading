/**
 * 右侧快速下单面板（对齐 OKX / Binance 旗舰桌面端）：
 * 位于右侧盘口下方，用户边盯盘口边直接敲单买卖。
 * 只做真交易：直接执行实盘下单。
 */
import { useEffect, useMemo, useState } from 'react'
import type { ColorMode } from './color-mode.ts'
import type { MarketLocaleKey } from './contract.ts'
import type { GuiOrderInput, GuiOrderResult } from './api.ts'
import type { MarketId } from './types.ts'
import css from './order-panel.module.css'

export type OrderPanelTranslate = (key: MarketLocaleKey) => string

export interface OrderPanelProps {
  t: OrderPanelTranslate
  symbol: string
  market?: MarketId | undefined
  suggestedPrice?: number | undefined
  colorMode: ColorMode
  tradeMode?: 'live' | 'paper' | undefined
  paperCash?: number | undefined
  onResetPaper?: (() => void) | undefined
  onSubmit: (input: GuiOrderInput) => Promise<GuiOrderResult>
  onClose?: (() => void) | undefined
}

/** 智能推断标的资产单位 */
function resolveAssetUnit(symbol: string, t: (k: MarketLocaleKey) => string, market?: MarketId): string {
  if (market === 'crypto' || /USDT|USDC|BUSD|BTC|ETH/i.test(symbol)) {
    const clean = symbol.toUpperCase().replace(/[-_].*$/, '')
    for (const quote of ['USDT', 'USDC', 'BUSD', 'USD']) {
      if (clean.endsWith(quote) && clean.length > quote.length) {
        return clean.slice(0, -quote.length)
      }
    }
    return t('trade.unit.coin')
  }
  return t('trade.unit.shares')
}

export function OrderPanel({
  t,
  symbol,
  market,
  suggestedPrice,
  colorMode,
  tradeMode = 'live',
  paperCash,
  onResetPaper,
  onSubmit,
  onClose,
}: OrderPanelProps): React.JSX.Element {
  const [side, setSide] = useState<'buy' | 'sell'>('buy')
  const [type, setType] = useState<'market' | 'limit'>('market')
  const [quantity, setQuantity] = useState('')
  const [price, setPrice] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [feedback, setFeedback] = useState<{ text: string; state: 'success' | 'error' } | null>(null)

  const unit = useMemo(() => resolveAssetUnit(symbol, t, market), [symbol, t, market])

  // 当建议价格变化且当前价格为空时辅助填入
  useEffect(() => {
    if (suggestedPrice !== undefined && suggestedPrice > 0 && price === '') {
      setPrice(String(suggestedPrice))
    }
  }, [suggestedPrice])

  const upColor = colorMode === 'red-up' ? 'var(--dsw-futu-up, #e64545)' : 'var(--dsw-futu-down, #2dbd85)'
  const downColor = colorMode === 'red-up' ? 'var(--dsw-futu-down, #2dbd85)' : 'var(--dsw-futu-up, #e64545)'
  const activeColor = side === 'buy' ? upColor : downColor

  // 预估成交金额
  const estimatedAmount = useMemo(() => {
    const qty = Number(quantity)
    if (!Number.isFinite(qty) || qty <= 0) return null
    const p = type === 'limit' ? Number(price) : (suggestedPrice ?? 0)
    if (!Number.isFinite(p) || p <= 0) return null
    return (qty * p).toFixed(2)
  }, [quantity, price, type, suggestedPrice])

  const submit = (): void => {
    const qty = Number(quantity)
    if (!Number.isFinite(qty) || qty <= 0 || submitting) return
    const limitPrice = type === 'limit' ? Number(price) : undefined
    if (type === 'limit' && (!Number.isFinite(limitPrice) || (limitPrice ?? 0) <= 0)) return

    setSubmitting(true)
    setFeedback(null)

    const payload: GuiOrderInput = {
      symbol,
      side,
      type,
      quantity: qty,
      ...(limitPrice !== undefined ? { price: limitPrice } : {}),
    }

    void onSubmit(payload)
      .then((res) => {
        if (res.order) {
          setFeedback({
            text: `${t('trade.orderSuccess')} · ID: ${res.order.id}`,
            state: 'success',
          })
          setQuantity('')
        } else {
          setFeedback({
            text: res.error ? `${t('trade.submitFailed')}: ${res.error}` : t('trade.submitFailed'),
            state: 'error',
          })
        }
      })
      .catch((err) => {
        setFeedback({
          text: `${t('trade.submitFailed')}: ${err instanceof Error ? err.message : String(err)}`,
          state: 'error',
        })
      })
      .finally(() => {
        setSubmitting(false)
      })
  }

  // 快捷比例填单
  const applyRatio = (ratio: number) => {
    // 若为股票，按 100 股一手向上取整；若为加密货币，按常规颗粒度
    if (unit === t('trade.unit.shares')) {
      const base = 100
      setQuantity(String(Math.max(base, Math.round(base * ratio * 4))))
    } else {
      const base = 1
      setQuantity(String(Number((base * ratio).toFixed(3))))
    }
  }

  const actionText = side === 'buy' ? t('trade.buy') : t('trade.sell')

  return (
    <div className={css.root} data-dshtrading-order-panel="">
      <div className={css.titleRow}>
        <span>{t('trade.sideOrder')}</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
          {tradeMode === 'paper' ? (
            <>
              <span className={css.paperTag}>{t('trade.paper.tag')}</span>
              {onResetPaper !== undefined && (
                <button
                  type="button"
                  className={css.resetBtn}
                  onClick={() => {
                    if (typeof window !== 'undefined' && window.confirm(t('trade.paper.resetConfirm'))) {
                      onResetPaper()
                    }
                  }}
                  title={t('trade.paper.reset')}
                >
                  ↺ {t('trade.paper.reset')}
                </button>
              )}
            </>
          ) : (
            <span className={css.liveTag}>{t('trade.liveChannel')}</span>
          )}
          {onClose !== undefined && (
            <button type="button" className={css.closeBtn} onClick={onClose} title={t('trade.close')}>
              ×
            </button>
          )}
        </div>
      </div>

      {tradeMode === 'paper' && (
        <div className={css.availableRow}>
          <span>{t('trade.paper.available')}</span>
          <span className={css.availableValue}>
            {(paperCash ?? 100000).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </span>
        </div>
      )}

      <div className={css.sideToggle} role="tablist" aria-label="order side">
        <button
          type="button"
          role="tab"
          aria-selected={side === 'buy'}
          className={css.toggleBtn}
          data-active={side === 'buy' ? 'true' : undefined}
          style={side === 'buy' ? { background: upColor } : undefined}
          onClick={() => { setSide('buy'); setFeedback(null) }}
        >
          {t('trade.buy')}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={side === 'sell'}
          className={css.toggleBtn}
          data-active={side === 'sell' ? 'true' : undefined}
          style={side === 'sell' ? { background: downColor } : undefined}
          onClick={() => { setSide('sell'); setFeedback(null) }}
        >
          {t('trade.sell')}
        </button>
      </div>

      <div className={css.typeToggle} role="tablist" aria-label="order type">
        <button
          type="button"
          role="tab"
          aria-selected={type === 'market'}
          className={css.typeBtn}
          data-active={type === 'market' ? 'true' : undefined}
          onClick={() => { setType('market') }}
        >
          {t('trade.market')}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={type === 'limit'}
          className={css.typeBtn}
          data-active={type === 'limit' ? 'true' : undefined}
          onClick={() => { setType('limit') }}
        >
          {t('trade.limit')}
        </button>
      </div>

      {type === 'limit' ? (
        <div className={css.field}>
          <div className={css.labelRow}>
            <label htmlFor="order-panel-price">{t('trade.price')}</label>
            {suggestedPrice !== undefined && suggestedPrice > 0 && (
              <span
                style={{ cursor: 'pointer', color: 'var(--dsw-futu-primary, #2962ff)', fontSize: '10.5px' }}
                onClick={() => setPrice(String(suggestedPrice))}
              >
                {t('trade.fillCurrentPrice')}
              </span>
            )}
          </div>
          <div className={css.inputWrapper}>
            <input
              id="order-panel-price"
              inputMode="decimal"
              placeholder="0.00"
              value={price}
              onChange={(e) => { setPrice(e.target.value) }}
            />
          </div>
        </div>
      ) : (
        <div className={css.marketHint}>
          {t('trade.marketExecuteHint')}
        </div>
      )}

      <div className={css.field}>
        <div className={css.labelRow}>
          <label htmlFor="order-panel-quantity">{t('trade.quantity')}</label>
        </div>
        <div className={css.inputWrapper}>
          <input
            id="order-panel-quantity"
            inputMode="decimal"
            placeholder="0"
            value={quantity}
            onChange={(e) => { setQuantity(e.target.value) }}
          />
          <span className={css.unit}>{unit}</span>
        </div>
      </div>

      {/* 快捷仓位比例胶囊 */}
      <div className={css.ratioRow} role="group" aria-label="Quick quantity ratios">
        <button type="button" className={css.ratioBtn} onClick={() => applyRatio(0.25)}>25%</button>
        <button type="button" className={css.ratioBtn} onClick={() => applyRatio(0.5)}>50%</button>
        <button type="button" className={css.ratioBtn} onClick={() => applyRatio(0.75)}>75%</button>
        <button type="button" className={css.ratioBtn} onClick={() => applyRatio(1)}>100%</button>
      </div>

      {estimatedAmount !== null && (
        <div className={css.estRow}>
          <span>{t('trade.estimatedAmount')}</span>
          <span className={css.estValue}>≈ {estimatedAmount}</span>
        </div>
      )}

      <button
        type="button"
        className={css.submitBtn}
        data-paper={tradeMode === 'paper' ? 'true' : undefined}
        disabled={submitting || quantity === '' || (type === 'limit' && price === '')}
        style={{ background: activeColor }}
        onClick={submit}
      >
        {submitting
          ? t('trade.submitting')
          : tradeMode === 'paper'
            ? `${side === 'buy' ? t('trade.paper.buyAction') : t('trade.paper.sellAction')} ${symbol}`
            : `${actionText} ${symbol}`}
      </button>

      {feedback && (
        <div className={css.receipt} data-state={feedback.state}>
          {feedback.text}
        </div>
      )}
    </div>
  )
}
