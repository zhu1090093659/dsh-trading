/**
 * 衍生品指标条（issue #38，crypto 图表页签下方）：持仓量 / 持仓价值 / 资金费率 /
 * 多空人数比 / 大户多空比 / 主动买卖比 快照卡片，30s 轮询刷新。
 *
 * 数据两层降级：
 * - 连接器未实现 getDerivatives（现货数据源）或取数失败 → QuoteStage 拿到 null，
 *   整条不挂载（不占位、不报错横幅）；
 * - 单项字段缺省 → 该格隐藏（不留空位），与 FundamentalsPane 同纪律。
 *
 * 语义注记：fundingRate 为小数（0.0001 = 0.01%），正费率=多头付资金（多头拥挤），
 * 颜色随涨跌语义（directionColor）；多空比/主动买卖比 >1 偏多。
 */
import { fmtCompact, directionColor, scaleLocaleOf } from './format.ts'
import type { ColorMode } from './color-mode.ts'
import type { DerivativesData } from './types.ts'
import type { MarketLocaleKey } from './contract.ts'
import css from './derivatives-pane.module.css'

export type DerivativesTranslate = (key: MarketLocaleKey, params?: Record<string, unknown>) => string

export interface DerivativesPaneProps {
  t: DerivativesTranslate
  derivatives: DerivativesData
  /** 涨跌配色方向（red-up / green-up 主题偏好）。 */
  colorMode: ColorMode
}

export function DerivativesPane({ t, derivatives, colorMode }: DerivativesPaneProps): React.JSX.Element {
  const numLocale = scaleLocaleOf(t)
  const cells: Array<{ key: string; label: string; value: string; sub?: string; color?: string } | null> = [
    // 持仓量：base 币数（okx oiCcy / binance fapi openInterest / bybit linear openInterest 同语义）。
    derivatives.openInterest !== undefined
      ? {
        key: 'oi',
        label: t('derivatives.oi'),
        value: fmtCompact(derivatives.openInterest, numLocale),
      }
      : null,
    derivatives.openInterestValue !== undefined
      ? {
        key: 'oiValue',
        label: t('derivatives.oiValue'),
        value: `${fmtCompact(derivatives.openInterestValue, numLocale)} USD`,
      }
      : null,
    // 资金费率：小数 → 百分比（4 位小数），正=多头付资金（颜色随涨跌语义）。
    derivatives.fundingRate !== undefined
      ? {
        key: 'funding',
        label: t('derivatives.funding'),
        value: `${(derivatives.fundingRate * 100).toFixed(4)}%`,
        ...(derivatives.fundingRate !== 0 ? { sub: derivatives.fundingRate > 0 ? t('derivatives.fundingPositive') : t('derivatives.fundingNegative') } : {}),
        color: directionColor(derivatives.fundingRate, colorMode),
      }
      : null,
    ratioCell('longShort', t('derivatives.longShort'), derivatives.longShortRatio, t, colorMode),
    ratioCell('topLongShort', t('derivatives.topLongShort'), derivatives.topTraderLongShortRatio, t, colorMode),
    ratioCell('taker', t('derivatives.taker'), derivatives.takerBuySellRatio, t, colorMode),
  ]
  const visible = cells.filter(entry => entry !== null) as Array<{ key: string; label: string; value: string; sub?: string; color?: string }>

  return (
    <div className={css.root} data-dshtrading-derivatives="">
      <span className={css.title}>{t('derivatives.title')}</span>
      {visible.map(entry => (
        <div key={entry.key} className={css.cell}>
          <span className={css.cellLabel}>{entry.label}</span>
          <span className={css.cellValue} style={entry.color !== undefined ? { color: entry.color } : undefined}>{entry.value}</span>
          {entry.sub !== undefined && <span className={css.cellSub}>{entry.sub}</span>}
        </div>
      ))}
      <span className={css.footer}>
        {derivatives.source} · {new Date(derivatives.timestamp).toLocaleTimeString()}
      </span>
    </div>
  )
}

/** 比值卡（多空比/主动买卖比）：>1 偏多、<1 偏空，颜色随涨跌语义；缺省隐藏。 */
function ratioCell(
  key: string,
  label: string,
  ratio: number | undefined,
  t: DerivativesTranslate,
  colorMode: ColorMode,
): { key: string; label: string; value: string; sub?: string; color?: string } | null {
  if (ratio === undefined || !Number.isFinite(ratio)) return null
  return {
    key,
    label,
    value: ratio.toFixed(2),
    ...(ratio !== 1 ? { sub: ratio > 1 ? t('derivatives.ratioLong') : t('derivatives.ratioShort') } : {}),
    color: directionColor(ratio - 1, colorMode),
  }
}
