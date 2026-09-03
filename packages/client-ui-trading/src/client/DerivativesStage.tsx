/**
 * 衍生品决策页签（issue #54，crypto 专属，QuoteStage 第四页签）：
 * 把快照条（DerivativesPane）扩成决策面——四张卡：
 *
 * 1. 资金费率卡：当前费率 / 预测费率 / 结算倒计时（1s 走时）+ 近 30 期历史 sparkline；
 * 2. 持仓量卡：当前 OI / 持仓价值 / 24h 持仓变化（历史序列末点 vs 前一日点）+ 近 30 日趋势；
 * 3. 多空比卡：多空人数比 / 大户多空比 / 主动买卖比（>1 偏多语义沿用快照条）；
 * 4. 基差卡：标记价格 / 指数价格 / 基差 %（(mark-index)/index，正=永续升水）。
 *
 * 降级纪律（与快照条同族）：字段缺省 → 对应行隐藏；history 为 null（连接器未实现
 * getDerivativesHistory 或失败）→ 趋势区显示「无历史序列」提示，快照读数不受影响。
 */
import { useEffect, useState } from 'react'
import { Sparkline } from './Sparkline.tsx'
import { directionColor, fmtCompact, fmtCountdown, fmtFundingRate, fmtPercent, fmtPrice } from './format.ts'
import type { ColorMode } from './color-mode.ts'
import type { DerivativesData, DerivativesHistory, DerivativesPoint } from './types.ts'
import type { MarketLocaleKey } from './contract.ts'
import css from './derivatives-stage.module.css'

export type DerivativesStageTranslate = (key: MarketLocaleKey) => string

export interface DerivativesStageProps {
  t: DerivativesStageTranslate
  /** 快照（30s 轮询，QuoteStage 共享衍生品条同一份 state）。 */
  derivatives: DerivativesData | null
  /** 历史序列（页签激活才拉，5min 节奏；null = 未实现/失败）。 */
  history: DerivativesHistory | null
  colorMode: ColorMode
}

/** 结算倒计时 1s 走时（仅页签挂载期间计时）。 */
function useNowMs(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => { setNow(Date.now()) }, 1000)
    return () => { clearInterval(timer) }
  }, [])
  return now
}

/** 24h 持仓变化：历史序列末点 vs 24h 前最近采样点（数据不足 → undefined 该行隐藏）。 */
function oiChange24h(points: DerivativesPoint[] | undefined): number | undefined {
  if (points === undefined || points.length < 2) return undefined
  const last = points[points.length - 1] as DerivativesPoint
  const cutoff = last.time - 24 * 3600 * 1000
  // 从后往前找第一个 ≤ cutoff 的点；找不到就用序列首点（近似）。
  let base: DerivativesPoint | undefined
  for (let i = points.length - 2; i >= 0; i -= 1) {
    const p = points[i] as DerivativesPoint
    if (p.time <= cutoff) { base = p; break }
  }
  base = base ?? (points[0] as DerivativesPoint)
  if (base.value <= 0 || base.time === last.time) return undefined
  return (last.value - base.value) / base.value * 100
}

