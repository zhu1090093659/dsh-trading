/**
 * PolymarketPanel 渲染冒烟（2026-10-11）：面板只读展示、质量标记可见、概率和偏离
 * 有提示、两个数据源各自记账（预测市场失败/宏观日历失败互不影响）、快照不足时不
 * 显示变动。数据面经组件注入缝传入真实函数替身——不使用通用 mock 工具（测试卫生
 * 棘轮禁 mock，新文件带违规即红）。
 *
 * @vitest-environment jsdom
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type {
  ClientMacroCalendarEntry,
  ClientPredictionBucket,
  ClientPredictionHistory,
  ClientPredictionHistoryRequest,
  ClientPredictionHistoryResult,
  ClientPredictionHistorySeries,
  ClientPredictionMeeting,
  ClientPredictionResult,
} from '../src/client/api.ts'
import type { MarketLocaleKey } from '../src/client/contract.ts'
import { PolymarketPanel } from '../src/client/PolymarketPanel.tsx'
import { HISTORY_FIDELITY_MINUTES, HISTORY_WINDOW_MS } from '../src/client/prediction-view.ts'

/** key 直出翻译（断言用 key 而非文案，与词典解耦）。 */
const t = (key: MarketLocaleKey): string => key

/** 档位构造（默认取 December No change 的真实读数）。 */
function bucket(over: Partial<ClientPredictionBucket> = {}): ClientPredictionBucket {
  return {
    key: 'no_change',
    label: 'No change',
    changeBps: 0,
    probability: 0.225,
    bestBid: 0.22,
    bestAsk: 0.23,
    spread: 0.01,
    liquidity: 213712.9581,
    acceptingOrders: true,
    closed: false,
    ...over,
  }
}

function meeting(over: Partial<ClientPredictionMeeting> = {}): ClientPredictionMeeting {
  return {
    id: '770450',
    slug: 'fed-decision-in-december',
    title: 'Fed Decision in December?',
    endDate: '2026-12-10T04:59:00Z',
    meetingWindow: 'December 8-9, 2026',
    closed: false,
    buckets: [bucket()],
    probabilitySum: 1.004,
    degraded: [],
    ...over,
  }
}

const okResult = (meetings: ClientPredictionMeeting[]): ClientPredictionResult =>
  ({ status: 'ok', fetchedAt: '2026-10-11T01:55:19Z', meetings })

/** 历史回填成功信封（默认 meetingId 与注入的观察会议一致）。 */
function historyOk(series: ClientPredictionHistorySeries[], over: Partial<ClientPredictionHistory> = {}): ClientPredictionHistoryResult {
  return {
    status: 'ok',
    history: { meetingId: '770450', fromMs: 0, toMs: 0, fidelityMinutes: HISTORY_FIDELITY_MINUTES, series, ...over },
  }
}

const cal = (over: Partial<ClientMacroCalendarEntry> = {}): ClientMacroCalendarEntry => ({
  publishedAt: '2026-09-14T12:30:00.000Z',
  star: 3,
  region: '美国', // i18n-allow: 上游数据词汇
  title: '美国9月核心CPI年率', // i18n-allow: 上游数据词汇
  ...over,
})

/** 固定时钟：采样时间轴可预期。 */
const fixedNow = (): number => Date.parse('2026-10-11T02:00:00Z')

