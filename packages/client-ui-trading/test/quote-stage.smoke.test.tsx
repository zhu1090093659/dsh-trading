/**
 * 渲染冒烟（issue #54 评审遗留基建）：把 QuoteStage 与衍生品组件真正 mount 进 jsdom，
 * 拦住「构建与逻辑单测全绿、一渲染就崩」的回归——2026-09-03 实证：viewTab 声明
 * 顺序 TDZ（Cannot access 'stageTab' before initialization）炸掉整个中栏 slot，
 * tsdown 构建与 790 条逻辑测试均未发现，靠 live 验证才捕获。
 *
 * 覆盖：
 * - QuoteStage 在 crypto/us 两种市场下渲染不抛错；衍生品页签仅 crypto 出现；
 *   基本面页签仅非 crypto 出现（加密资产无标准财报，2026-09-04）；
 * - DerivativesStage 全量数据渲染（基差/倒计时/24h 变化/历史 sparkline 标签）与
 *   「历史不可用」降级提示；
 * - DerivativesPane 格子点击 → onOpenStage、「分析资金面」→ onAnalyze。
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import type { DerivativesData, DerivativesHistory } from '../src/client/types.ts'

// TvChart 依赖 lightweight-charts（canvas 族 API 在 jsdom 不可用）：冒烟只关心
// QuoteStage 自身的渲染与交互编排，图表区以桩替代。
vi.mock('../src/client/TvChart.tsx', () => ({
  TvChart: () => null,
  toBar: (k: unknown) => k,
  toVolume: (k: unknown) => k,
}))

import { QuoteStage } from '../src/client/QuoteStage.tsx'
import { DerivativesStage } from '../src/client/DerivativesStage.tsx'
import { DerivativesPane } from '../src/client/DerivativesPane.tsx'
import type { SelectionState } from '../src/client/store.ts'
import type { ChartState } from '../src/client/chart-state.ts'
import type { MarketLocaleKey } from '../src/client/contract.ts'

/** key 直出翻译（断言用 key 而非文案，与词典解耦）。 */
const t = (key: MarketLocaleKey): string => key

beforeEach(() => {
  // 断网桩：桥请求一律 500，各轮询走既有 catch/降级路径（静默不炸）。
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('{}', { status: 500 }))))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function quoteStageProps(market: 'crypto' | 'us') {
  const selection: SelectionState = { instrument: { market, symbol: market === 'crypto' ? 'HYPEUSDT' : 'AAPL' } }
  const chart: ChartState = { instances: [] }
  return {
    t,
    useSelection: <T,>(sel: (state: SelectionState) => T): T => sel(selection),
    useChart: <T,>(sel: (state: ChartState) => T): T => sel(chart),
    toggleIndicator: () => {},
    setIndicatorParams: () => {},
    deleteIndicator: async () => true,
  }
}

const SNAPSHOT: DerivativesData = {
  symbol: 'HYPEUSDT-SWAP',
  source: 'okx',
  openInterest: 1399900,
  openInterestValue: 115000000,
  fundingRate: 0.00015,
  nextFundingTime: Date.now() + 3600_000,
  markPrice: 82.26,
  indexPrice: 82.31,
  longShortRatio: 1.17,
  takerBuySellRatio: 0.32,
  timestamp: Date.now(),
}

const HISTORY: DerivativesHistory = {
  symbol: 'HYPEUSDT-SWAP',
  source: 'okx',
  fundingRates: [
    { time: Date.now() - 2 * 86400_000, value: 0.0001 },
    { time: Date.now() - 86400_000, value: 0.0002 },
  ],
  openInterest: [
    { time: Date.now() - 2 * 86400_000, value: 100 },
    { time: Date.now() - 86400_000, value: 110 },
  ],
}