export function DerivativesStage({ t, derivatives, history, colorMode }: DerivativesStageProps): React.JSX.Element {
  const now = useNowMs()

  if (derivatives === null && history === null) {
    return <div className={css.empty} data-dshtrading-derivatives-stage="">{t('quote.noData')}</div>
  }

  const fundingHistory = history?.fundingRates
  const oiHistory = history?.openInterest
  const oiChange = oiChange24h(oiHistory)
  const countdown = fmtCountdown(derivatives?.nextFundingTime, now)
  const basis = derivatives?.markPrice !== undefined && derivatives?.indexPrice !== undefined && derivatives.indexPrice > 0
    ? (derivatives.markPrice - derivatives.indexPrice) / derivatives.indexPrice * 100
    : undefined

  return (
    <div className={css.root} data-dshtrading-derivatives-stage="">
      {/* 资金费率卡 */}
      <section className={css.card} title={t('derivatives.hint.funding')}>
        <header className={css.cardHead}>{t('derivatives.funding')}</header>
        <div className={css.bigValue} style={derivatives?.fundingRate !== undefined ? { color: directionColor(derivatives.fundingRate, colorMode) } : undefined}>
          {fmtFundingRate(derivatives?.fundingRate)}
        </div>
        {derivatives?.fundingRate !== undefined && (
          <div className={css.semantic}>
            {derivatives.fundingRate > 0 ? t('derivatives.fundingPositive') : derivatives.fundingRate < 0 ? t('derivatives.fundingNegative') : ''}
          </div>
        )}
        <dl className={css.rows}>
          {derivatives?.nextFundingRate !== undefined && (
            <div className={css.row}>
              <dt>{t('derivatives.predicted')}</dt>
              <dd style={{ color: directionColor(derivatives.nextFundingRate, colorMode) }}>{fmtFundingRate(derivatives.nextFundingRate)}</dd>
            </div>
          )}
          {countdown !== undefined && (
            <div className={css.row}>
              <dt>{t('derivatives.countdown')}</dt>
              <dd className={css.countdown}>{countdown}</dd>
            </div>
          )}
        </dl>
        {fundingHistory !== undefined && fundingHistory.length > 1 ? (
          <div className={css.trend}>
            <Sparkline
              values={fundingHistory.map(p => p.value)}
              width={220}
              height={40}
              up={(fundingHistory[fundingHistory.length - 1]?.value ?? 0) >= (fundingHistory[0]?.value ?? 0)}
              colorMode={colorMode}
            />
            <span className={css.trendLabel}>{t('derivatives.fundingHistory')}</span>
          </div>
        ) : (
          history !== null && <div className={css.noHistory}>{t('derivatives.historyUnavailable')}</div>
        )}
      </section>

      {/* 持仓量卡 */}
      <section className={css.card} title={t('derivatives.hint.oi')}>
        <header className={css.cardHead}>{t('derivatives.oi')}</header>
        <div className={css.bigValue}>{fmtCompact(derivatives?.openInterest)}</div>
        <dl className={css.rows}>
          {derivatives?.openInterestValue !== undefined && (
            <div className={css.row}>
              <dt>{t('derivatives.oiValue')}</dt>
              <dd>{fmtCompact(derivatives.openInterestValue)} USD</dd>
            </div>
          )}
          {oiChange !== undefined && (
            <div className={css.row}>
              <dt>{t('derivatives.oiChange24h')}</dt>
              <dd style={{ color: directionColor(oiChange, colorMode) }}>{fmtPercent(oiChange)}</dd>
            </div>
          )}
        </dl>
        {oiHistory !== undefined && oiHistory.length > 1 ? (
          <div className={css.trend}>
            <Sparkline
              values={oiHistory.map(p => p.value)}
              width={220}
              height={40}
              up={(oiHistory[oiHistory.length - 1]?.value ?? 0) >= (oiHistory[0]?.value ?? 0)}
              colorMode={colorMode}
            />
            <span className={css.trendLabel}>{t('derivatives.oiTrend')}</span>
          </div>
        ) : (
          history !== null && <div className={css.noHistory}>{t('derivatives.historyUnavailable')}</div>
        )}
      </section>

      {/* 多空比卡 */}
      <section className={css.card}>
        <header className={css.cardHead}>{t('derivatives.longShort')}</header>
        <dl className={css.rows}>
          {([
            ['longShort', derivatives?.longShortRatio, t('derivatives.hint.longShort')],
            ['topLongShort', derivatives?.topLongShortRatio, t('derivatives.hint.topLongShort')],
            ['taker', derivatives?.takerBuySellRatio, t('derivatives.hint.taker')],
          ] as const).filter((row): row is readonly [string, number, string] => row[1] !== undefined).map(([key, ratio, hint]) => (
            <div className={css.row} key={key} title={hint}>
              <dt>{key === 'longShort' ? t('derivatives.longShort') : key === 'topLongShort' ? t('derivatives.topLongShort') : t('derivatives.taker')}</dt>
              <dd style={{ color: directionColor(ratio - 1, colorMode) }}>
                {ratio.toFixed(2)}
                <span className={css.tag}>{ratio > 1 ? t('derivatives.ratioLong') : ratio < 1 ? t('derivatives.ratioShort') : ''}</span>
              </dd>
            </div>
          ))}
        </dl>
      </section>

      {/* 基差卡 */}
      <section className={css.card} title={t('derivatives.hint.basis')}>
        <header className={css.cardHead}>{t('derivatives.basis')}</header>
        <div className={css.bigValue} style={basis !== undefined ? { color: directionColor(basis, colorMode) } : undefined}>
          {basis !== undefined ? fmtPercent(basis) : '—'}
        </div>
        <dl className={css.rows}>
          {derivatives?.markPrice !== undefined && (
            <div className={css.row}>
              <dt>{t('derivatives.markPrice')}</dt>
              <dd>{fmtPrice(derivatives.markPrice)}</dd>
            </div>
          )}
          {derivatives?.indexPrice !== undefined && (
            <div className={css.row}>
              <dt>{t('derivatives.indexPrice')}</dt>
              <dd>{fmtPrice(derivatives.indexPrice)}</dd>
            </div>
          )}
        </dl>
      </section>

      {derivatives !== null && (
        <footer className={css.foot} title={t('derivatives.perpSource')}>
          {derivatives.symbol} · {derivatives.source} · {new Date(derivatives.timestamp).toLocaleTimeString()}
        </footer>
      )}
    </div>
  )
}