describe('PolymarketPanel 只读展示与质量标记', () => {
  afterEach(() => cleanup())

  it('用户打开面板即见下一次会议的档位概率与上游档位原义标签', async () => {
    // Given 桥面返回一场未结算会议，含 No change 与 25 bps decrease 两档
    //（December 会议实测读数：mid 0.225/ask 0.23 与 mid 0.0125/ask 0.013）
    const deps = {
      fetchPrediction: async () => okResult([meeting({
        buckets: [
          bucket(),
          bucket({ key: 'dec_25', label: '25 bps decrease', changeBps: -25, probability: 0.0125, bestBid: 0.012, bestAsk: 0.013, spread: 0.001, liquidity: 115231.32475 }),
        ],
      })]),
      fetchCalendar: async () => [],
      now: fixedNow,
    }
    // When 渲染面板
    const view = render(<PolymarketPanel t={t} onClose={() => {}} deps={deps} />)
    // Then 会议标题、档位标签与 ask 口径概率都在屏上
    await waitFor(() => { expect(view.container.querySelector('[data-dshtrading-prediction-meeting="770450"]')).not.toBeNull() })
    expect(screen.queryByText('Fed Decision in December?')).not.toBeNull()
    expect(screen.queryByText('No change')).not.toBeNull()
    expect(screen.queryByText('25 bps decrease')).not.toBeNull()
    expect(screen.queryByText('23.0%')).not.toBeNull()
    expect(screen.queryByText('1.3%')).not.toBeNull()
    expect(view.container.querySelector('[data-dshtrading-polymarket-panel]')?.textContent).toContain('prediction.basisAsk')
  })

  it('用户看到深度不足的档位被显式标注而不是画成信号', async () => {
    // Given 一场会议含一个深度 87,901 美元的尾部档位
    const deps = {
      fetchPrediction: async () => okResult([meeting({ buckets: [bucket({ key: 'dec_25', label: '25 bps decrease', changeBps: -25, liquidity: 87901.3664 })] })]),
      fetchCalendar: async () => [],
      now: fixedNow,
    }
    // When 渲染面板
    const view = render(<PolymarketPanel t={t} onClose={() => {}} deps={deps} />)
    // Then 该档位带 thin-depth 标记，文案是「深度不足」
    await waitFor(() => { expect(view.container.querySelector('[data-mark="thin-depth"]')).not.toBeNull() })
    expect(view.container.querySelector('[data-mark="thin-depth"]')?.textContent).toBe('prediction.thinDepth')
  })

  it('用户看到概率和偏离 1 的会议收到可见提示并带上实际和值', async () => {
    // Given 一场会议的 probabilitySum 为 1.09（越界）
    const deps = {
      fetchPrediction: async () => okResult([meeting({ probabilitySum: 1.09 })]),
      fetchCalendar: async () => [],
      now: fixedNow,
    }
    // When 渲染面板
    const view = render(<PolymarketPanel t={t} onClose={() => {}} deps={deps} />)
    // Then 提示可见，且 data 属性带上和值供抽查
    await waitFor(() => { expect(view.container.querySelector('[data-dshtrading-prediction-sum]')).not.toBeNull() })
    expect(view.container.querySelector('[data-dshtrading-prediction-sum]')?.getAttribute('data-dshtrading-prediction-sum')).toBe('1.090')
    expect(view.container.querySelector('[data-dshtrading-prediction-sum]')?.textContent).toContain('prediction.sumOffBand')
  })

  it('用户看到概率和正常的会议不带偏离提示', async () => {
    // Given 一场会议和为 1.004（正常区间内）
    const deps = {
      fetchPrediction: async () => okResult([meeting({ probabilitySum: 1.004 })]),
      fetchCalendar: async () => [],
      now: fixedNow,
    }
    // When 渲染面板
    const view = render(<PolymarketPanel t={t} onClose={() => {}} deps={deps} />)
    // Then 无偏离提示（不静默报警，也不漏报）
    await waitFor(() => { expect(view.container.querySelector('[data-dshtrading-prediction-meeting="770450"]')).not.toBeNull() })
    expect(view.container.querySelector('[data-dshtrading-prediction-sum]')).toBeNull()
  })

  it('用户看到快照不足的档位不显示变动', async () => {
    // Given 首次采样（changeSincePrevious 缺省），概率 0.23
    const deps = {
      fetchPrediction: async () => okResult([meeting({ buckets: [bucket({ changeSincePrevious: undefined })] })]),
      fetchCalendar: async () => [],
      now: fixedNow,
    }
    // When 渲染面板
    const view = render(<PolymarketPanel t={t} onClose={() => {}} deps={deps} />)
    // Then 概率在屏上，但没有任何变动文本（没有 '+0.0pp'）
    await waitFor(() => { expect(screen.queryByText('23.0%')).not.toBeNull() })
    expect(view.container.querySelector('[data-sign]')).toBeNull()
  })

  it('用户看到有快照对比的档位显示带符号变动', async () => {
    // Given 快照对比显示 No change 档下移 4 个百分点
    const deps = {
      fetchPrediction: async () => okResult([meeting({ buckets: [bucket({ changeSincePrevious: -0.04 })] })]),
      fetchCalendar: async () => [],
      now: fixedNow,
    }
    // When 渲染面板
    const view = render(<PolymarketPanel t={t} onClose={() => {}} deps={deps} />)
    // Then 变动文本为 -4.0pp，方向标记为 down
    await waitFor(() => { expect(view.container.querySelector('[data-sign="down"]')).not.toBeNull() })
    expect(view.container.querySelector('[data-sign="down"]')?.textContent).toBe('-4.0pp')
  })

  it('用户看到后续会议一并上屏，且低深度档位在更远会议里被标出', async () => {
    // Given 最近一场（October）深度充足、后续一场（January）尾部档位深度不足
    const october = meeting({ id: '606422', title: 'Fed Decision in October?', buckets: [bucket()] })
    const january = meeting({
      id: '770451',
      title: 'Fed Decision in January?',
      buckets: [bucket({ key: 'dec_25', label: '25 bps decrease', changeBps: -25, liquidity: 87901.3664 })],
    })
    const deps = {
      fetchPrediction: async () => okResult([october, january]),
      fetchCalendar: async () => [],
      now: fixedNow,
    }
    // When 渲染面板
    const view = render(<PolymarketPanel t={t} onClose={() => {}} deps={deps} />)
    // Then 两场会议都在屏上，且低深度标记出现在 January 那一场上
    await waitFor(() => { expect(view.container.querySelector('[data-dshtrading-prediction-meeting="770451"]')).not.toBeNull() })
    expect(view.container.querySelector('[data-dshtrading-prediction-meeting="606422"]')).not.toBeNull()
    const januaryRow = view.container.querySelector('[data-dshtrading-prediction-meeting="770451"]')!
    expect(januaryRow.querySelector('[data-mark="thin-depth"]')).not.toBeNull()
    expect(view.container.querySelectorAll('[data-mark="thin-depth"]').length).toBe(1)
  })

  it('用户看到上屏会议数封顶，更远的会议不铺开', async () => {
    // Given 五场未结算会议
    const deps = {
      fetchPrediction: async () => okResult(['1', '2', '3', '4', '5'].map((id) => meeting({ id }))),
      fetchCalendar: async () => [],
      now: fixedNow,
    }
    // When 渲染面板
    const view = render(<PolymarketPanel t={t} onClose={() => {}} deps={deps} />)
    // Then 上屏恰好三场
    await waitFor(() => { expect(view.container.querySelector('[data-dshtrading-prediction-meeting="1"]')).not.toBeNull() })
    expect(view.container.querySelectorAll('[data-dshtrading-prediction-meeting]').length).toBe(3)
    expect(view.container.querySelector('[data-dshtrading-prediction-meeting="4"]')).toBeNull()
  })
})