describe('QuoteStage 渲染冒烟（TDZ 网）', () => {
  it('crypto 标的：渲染不抛错，衍生品页签存在且可切换', () => {
    const { container, getByText, queryByText } = render(<QuoteStage {...quoteStageProps('crypto')} />)
    // 报价头与页签行渲染（t 直出 key）
    expect(container.textContent).toContain('HYPEUSDT')
    const tab = getByText('quote.tab.derivatives')
    expect(tab).toBeTruthy()
    fireEvent.click(tab)
    // 切到衍生品页签：无数据时显示空态而不是崩溃
    expect(container.querySelector('[data-dshtrading-derivatives-stage]')).toBeTruthy()
    expect(queryByText('quote.tab.chart')).toBeTruthy()
  })

  it('us 标的：衍生品页签不渲染（crypto 专属）', () => {
    const { queryByText, container } = render(<QuoteStage {...quoteStageProps('us')} />)
    expect(queryByText('quote.tab.derivatives')).toBeNull()
    expect(container.textContent).toContain('AAPL')
  })

  it('crypto 标的：基本面页签不渲染（加密资产无标准财报，2026-09-04）', () => {
    const { queryByText, container } = render(<QuoteStage {...quoteStageProps('crypto')} />)
    expect(queryByText('quote.tab.fundamentals')).toBeNull()
    expect(container.textContent).toContain('HYPEUSDT')
  })

  it('us 标的：基本面页签存在且可切换到基本面工作台', async () => {
    const { getByText, container } = render(<QuoteStage {...quoteStageProps('us')} />)
    fireEvent.click(getByText('quote.tab.fundamentals'))
    // 桥请求被断网桩 500 → 挂载 spinner → 降级渲染工作台根节点，不崩溃
    await waitFor(() => {
      expect(container.querySelector('[data-dshtrading-fundamentals]')).toBeTruthy()
    })
  })
})

describe('DerivativesStage 渲染冒烟', () => {
  it('全量数据：基差/倒计时/24h 变化/历史标签全部渲染', () => {
    const { container } = render(
      <DerivativesStage t={t} derivatives={SNAPSHOT} history={HISTORY} historyLoaded colorMode="red-up" />,
    )
    const text = container.textContent ?? ''
    expect(text).toContain('derivatives.funding')
    expect(text).toContain('derivatives.countdown')       // 结算倒计时行
    expect(text).toContain('derivatives.basis')           // 基差卡
    expect(text).toContain('-0.06%')                      // (82.26-82.31)/82.31
    expect(text).toContain('derivatives.oiChange24h')
    expect(text).toContain('+10.00%')                     // (110-100)/100
    expect(text).toContain('derivatives.fundingHistory')  // 费率历史 sparkline 标签
    expect(text).toContain('derivatives.oiTrend')         // OI 趋势标签
    expect(container.querySelectorAll('svg').length).toBeGreaterThanOrEqual(2)
  })

  it('历史不可用（loaded 且 null）→ 显示降级提示；未加载 → 不显示', () => {
    const loaded = render(
      <DerivativesStage t={t} derivatives={SNAPSHOT} history={null} historyLoaded colorMode="red-up" />,
    )
    expect(loaded.container.textContent).toContain('derivatives.historyUnavailable')
    loaded.unmount()
    const loading = render(
      <DerivativesStage t={t} derivatives={SNAPSHOT} history={null} historyLoaded={false} colorMode="red-up" />,
    )
    expect(loading.container.textContent).not.toContain('derivatives.historyUnavailable')
  })

  it('次新永续（历史不足 24h）→ 24h 变化行隐藏不误标（评审 L4）', () => {
    const recent: DerivativesHistory = {
      symbol: 'NEWUSDT-SWAP',
      source: 'okx',
      openInterest: [
        { time: Date.now() - 3600_000, value: 100 },
        { time: Date.now(), value: 150 },
      ],
    }
    const { container } = render(
      <DerivativesStage t={t} derivatives={SNAPSHOT} history={recent} historyLoaded colorMode="red-up" />,
    )
    expect(container.textContent).not.toContain('derivatives.oiChange24h')
  })
})

describe('DerivativesPane 渲染冒烟（入口化）', () => {
  it('格子点击 → onOpenStage；分析按钮 → onAnalyze', () => {
    const onOpenStage = vi.fn()
    const onAnalyze = vi.fn()
    const { container, getByText } = render(
      <DerivativesPane t={t} derivatives={SNAPSHOT} colorMode="red-up" onOpenStage={onOpenStage} onAnalyze={onAnalyze} />,
    )
    const oiCell = getByText('derivatives.oi').closest('button')
    expect(oiCell).toBeTruthy()
    fireEvent.click(oiCell as HTMLButtonElement)
    expect(onOpenStage).toHaveBeenCalledTimes(1)
    fireEvent.click(getByText('derivatives.analyze'))
    expect(onAnalyze).toHaveBeenCalledTimes(1)
    // 预测费率有值时副行展示；资金费率格式化
    expect(container.textContent).toContain('0.0150%')
    expect(container.textContent).toContain('HYPEUSDT-SWAP · okx')
  })
})
