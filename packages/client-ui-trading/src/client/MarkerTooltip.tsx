import * as React from 'react'
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
  /** 绝对定位 X（像素） */
  x: number
  /** 绝对定位 Y（像素） */
  y: number
  /** 策略信号数据（与 knowledge 互斥） */
  signal?: SignalTooltipData
  /** 知识事件数据（与 signal 互斥） */
  knowledge?: KnowledgeTooltipData
}

export function MarkerTooltip({ x, y, signal, knowledge }: MarkerTooltipProps): React.JSX.Element | null {
  if (!signal && !knowledge) return null

  // 智能定位：防止超出视口（x + 280 > viewport 时向左翻转）
  const tooltipWidth = 280
  const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 1000
  const isOverflow = x + tooltipWidth > viewportWidth
  const left = isOverflow ? x - tooltipWidth : x

  const style: React.CSSProperties = {
    left: `${left}px`,
    top: `${y}px`,
  }

  return (
    <div className={css.tooltip} style={style}>
      {signal && <SignalContent signal={signal} />}
      {knowledge && <KnowledgeContent knowledge={knowledge} />}
    </div>
  )
}

function SignalContent({ signal }: { signal: SignalTooltipData }): React.JSX.Element {
  const isEntry = signal.action === 'entry'
  const headerClass = isEntry ? css.headerEntry : css.headerExit
  const headerIcon = isEntry ? '🟢' : '🔴'
  const headerText = isEntry ? '买入信号' : '卖出信号'

  return (
    <>
      <div className={`${css.header} ${headerClass}`}>
        {headerIcon} {headerText} · {signal.reason}
      </div>
      <div className={css.row}>
        <span className={css.label}>价格</span>
        <span className={css.value}>{signal.price}</span>
      </div>
      <div className={css.row}>
        <span className={css.label}>时间</span>
        <span className={css.value}>{new Date(signal.time).toLocaleString()}</span>
      </div>
      
      {signal.trade && (
        <>
          <hr className={css.divider} />
          <div className={css.row}>
            <span className={css.label}>收益率</span>
            <span className={`${css.value} ${signal.trade.returnPercent >= 0 ? css.profit : css.loss}`}>
              {signal.trade.returnPercent > 0 ? '+' : ''}{signal.trade.returnPercent.toFixed(2)}%
            </span>
          </div>
          <div className={css.row}>
            <span className={css.label}>盈亏</span>
            <span className={`${css.value} ${signal.trade.profit >= 0 ? css.profit : css.loss}`}>
              {signal.trade.profit > 0 ? '+' : ''}{signal.trade.profit.toFixed(2)}
            </span>
          </div>
          <div className={css.row}>
            <span className={css.label}>持仓</span>
            <span className={css.value}>{signal.trade.holdingBars} 根</span>
          </div>
        </>
      )}
    </>
  )
}

function KnowledgeContent({ knowledge }: { knowledge: KnowledgeTooltipData }): React.JSX.Element {
  const badgeClass = 
    knowledge.credibility === 'high' ? css.badgeHigh :
    knowledge.credibility === 'medium' ? css.badgeMedium :
    css.badgeLow

  const badgeIcon =
    knowledge.credibility === 'high' ? '✅' :
    knowledge.credibility === 'medium' ? '⚠️' :
    '❌'

  const badgeText = 
    knowledge.credibility === 'high' ? '高可信度' :
    knowledge.credibility === 'medium' ? '中可信度' :
    '低可信度'

  return (
    <>
      <div className={`${css.header} ${css.headerKnowledge}`}>
        📌 知识事件
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