describe('PolymarketPanel 双源各自记账', () => {
  afterEach(() => cleanup())

  it('用户看到预测市场未安装时的可操作提示而不是「没有数据」', async () => {
    // Given 桥面报 TRADING_NOT_IMPLEMENTED（连接器未装）
    const deps = {
      fetchPrediction: async (): Promise<ClientPredictionResult> => ({ status: 'error', code: 'TRADING_NOT_IMPLEMENTED', message: 'feed not mounted' }),
      fetchCalendar: async () => [],
      now: fixedNow,
    }
    // When 渲染面板
    const view = render(<PolymarketPanel t={t} onClose={() => {}} deps={deps} />)
    // Then 出「未安装」提示（不是空态文案），并带上 code 供归因
    await waitFor(() => { expect(view.container.querySelector('[data-dshtrading-prediction-error]')).not.toBeNull() })
    expect(view.container.querySelector('[data-dshtrading-prediction-error]')?.getAttribute('data-dshtrading-prediction-error')).toBe('TRADING_NOT_IMPLEMENTED')
    expect(view.container.querySelector('[data-dshtrading-prediction-error]')?.textContent).toBe('prediction.errorNotInstalled')
  })

  it('用户看到上游失败的提示与未安装提示可区分', async () => {
    // Given 桥面报上游错误（连接器在，但上游 403）
    const deps = {
      fetchPrediction: async (): Promise<ClientPredictionResult> => ({ status: 'error', code: 'TRADING_UPSTREAM_ERROR', message: 'HTTP 403' }),
      fetchCalendar: async () => [],
      now: fixedNow,
    }
    // When 渲染面板
    const view = render(<PolymarketPanel t={t} onClose={() => {}} deps={deps} />)
    // Then 出通用错误提示（与未安装文案不同）
    await waitFor(() => { expect(view.container.querySelector('[data-dshtrading-prediction-error]')).not.toBeNull() })
    expect(view.container.querySelector('[data-dshtrading-prediction-error]')?.textContent).toBe('prediction.error')
  })

  it('用户看到宏观日历失败只影响事件对照那一块，档位概率照常显示', async () => {
    // Given 预测市场正常、宏观日历返回 null（金十连接器不可用）
    const deps = {
      fetchPrediction: async () => okResult([meeting()]),
      fetchCalendar: async () => null,
      now: fixedNow,
    }
    // When 渲染面板
    const view = render(<PolymarketPanel t={t} onClose={() => {}} deps={deps} />)
    // Then 档位概率照常，事件块单独出错误提示
    await waitFor(() => { expect(view.container.querySelector('[data-dshtrading-prediction-meeting="770450"]')).not.toBeNull() })
    expect(screen.queryByText('23.0%')).not.toBeNull()
    expect(screen.queryByText('prediction.calendarError')).not.toBeNull()
  })

  it('用户看到预测市场失败时事件块仍独立渲染', async () => {
    // Given 预测市场不可用、日历正常运行
    const deps = {
      fetchPrediction: async (): Promise<ClientPredictionResult> => ({ status: 'error', code: 'TRADING_UPSTREAM_ERROR', message: 'HTTP 403' }),
      fetchCalendar: async () => [],
      now: fixedNow,
    }
    // When 渲染面板
    const view = render(<PolymarketPanel t={t} onClose={() => {}} deps={deps} />)
    // Then 预测市场错误可见，且事件块不误报日历错误
    await waitFor(() => { expect(view.container.querySelector('[data-dshtrading-prediction-error]')).not.toBeNull() })
    expect(screen.queryByText('prediction.calendarError')).toBeNull()
  })

  it('用户看到全部会议已结算时面板说明没有未结算市场', async () => {
    // Given 上游返回的会议全部已结算
    const deps = {
      fetchPrediction: async () => okResult([meeting({ closed: true })]),
      fetchCalendar: async () => [],
      now: fixedNow,
    }
    // When 渲染面板
    const view = render(<PolymarketPanel t={t} onClose={() => {}} deps={deps} />)
    // Then 出「暂无未结算」空态（不是错误提示）
    await waitFor(() => { expect(screen.queryByText('prediction.noMeeting')).not.toBeNull() })
    expect(view.container.querySelector('[data-dshtrading-prediction-error]')).toBeNull()
  })

  it('用户看到取数器抛错时面板仍出错误提示而不是崩溃', async () => {
    // Given 取数函数直接 reject（桥不可达）
    const deps = {
      fetchPrediction: async (): Promise<ClientPredictionResult> => { throw new Error('bridge unreachable') },
      fetchCalendar: async () => { throw new Error('bridge unreachable') },
      now: fixedNow,
    }
    // When 渲染面板
    const view = render(<PolymarketPanel t={t} onClose={() => {}} deps={deps} />)
    // Then 预测市场出错误提示、日历出日历错误提示，组件不崩
    await waitFor(() => { expect(view.container.querySelector('[data-dshtrading-prediction-error]')).not.toBeNull() })
    expect(screen.queryByText('prediction.calendarError')).not.toBeNull()
  })

  it('用户看到近 30 天没有已公布事件时事件块出空态而不是伪造事件行', async () => {
    // Given 日历里只有一条 2026-08-01 的美国 CPI（超出上游 30 天历史保留期）
    const requests: ClientPredictionHistoryRequest[] = []
    const deps = {
      fetchPrediction: async () => okResult([meeting()]),
      fetchCalendar: async () => [cal({ publishedAt: '2026-08-01T12:30:00.000Z' })],
      fetchHistory: async (request: ClientPredictionHistoryRequest): Promise<ClientPredictionHistoryResult> => {
        requests.push(request)
        return historyOk([])
      },
      now: fixedNow,
    }
    // When 渲染面板
    const view = render(<PolymarketPanel t={t} onClose={() => {}} deps={deps} />)
    // Then 空态文案在屏上、没有事件行、也没有发出任何回填请求
    await waitFor(() => { expect(screen.queryByText('prediction.noComparable')).not.toBeNull() })
    expect(view.container.querySelector('[data-dshtrading-event]')).toBeNull()
    expect(requests).toEqual([])
  })

  it('用户看到面板不提供任何下单或交易入口', async () => {
    // Given 正常数据下的面板
    const deps = {
      fetchPrediction: async () => okResult([meeting()]),
      fetchCalendar: async () => [],
      now: fixedNow,
    }
    // When 渲染面板
    const view = render(<PolymarketPanel t={t} onClose={() => {}} deps={deps} />)
    // Then 只有关闭按钮，没有任何交易类按钮或表单
    await waitFor(() => { expect(view.container.querySelector('[data-dshtrading-prediction-meeting="770450"]')).not.toBeNull() })
    expect(screen.getAllByRole('button').length).toBe(1)
    expect(view.container.querySelector('form')).toBeNull()
    expect(view.container.querySelector('input')).toBeNull()
  })
})

