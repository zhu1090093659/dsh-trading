import * as React from 'react'
import type { MarketLocaleKey } from './contract.ts'
import css from './marker-tooltip.module.css'

export interface SignalTooltipData {
  action: 'entry' | 'exit'
  price: number
  reason: string
  time: number
  /** 匹配的交易记录（可选） */
  trade?: {
    entryPrice: number
    exitPrice: number
    returnPercent: number
    profit: number
    holdingBars: number
  }
}

export interface KnowledgeTooltipData {
  title: string
  credibility: 'high' | 'medium' | 'low'
  cardId: string
}

export interface MarkerTooltipProps {
  /** 绝对定位 X（TvChart 容器坐标系） */
  x: number
  /** 绝对定位 Y（TvChart 容器坐标系） */
  y: number
  /** 图表容器尺寸（越界翻转钳位基准，与 x/y 同坐标系） */
  containerWidth: number
  containerHeight: number
  /** 策略信号数据（与 knowledge 互斥） */
  signal?: SignalTooltipData | undefined
  /** 知识事件数据（与 signal 互斥） */
  knowledge?: KnowledgeTooltipData | undefined
  /** 行情词典翻译函数（dshtrading.market）。 */
  t: (key: MarketLocaleKey, params?: Record<string, unknown>) => string
}

export function MarkerTooltip({ x, y, containerWidth, containerHeight, signal, knowledge, t }: MarkerTooltipProps): React.JSX.Element | null {
  if (!signal && !knowledge) return null

  // 智能定位：X/Y 任一轴越界时向另一侧翻转，并钳在容器内。
  const tooltipWidth = 280
  // Tooltip 高度估算（signal 含交易详情取上限），翻转时据此上移。
  const estimatedHeight = signal?.trade !== undefined ? 230 : 150
  const gap = 12
  const flipX = x + gap + tooltipWidth > containerWidth
  const left = Math.max(0, flipX ? x - gap - tooltipWidth : x + gap)
  const flipY = y + gap + estimatedHeight > containerHeight
  const top = Math.max(0, flipY ? y - gap - estimatedHeight : y + gap)

  const style: React.CSSProperties = {
    left: `${left}px`,
    top: `${top}px`,
  }

  return (
    <div className={css.tooltip} style={style}>
      {signal && <SignalContent signal={signal} t={t} />}
      {knowledge && <KnowledgeContent knowledge={knowledge} t={t} />}
    </div>
  )
}

function SignalContent({ signal, t }: { signal: SignalTooltipData; t: (key: MarketLocaleKey, params?: Record<string, unknown>) => string }): React.JSX.Element {
  const isEntry = signal.action === 'entry'
  const headerClass = isEntry ? css.headerEntry : css.headerExit
  const headerIcon = isEntry ? '🟢' : '🔴'
  const headerText = isEntry ? t('tooltip.signal.entry') : t('tooltip.signal.exit')

  return (
    <>
      <div className={`${css.header} ${headerClass}`}>
        {headerIcon} {headerText} · {signal.reason}
      </div>
      <div className={css.row}>
        <span className={css.label}>{t('tooltip.label.price')}</span>
        <span className={css.value}>{signal.price}</span>
      </div>
      <div className={css.row}>
        <span className={css.label}>{t('tooltip.label.time')}</span>
        <span className={css.value}>{new Date(signal.time).toLocaleString()}</span>
      </div>

      {signal.trade && (
        <>
          <hr className={css.divider} />
          <div className={css.row}>
            <span className={css.label}>{t('tooltip.label.return')}</span>
            <span className={`${css.value} ${signal.trade.returnPercent >= 0 ? css.profit : css.loss}`}>
              {signal.trade.returnPercent > 0 ? '+' : ''}{signal.trade.returnPercent.toFixed(2)}%
            </span>
          </div>
          <div className={css.row}>
            <span className={css.label}>{t('tooltip.label.profit')}</span>
            <span className={`${css.value} ${signal.trade.profit >= 0 ? css.profit : css.loss}`}>
              {signal.trade.profit > 0 ? '+' : ''}{signal.trade.profit.toFixed(2)}
            </span>
          </div>
          <div className={css.row}>
            <span className={css.label}>{t('tooltip.label.holding')}</span>
            <span className={css.value}>{t('tooltip.unit.bars', { n: String(signal.trade.holdingBars) })}</span>
          </div>
        </>
      )}
    </>
  )
}

function KnowledgeContent({ knowledge, t }: { knowledge: KnowledgeTooltipData; t: (key: MarketLocaleKey, params?: Record<string, unknown>) => string }): React.JSX.Element {
  const badgeClass =
    knowledge.credibility === 'high' ? css.badgeHigh :
    knowledge.credibility === 'medium' ? css.badgeMedium :
    css.badgeLow

  const badgeIcon =
    knowledge.credibility === 'high' ? '✅' :
    knowledge.credibility === 'medium' ? '⚠️' :
    '❌'

  const badgeText =
    knowledge.credibility === 'high' ? t('tooltip.credibility.high') :
    knowledge.credibility === 'medium' ? t('tooltip.credibility.medium') :
    t('tooltip.credibility.low')

  return (
    <>
      <div className={`${css.header} ${css.headerKnowledge}`}>
        📌 {t('tooltip.knowledge.header')}
      </div>
      <div className={css.row}>
        <span className={css.label}>{knowledge.title}</span>
      </div>
      <div className={css.row}>
        <span className={`${css.badge} ${badgeClass}`}>
          {badgeIcon} {badgeText}
        </span>
      </div>
    </>
  )
}
