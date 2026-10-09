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
 * - DerivativesPane 格子点击 → onOpenStage（纯展示，无发送入口）。
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

import { presetDefinitions } from '@dshtrading/indicators'
import { indicators } from '../src/client/indicator-registry.ts'
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

function quoteStageProps(
  market: 'crypto' | 'us',
  instrument?: { symbol: string; assetClass?: 'crypto' | 'equity' | 'commodity' | 'index' },
  instances: ChartState['instances'] = [],
  /** 适用范围写入记录器（手动收集，测试棘轮禁用 vi.* 通用 mock）。 */
  scopeWrites: Array<{ id: string; market: string; scope: unknown }> = [],
) {
  const selection: SelectionState = {
    instrument: {
      market,
      symbol: instrument?.symbol ?? (market === 'crypto' ? 'HYPEUSDT' : 'AAPL'),
      ...(instrument?.assetClass !== undefined ? { assetClass: instrument.assetClass } : {}),
    },
  }
  const chart: ChartState = { instances }
  return {
    t,
    useSelection: <T,>(sel: (state: SelectionState) => T): T => sel(selection),
    useChart: <T,>(sel: (state: ChartState) => T): T => sel(chart),
    toggleIndicator: () => {},
    setIndicatorParams: () => {},
    setIndicatorVisible: () => {},
    setIndicatorScope: (id: string, market: string, scope: unknown) => { scopeWrites.push({ id, market, scope }) },
    removeIndicator: () => {},
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

  it('用户查看 TradFi 永续合约图表时，看到「交易所合成合约、非股票本身」的明示位', () => {
    // Given: 选中一行带交易所元数据的股票永续（TradFi，非加密资产类别）
    // When: 渲染报价页（默认图表页签）
    const view = render(<QuoteStage {...quoteStageProps('crypto', { symbol: 'TSLAUSDT-SWAP', assetClass: 'equity' })} />)
    const notice = view.container.querySelector('[data-dshtrading-tradfi-notice]')
    // Then: 明示位出现，且合成合约与 24/7 报价两条文案位都在
    expect(notice).toBeTruthy()
    expect(notice?.textContent).toContain('tradfi.notice.title')
    expect(notice?.textContent).toContain('tradfi.notice.detail')
  })

  it('用户查看加密永续合约图表时，不出现 TradFi 明示位（加密永续不是合成股票合约）', () => {
    // Given: 选中一行加密永续（同形态、不同资产类别）
    // When: 渲染报价页（默认图表页签）
    const view = render(<QuoteStage {...quoteStageProps('crypto', { symbol: 'BTCUSDT-SWAP', assetClass: 'crypto' })} />)
    // Then: 明示位不出现
    expect(view.container.querySelector('[data-dshtrading-tradfi-notice]')).toBeNull()
  })

  it('用户关闭某市场后仍能看到保留的级别数（关闭不等于清空选择）', () => {
    // Given: EMA 在美股勾了 1/7、在港股关闭但保留 15m 一条选择
    for (const definition of presetDefinitions()) indicators.register(definition)
    const instances = [{
      id: 'ema',
      params: { n1: 5, n2: 10, n3: 20, n4: 30, n5: 60, n6: 120 },
      applyScope: {
        us: { enabled: true, intervals: ['1d'] },
        hk: { enabled: false, intervals: ['15m'] },
      },
    }]
    const view = render(<QuoteStage {...quoteStageProps('us', undefined, instances, [])} />)

    // When: 打开适用范围面板
    fireEvent.click(view.getByText('indicator.picker'))
    const panel = view.container.querySelector('[aria-label="indicator.picker"]')
    const emaRow = Array.from(panel?.querySelectorAll('label') ?? [])
      .find(label => label.textContent?.trim() === 'EMA')?.parentElement
    const scopeButton = Array.from(emaRow?.querySelectorAll('button') ?? [])
      .find(button => button.textContent?.trim() === 'indicator.scope')
    fireEvent.click(scopeButton as HTMLElement)

    // Then: 港股行显示保留的 1/7，而不是误报「未选择级别」
    const hk = view.container.querySelector('[data-dshtrading-scope-market="hk"]')
    expect(hk?.textContent).toContain('indicator.scope.count')
    // 未选择级别的市场（未出现在 applyScope 的其它市场）不出现「未选择级别」
    const us = view.container.querySelector('[data-dshtrading-scope-market="us"]')
    expect(us?.textContent).not.toContain('indicator.scope.none')
  })

  it('用户在当前标的隐藏了某指标时，仍能打开其「适用范围」（跨标的全局设置，不是死按钮）', () => {
    // Given: MACD 已挂载但在当前美股标的 AAPL 上被隐藏（hiddenScopes 命中 us:AAPL）
    for (const definition of presetDefinitions()) indicators.register(definition)
    const instances = [{ id: 'macd', params: { fast: 12, slow: 26, signal: 9 }, hiddenScopes: ['us:AAPL'] }]
    const view = render(<QuoteStage {...quoteStageProps('us', undefined, instances, [])} />)

    // When: 打开指标选择器 → 点 MACD 的「适用范围」
    fireEvent.click(view.getByText('indicator.picker'))
    const panel = view.container.querySelector('[aria-label="indicator.picker"]')
    const row = panel === null
      ? null
      : Array.from(panel.querySelectorAll('label'))
        .find(label => label.textContent?.trim() === 'MACD')?.parentElement ?? null
    const scopeButton = row === null
      ? undefined
      : Array.from(row.querySelectorAll('button')).find(button => button.textContent?.trim() === 'indicator.scope')
    expect(scopeButton).toBeTruthy()
    fireEvent.click(scopeButton as HTMLElement)

    // Then: 适用范围面板照常展开（隐藏 ≠ 取消激活，设置必须仍然可改）
    expect(view.container.querySelector('[data-dshtrading-scope]')).toBeTruthy()
    expect(view.container.querySelectorAll('[data-dshtrading-scope-market]').length).toBe(6)
  })

  it('用户在指标设置里展开「适用范围」，按市场勾选级别并写入该市场配置', async () => {
    // Given: 指标插件就位（选择器有 definition）且挂载了 MACD 副图（无适用范围 = 全部应用）
    for (const definition of presetDefinitions()) indicators.register(definition)
    const writes: Array<{ id: string; market: string; scope: unknown }> = []
    const view = render(<QuoteStage {...quoteStageProps('us', undefined, [{ id: 'macd', params: { fast: 12, slow: 26, signal: 9 } }], writes)} />)

    // When: 打开指标选择器 → 点「适用范围」→ 展开美股 → 取消勾选 1d
    fireEvent.click(view.getByText('indicator.picker'))
    fireEvent.click(view.getByText('indicator.scope'))
    // Then: 适用范围面板按市场分行渲染（系统支持的六个市场）
    expect(view.container.querySelector('[data-dshtrading-scope]')).toBeTruthy()
    expect(view.container.querySelectorAll('[data-dshtrading-scope-market]').length).toBe(6)
    expect(view.getByText('indicator.scope.hint')).toBeTruthy()

    fireEvent.click(view.container.querySelector('[data-dshtrading-scope-expand="us"]') as HTMLElement)
    // 展开后该市场显示全部支持级别
    expect(view.container.querySelectorAll('[data-dshtrading-scope-level]').length).toBeGreaterThan(0)
    fireEvent.click(view.container.querySelector('[data-dshtrading-scope-level="1d"] input') as HTMLElement)

    // Then: 写入的是美股且级别已去掉 1d（不再是全部级别）
    const usWrite = writes.find(entry => entry.market === 'us')
    expect(usWrite?.id).toBe('macd')
    expect(usWrite?.scope).toEqual({ enabled: true, intervals: ['5m', '15m', '30m', '1h', '1w', '1M'] })
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
  it('格子点击 → onOpenStage；纯展示无发送按钮', () => {
    const onOpenStage = vi.fn()
    const { container, getByText, queryByText } = render(
      <DerivativesPane t={t} derivatives={SNAPSHOT} colorMode="red-up" onOpenStage={onOpenStage} />,
    )
    const oiCell = getByText('derivatives.oi').closest('button')
    expect(oiCell).toBeTruthy()
    fireEvent.click(oiCell as HTMLButtonElement)
    expect(onOpenStage).toHaveBeenCalledTimes(1)
    // 「分析资金面」按钮已随入口收敛移除（2026-09-04）；统一发送入口亦已下线
    expect(queryByText('derivatives.analyze')).toBeNull()
    // 预测费率有值时副行展示；资金费率格式化
    expect(container.textContent).toContain('0.0150%')
    expect(container.textContent).toContain('HYPEUSDT-SWAP · okx')
  })
})