describe('PolymarketPanel 事件对照回填（mid 口径与会话段合并）', () => {
  afterEach(() => cleanup())

  /** 27 天前的美国 CPI 时点（在上游 30 天保留期内）。 */
  const eventAt = Date.parse('2026-09-14T12:30:00Z')

  it('用户看到回填成功后事件行给出跨事件的 mid 位移并标为可对照', async () => {
    // Given 回填覆盖事件前后各一小时（mid 0.20 → 0.30），主表显示值仍是 bestAsk 0.23
    const deps = {
      fetchPrediction: async () => okResult([meeting()]),
      fetchCalendar: async () => [cal()],
      fetchHistory: async (): Promise<ClientPredictionHistoryResult> => historyOk([{
        bucketKey: 'no_change',
        points: [{ t: eventAt / 1000 - 3600, p: 0.2 }, { t: eventAt / 1000 + 3600, p: 0.3 }],
      }]),
      now: fixedNow,
    }
    // When 渲染面板
    const view = render(<PolymarketPanel t={t} onClose={() => {}} deps={deps} />)
    // Then 事件行标为 comparable，读数取 mid 的前后值与差值
    await waitFor(() => { expect(view.container.querySelector('[data-dshtrading-event-state="comparable"]')).not.toBeNull() })
    const delta = view.container.querySelector('[data-dshtrading-event-delta]')!
    expect(delta.getAttribute('data-dshtrading-event-delta')).toBe('770450:no_change')
    expect(delta.textContent).toContain('20.0%')
    expect(delta.textContent).toContain('30.0%')
    expect(delta.textContent).toContain('+10.0pp')
    // 口径标注在事件块标题下、主表显示值仍取 bestAsk
    expect(view.container.querySelector('[data-dshtrading-event-basis]')?.textContent).toBe('prediction.basisComparison')
    expect(screen.queryByText('23.0%')).not.toBeNull()
  })

  it('用户看到会话采样取 mid：同一档位 bestAsk 0.23 时对照读数用 22.5%', async () => {
    // Given 事件在 2 小时前（右端夹到 now），回填只覆盖事件前那一段 0.20，
    // 事件后那一段只能来自会话采样（no_change 的 probability/mid = 0.225、bestAsk = 0.23）
    const past = fixedNow() - 2 * 3600_000
    const deps = {
      fetchPrediction: async () => okResult([meeting()]),
      fetchCalendar: async () => [cal({ publishedAt: new Date(past).toISOString() })],
      fetchHistory: async (): Promise<ClientPredictionHistoryResult> => historyOk([{
        bucketKey: 'no_change',
        points: [{ t: (past - 3600_000) / 1000, p: 0.2 }],
      }]),
      now: fixedNow,
    }
    // When 渲染面板
    const view = render(<PolymarketPanel t={t} onClose={() => {}} deps={deps} />)
    // Then 对照的后一段取 mid 22.5%（若误用 bestAsk 会是 23.0% / +3.0pp）
    await waitFor(() => { expect(view.container.querySelector('[data-dshtrading-event-state="comparable"]')).not.toBeNull() })
    const delta = view.container.querySelector('[data-dshtrading-event-delta]')!
    expect(delta.textContent).toContain('20.0%')
    expect(delta.textContent).toContain('22.5%')
    expect(delta.textContent).toContain('+2.5pp')
    expect(delta.textContent).not.toContain('23.0%')
    // 主表显示仍是 bestAsk 23.0%（两个口径各自出口）
    expect(screen.queryByText('23.0%')).not.toBeNull()
  })

  it('用户看到回填返回空 series 时明说上游历史不覆盖该时点', async () => {
    // Given 回填成功但没有任何序列（上游历史不覆盖该窗口）
    const deps = {
      fetchPrediction: async () => okResult([meeting()]),
      fetchCalendar: async () => [cal()],
      fetchHistory: async (): Promise<ClientPredictionHistoryResult> => historyOk([]),
      now: fixedNow,
    }
    // When 渲染面板
    const view = render(<PolymarketPanel t={t} onClose={() => {}} deps={deps} />)
    // Then 该事件标为 uncovered，文案是「上游历史不覆盖该时点」，没有伪造的变动
    await waitFor(() => { expect(view.container.querySelector('[data-dshtrading-event-state="uncovered"]')).not.toBeNull() })
    expect(view.container.querySelector('[data-dshtrading-event]')?.textContent).toContain('prediction.eventUncovered')
    expect(view.container.querySelector('[data-dshtrading-event-delta]')).toBeNull()
  })

  it('用户看到回填只覆盖事件之后那一段时判采样不足而不是显示 0 变动', async () => {
    // Given 回填有序列但只有事件之后的一个点（事件前那一段缺失）
    const deps = {
      fetchPrediction: async () => okResult([meeting()]),
      fetchCalendar: async () => [cal()],
      fetchHistory: async (): Promise<ClientPredictionHistoryResult> => historyOk([{
        bucketKey: 'no_change',
        points: [{ t: eventAt / 1000 + 3600, p: 0.3 }],
      }]),
      now: fixedNow,
    }
    // When 渲染面板
    const view = render(<PolymarketPanel t={t} onClose={() => {}} deps={deps} />)
    // Then 标为 insufficient（有覆盖但单侧缺失），且不显示任何变动读数
    await waitFor(() => { expect(view.container.querySelector('[data-dshtrading-event-state="insufficient"]')).not.toBeNull() })
    expect(view.container.querySelector('[data-dshtrading-event-insufficient]')?.textContent).toBe('prediction.eventInsufficient')
    expect(view.container.querySelector('[data-dshtrading-event-delta]')).toBeNull()
  })

  it('用户看到回填失败时出可操作提示，档位表与会话采样照常', async () => {
    // Given 桥面把回填报成上游错误（显式错误状态，不是空序列）
    const deps = {
      fetchPrediction: async () => okResult([meeting()]),
      fetchCalendar: async () => [cal()],
      fetchHistory: async (): Promise<ClientPredictionHistoryResult> => ({ status: 'error', code: 'TRADING_UPSTREAM_ERROR', message: 'HTTP 403' }),
      now: fixedNow,
    }
    // When 渲染面板
    const view = render(<PolymarketPanel t={t} onClose={() => {}} deps={deps} />)
    // Then 该事件标为 history-error 并带 code；档位表、事件行与日历块都不受影响
    await waitFor(() => { expect(view.container.querySelector('[data-dshtrading-event-state="history-error"]')).not.toBeNull() })
    expect(view.container.querySelector('[data-dshtrading-event-error]')?.getAttribute('data-dshtrading-event-error')).toBe('TRADING_UPSTREAM_ERROR')
    expect(view.container.querySelector('[data-dshtrading-event]')?.textContent).toContain('prediction.eventHistoryError')
    expect(screen.queryByText('23.0%')).not.toBeNull()
    expect(view.container.textContent).toContain(cal().title)
    expect(screen.queryByText('prediction.calendarError')).toBeNull()
  })

  it('用户看到每个事件只回填一次：重渲染不重拉，窗口与间隔按约定', async () => {
    // Given 一次注入的回填器记录每次请求
    const requests: ClientPredictionHistoryRequest[] = []
    const deps = {
      fetchPrediction: async () => okResult([meeting()]),
      fetchCalendar: async () => [cal()],
      fetchHistory: async (request: ClientPredictionHistoryRequest): Promise<ClientPredictionHistoryResult> => {
        requests.push(request)
        return historyOk([{
          bucketKey: 'no_change',
          points: [{ t: eventAt / 1000 - 3600, p: 0.2 }, { t: eventAt / 1000 + 3600, p: 0.3 }],
        }])
      },
      now: fixedNow,
    }
    // When 渲染面板，随后换一个 now 函数身份再渲染一轮（取数效应重跑）
    const view = render(<PolymarketPanel t={t} onClose={() => {}} deps={deps} />)
    await waitFor(() => { expect(view.container.querySelector('[data-dshtrading-event-state="comparable"]')).not.toBeNull() })
    // Then 请求恰好一次，且 meetingId / 窗口 / 间隔按约定
    expect(requests).toEqual([{ meetingId: '770450', fromMs: eventAt - HISTORY_WINDOW_MS, toMs: eventAt + HISTORY_WINDOW_MS, fidelityMinutes: 5 }])
    view.rerender(<PolymarketPanel t={t} onClose={() => {}} deps={{ ...deps, now: () => fixedNow() }} />)
    await waitFor(() => { expect(view.container.querySelector('[data-dshtrading-event-state="comparable"]')).not.toBeNull() })
    expect(requests.length).toBe(1)
  })
})

