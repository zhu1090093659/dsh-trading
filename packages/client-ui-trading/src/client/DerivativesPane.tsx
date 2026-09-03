/**
 * 衍生品指标条（issue #38，crypto 图表页签下方；issue #54 入口化）：持仓量 /
 * 持仓价值 / 资金费率（含预测与结算倒计时）/ 多空人数比 / 大户多空比 / 主动买卖比
 * 快照卡片，30s 轮询刷新。
 *
 * 数据两层降级：
 * - 连接器未实现 getDerivatives（现货数据源）或取数失败 → QuoteStage 拿到 null，
 *   整条不挂载（不占位、不报错横幅）；
 * - 单项字段缺省 → 该格隐藏（不留空位），与 FundamentalsPane 同纪律。
 *
 * 入口语义（issue #54）：格子即入口——点击任意格跳到「衍生品」页签看趋势与
 * 决策面；title tooltip 承载新用户语义解释；「分析资金面」按钮把快照上下文
 * 经 fillComposer 发给 Agent（宿主未注入 fillComposer 时按钮不渲染）。
 *
 * 语义注记：fundingRate 为小数（0.0001 = 0.01%），正费率=多头付资金（多头拥挤），
 * 颜色随涨跌语义（directionColor）；多空比/主动买卖比 >1 偏多。
 */
import { fmtCompact, fmtCountdown, fmtFundingRate, directionColor, scaleLocaleOf } from './format.ts'
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
  /** 格子点击 → 跳转「衍生品」页签（issue #54；缺席时格子退化为纯展示）。 */
  onOpenStage?: () => void
  /** 「分析资金面」→ 快照上下文发给 Agent（issue #54；fillComposer 缺席时不渲染）。 */
  onAnalyze?: () => void
}

interface Cell {
  key: string
  label: string
  value: string
  sub?: string
  color?: string
  hint: string
}

export function DerivativesPane({ t, derivatives, colorMode, onOpenStage, onAnalyze }: DerivativesPaneProps): React.JSX.Element {
  const numLocale = scaleLocaleOf(t)
  const countdown = fmtCountdown(derivatives.nextFundingTime, Date.now())
  const cells: Array<Cell | null> = [
    // 持仓量：base 币数（okx oiCcy / binance fapi openInterest / bybit linear openInterest 同语义）。
    derivatives.openInterest !== undefined
      ? {
        key: 'oi',
        label: t('derivatives.oi'),
        value: fmtCompact(derivatives.openInterest, numLocale),
        hint: t('derivatives.hint.oi'),
      }
      : null,
    derivatives.openInterestValue !== undefined
      ? {
        key: 'oiValue',
        label: t('derivatives.oiValue'),
        value: `${fmtCompact(derivatives.openInterestValue, numLocale)} USD`,
        hint: t('derivatives.hint.oiValue'),
      }
      : null,
    // 资金费率：小数 → 百分比（4 位小数），正=多头付资金（颜色随涨跌语义）；
    // 副行拼「预测费率 + 结算倒计时」（issue #54，数据已在 OKX/Binance/Bybit 响应里）。
    derivatives.fundingRate !== undefined
      ? {
        key: 'funding',
        label: t('derivatives.funding'),
        value: fmtFundingRate(derivatives.fundingRate),
        sub: [
          derivatives.nextFundingRate !== undefined ? `${t('derivatives.predicted')} ${fmtFundingRate(derivatives.nextFundingRate)}` : undefined,
          countdown !== undefined ? `${t('derivatives.countdown')} ${countdown}` : undefined,
        ].filter((part): part is string => part !== undefined).join(' · ')
          || (derivatives.fundingRate > 0 ? t('derivatives.fundingPositive') : derivatives.fundingRate < 0 ? t('derivatives.fundingNegative') : undefined),
        color: directionColor(derivatives.fundingRate, colorMode),
        hint: t('derivatives.hint.funding'),
      }
      : null,
    ratioCell('longShort', t('derivatives.longShort'), derivatives.longShortRatio, t('derivatives.hint.longShort'), t, colorMode),
    ratioCell('topLongShort', t('derivatives.topLongShort'), derivatives.topTraderLongShortRatio, t('derivatives.hint.topLongShort'), t, colorMode),
    ratioCell('taker', t('derivatives.taker'), derivatives.takerBuySellRatio, t('derivatives.hint.taker'), t, colorMode),
  ]
  const visible = cells.filter(entry => entry !== null) as Cell[]

  return (
    <div className={css.root} data-dshtrading-derivatives="">
      <span className={css.title} title={t('derivatives.perpSource')}>{t('derivatives.title')}</span>
      {visible.map(entry => (
        <button
          key={entry.key}
          type="button"
          className={css.cell}
          title={entry.hint}
          data-clickable={onOpenStage !== undefined ? 'true' : undefined}
          onClick={onOpenStage}
        >
          <span className={css.cellLabel}>{entry.label}</span>
          <span className={css.cellValue} style={entry.color !== undefined ? { color: entry.color } : undefined}>{entry.value}</span>
          {entry.sub !== undefined && <span className={css.cellSub}>{entry.sub}</span>}
        </button>
      ))}
      {onAnalyze !== undefined && (
        <button type="button" className={css.analyze} title={t('derivatives.analyzeHint')} onClick={onAnalyze}>
          {t('derivatives.analyze')}
        </button>
      )}
      <span className={css.footer} title={t('derivatives.perpSource')}>
        {derivatives.symbol} · {derivatives.source} · {new Date(derivatives.timestamp).toLocaleTimeString()}
      </span>
    </div>
  )
}

/** 比值卡（多空比/主动买卖比）：>1 偏多、<1 偏空，颜色随涨跌语义；缺省隐藏。 */
function ratioCell(
  key: string,
  label: string,
  ratio: number | undefined,
  hint: string,
  t: DerivativesTranslate,
  colorMode: ColorMode,
): Cell | null {
  if (ratio === undefined || !Number.isFinite(ratio)) return null
  return {
    key,
    label,
    value: ratio.toFixed(2),
    ...(ratio !== 1 ? { sub: ratio > 1 ? t('derivatives.ratioLong') : t('derivatives.ratioShort') } : {}),
    color: directionColor(ratio - 1, colorMode),
    hint,
  }
}