describe('PolymarketPanel 对照轴细节（跨档网格 / 裁剪上限 / 失败不重试）', () => {
  afterEach(() => cleanup())

  it('用户看到密集历史（48h/5min ≈ 577 点）时事件前的最近读数不会被裁掉', async () => {
    // Given 事件在 26h 前，回填覆盖事件前后各 24h 的 5 分钟密点（577 点，远超 MAX_SAMPLES=240），
    // 其中事件时刻及之前的最近点为 0.20（`at <= 事件时刻` 算「之前」）、事件后 5 分钟为 0.25
    const past = fixedNow() - 26 * 3600_000
    const points: { t: number; p: number }[] = []
    for (let ms = past - HISTORY_WINDOW_MS; ms <= past + HISTORY_WINDOW_MS; ms += 300_000) {
      const p = ms <= past ? 0.2 : ms === past + 300_000 ? 0.25 : 0.22
      points.push({ t: ms / 1000, p })
    }
    const deps = {
      fetchPrediction: async () => okResult([meeting()]),
      fetchCalendar: async () => [cal({ publishedAt: new Date(past).toISOString() })],
      fetchHistory: async (): Promise<ClientPredictionHistoryResult> => historyOk([{ bucketKey: 'no_change', points }]),
      now: fixedNow,
    }
    // When 渲染面板
    const view = render(<PolymarketPanel t={t} onClose={() => {}} deps={deps} />)
    // Then 仍是 comparable 且读数取事件两侧最近的 0.20 → 0.25（按 240 点裁尾会只剩后 20h → 退化）
    await waitFor(() => { expect(view.container.querySelector('[data-dshtrading-event-state="comparable"]')).not.toBeNull() })
    expect(points.length).toBe(577)
    const delta = view.container.querySelector('[data-dshtrading-event-delta]')!
    expect(delta.textContent).toContain('20.0%')
    expect(delta.textContent).toContain('25.0%')
    expect(delta.textContent).toContain('+5.0pp')
  })

  it('用户看到回填失败后不会每轮 60s 反复重拉同一个事件', async () => {
    // Given 回填器每次调用都把它记录下来了（桥面报上游错误）
    const requests: ClientPredictionHistoryRequest[] = []
    const deps = {
      fetchPrediction: async () => okResult([meeting()]),
      fetchCalendar: async () => [cal()],
      fetchHistory: async (request: ClientPredictionHistoryRequest): Promise<ClientPredictionHistoryResult> => {
        requests.push(request)
        return { status: 'error', code: 'TRADING_UPSTREAM_ERROR', message: 'HTTP 403' }
      },
      now: fixedNow,
    }
    // When 渲染面板 → 等失败态 → 换 now 函数身份再渲染一轮（取数效应重跑，等同下一轮轮询）
    const view = render(<PolymarketPanel t={t} onClose={() => {}} deps={deps} />)
    await waitFor(() => { expect(view.container.querySelector('[data-dshtrading-event-state="history-error"]')).not.toBeNull() })
    // Then 失败也记进账本：请求只有一次，重跑后仍是 history-error 而不是退回 pending/重试
    expect(requests.length).toBe(1)
    view.rerender(<PolymarketPanel t={t} onClose={() => {}} deps={{ ...deps, now: () => fixedNow() }} />)
    await waitFor(() => { expect(view.container.querySelector('[data-dshtrading-event-state="history-error"]')).not.toBeNull() })
    expect(requests.length).toBe(1)
    expect(view.container.querySelector('[data-dshtrading-event-error]')?.getAttribute('data-dshtrading-event-error')).toBe('TRADING_UPSTREAM_ERROR')
  })
})
