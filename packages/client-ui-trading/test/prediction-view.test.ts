/**
 * 预测市场面板纯判据单测（2026-10-11）：质量阈值、显示口径、健康检查、变动缺省
 * 语义、会话内采样与事件对齐。这些判据决定「什么算噪声、什么算信号」，必须能
 * 离线复算——上游实测分布见 spikes/impl-polymarket/（liquidityNum 87.9k–956k、
 * spread 0.001–0.012）。
 *
 * 数值取 connector-live-ACCEPTANCE.md §5 的 December 会议真实读数，使断言对着
 * 真实上游数据而不是编造的样本。
 */
import { describe, expect, it } from 'vitest'
import type { ClientPredictionBucket, ClientPredictionMeeting } from '../src/client/api.ts'
import {
  candidateEventsOf,
  eventComparisonOf,
  historyWindowOf,
  MAX_SAMPLES,
  MIN_LIQUIDITY_USD,
  appendSample,
  displayProbabilityOf,
  formatDeltaPp,
  formatProbability,
  HISTORY_FIDELITY_MINUTES,
  HISTORY_MAX_AGE_MS,
  HISTORY_WINDOW_MS,
  inflationEventsOf,
  largestMovementAround,
  meetingViewOf,
  mergeSamples,
  movementAround,
  nextMeetingOf,
  probabilityBasisOf,
  qualityMarksOf,
  samplesFromHistory,
  sumHealthOf,
  visibleMeetingsOf,
  VISIBLE_MEETINGS,
  type InflationEvent,
  type ProbabilitySample,
} from '../src/client/prediction-view.ts'

/** 档位构造（只给判据关心的字段，其余按真实读数给稳定默认）。 */
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

describe('质量标记（深度/价差是两个独立维度）', () => {
  it('用户看到深度达标的档位不带任何质量标记', () => {
    // Given 一个深度 213,712 美元、价差 0.01 的档位（December No change 的真实读数）
    const real = bucket()
    // When 计算质量标记
    const marks = qualityMarksOf(real)
    // Then 两项都达标 → 空数组（不标注）
    expect(marks).toEqual([])
  })

  it('用户看到深度低于阈值的档位被标注「深度不足」', () => {
    // Given 深度 87,901 美元的 January 尾部档位（实测最小值）
    const thin = bucket({ key: 'dec_25', liquidity: 87901.3664 })
    // When 计算质量标记
    const marks = qualityMarksOf(thin)
    // Then 只出 thin-depth 一枚（价差 0.01 仍达标）
    expect(marks).toEqual(['thin-depth'])
  })

  it('用户看到价差过宽的档位被标注「价差过宽」而不是混成一个词', () => {
    // Given 深度充足但价差 0.03 的档位（高于实测最大 0.012）
    const wide = bucket({ spread: 0.03, liquidity: 500_000 })
    // When 计算质量标记
    const marks = qualityMarksOf(wide)
    // Then 只出 wide-spread（深度达标），与 thin-depth 可区分
    expect(marks).toEqual(['wide-spread'])
  })

  it('用户看到深度与价差同时不达标的档位带两枚标记', () => {
    // Given 深度与价差双双不达标
    const bad = bucket({ liquidity: 1000, spread: 0.05 })
    // When 计算质量标记
    const marks = qualityMarksOf(bad)
    // Then 两枚标记都在
    expect(marks).toEqual(['thin-depth', 'wide-spread'])
  })

  it('用户看到上游未给深度/价差的档位不被误标（不知道不等于不达标）', () => {
    // Given 上游缺 liquidity 与 spread（结算后实测形态）
    const unknown = bucket({ liquidity: undefined, spread: undefined })
    // When 计算质量标记
    const marks = qualityMarksOf(unknown)
    // Then 无标记——缺字段不是「不达标」，不该画成噪声
    expect(marks).toEqual([])
  })

  it('用户看到阈值边界上的档位按 >= / <= 侧判达标', () => {
    // Given 深度恰好等于下限、价差恰好等于上限
    const edge = bucket({ liquidity: MIN_LIQUIDITY_USD, spread: 0.02 })
    // When 计算质量标记
    const marks = qualityMarksOf(edge)
    // Then 边界值算达标（严格小于/大于才标注）
    expect(marks).toEqual([])
  })
})

describe('显示口径（与 Polymarket 网页一致）', () => {
  it('用户看到的概率等于上游 bestAsk 而不是 mid', () => {
    // Given December No change 档：mid 0.225、网页显示 0.23
    const real = bucket()
    // When 取显示概率与基准
    const shown = displayProbabilityOf(real)
    const basis = probabilityBasisOf(real)
    // Then 显示值取 ask（与网页逐值一致），基准标为 ask
    expect(shown).toBe(0.23)
    expect(basis).toBe('ask')
  })

  it('用户看到结算后 bestAsk 缺失的档位回落到 mid 并标注基准', () => {
    // Given 结算后 bestAsk 缺省（上游为 null）
    const settled = bucket({ bestAsk: undefined, probability: 0.0035 })
    // When 取显示概率与基准
    const shown = displayProbabilityOf(settled)
    const basis = probabilityBasisOf(settled)
    // Then 回落 mid，且基准如实标为 mid（不静默换口径）
    expect(shown).toBe(0.0035)
    expect(basis).toBe('mid')
  })

  it('用户看到的概率按百分比一位小数渲染', () => {
    // Given 一个 mid 为 0.0295 的档位（实测 50+ bps increase 档）
    // When 格式化
    const text = formatProbability(0.0295)
    // Then 一位小数百分比（0.0295*100 = 2.9499… 按 toFixed 截到 2.9）
    expect(text).toBe('2.9%')
  })
})

describe('变动缺省语义（不知道不等于没变）', () => {
  it('用户看到快照不足的档位不显示变动而不是显示 0', () => {
    // Given 首次采样（changeSincePrevious 缺省）
    // When 格式化变动
    const text = formatDeltaPp(undefined)
    // Then 返回 undefined（渲染层整块不画），绝不是 '+0.0pp'
    expect(text).toBeUndefined()
  })

  it('用户看到确知没变的档位显示 0 变动', () => {
    // Given 快照对比确知无变化（delta = 0）
    // When 格式化变动
    const text = formatDeltaPp(0)
    // Then 显示 0.0pp——与「不知道」（undefined，整块不画）在渲染上可区分
    expect(text).toBe('0.0pp')
  })

  it('用户看到概率上升与下降的变动带符号与百分点单位', () => {
    // Given CPI 公布后 No change 档下移 4 个百分点、25 bps increase 上移 4 个
    // When 分别格式化
    const down = formatDeltaPp(-0.04)
    const up = formatDeltaPp(0.04)
    // Then 两个方向都带符号，单位是 pp（不是概率原值）
    expect(down).toBe('-4.0pp')
    expect(up).toBe('+4.0pp')
  })
})

describe('健康检查（概率和越界只提示不改写）', () => {
  it('用户看到概率和在正常区间的会议不带提示', () => {
    // Given 实测正常区间 [0.98, 1.03] 内的和
    // When 判健康
    // Then 正常区间内的两端都算 ok
    expect(sumHealthOf(0.98)).toBe('ok')
    expect(sumHealthOf(1.03)).toBe('ok')
    expect(sumHealthOf(1.004)).toBe('ok')
  })

  it('用户看到概率和偏离 1 的会议收到可见提示', () => {
    // Given 越界和（低于下界与高于上界）
    // When 判健康
    // Then 两侧都报 off-band，不静默
    expect(sumHealthOf(0.97)).toBe('off-band')
    expect(sumHealthOf(1.04)).toBe('off-band')
  })
})

describe('会议视图模型', () => {
  it('用户看到的会议室取第一场未结算的会议', () => {
    // Given 三场会议，前两场已结算
    const meetings = [
      { ...meeting('1', true) },
      { ...meeting('2', true) },
      { ...meeting('3', false) },
    ]
    // When 取下一场
    const next = nextMeetingOf(meetings)
    // Then 命中第一场未结算的（id 3）
    expect(next?.id).toBe('3')
  })

  it('用户看到全部会议都已结算时不假装还有下一场', () => {
    // Given 三场会议全部已结算
    const meetings = [meeting('1', true), meeting('2', true)]
    // When 取下一场
    const next = nextMeetingOf(meetings)
    // Then undefined（面板显示已结算态）
    expect(next).toBeUndefined()
  })

  it('用户看到后续会议一并上屏（低深度形态常出现在更远的会议）', () => {
    // Given 三场未结算会议
    const meetings = [meeting('1', false), meeting('2', false), meeting('3', false)]
    // When 取上屏会议组
    const shown = visibleMeetingsOf(meetings)
    // Then 三场都在，且保持上游顺序
    expect(shown.map((item) => item.id)).toEqual(['1', '2', '3'])
  })

  it('用户看到已结算会议被挤出上屏会议组', () => {
    // Given 一场已结算会议排在前面、两场未结算在后面
    const meetings = [meeting('1', true), meeting('2', false), meeting('3', false)]
    // When 取上屏会议组
    const shown = visibleMeetingsOf(meetings)
    // Then 只剩未结算的两场
    expect(shown.map((item) => item.id)).toEqual(['2', '3'])
  })

  it('用户看到上屏会议数被封顶而不是把全部会议铺开', () => {
    // Given 五场未结算会议
    const meetings = ['1', '2', '3', '4', '5'].map((id) => meeting(id, false))
    // When 取上屏会议组
    const shown = visibleMeetingsOf(meetings)
    // Then 恰好取到上限场
    expect(shown.length).toBe(VISIBLE_MEETINGS)
    expect(shown.map((item) => item.id)).toEqual(['1', '2', '3'])
  })

  it('用户看到档位行同时带上显示概率、方向与质量标记', () => {
    // Given 一场含低深度档位的会议
    const view = meetingViewOf(meeting('606422', false, [
      bucket({ key: 'no_change', label: 'No change', changeBps: 0 }),
      bucket({ key: 'dec_25', label: '25 bps decrease', changeBps: -25, liquidity: 1000 }),
    ]))
    // When 读档位行
    const [hold, cut] = view.buckets
    // Then 标签用上游原义、方向带 bps、低深度档位带标记
    expect(view.buckets.length).toBe(2)
    expect(hold?.label).toBe('No change')
    expect(hold?.changeBps).toBe(0)
    expect(hold?.marks).toEqual([])
    expect(cut?.label).toBe('25 bps decrease')
    expect(cut?.changeBps).toBe(-25)
    expect(cut?.marks).toEqual(['thin-depth'])
  })
})

/** 会议构造（只给判据关心的字段）。 */
function meeting(id: string, closed: boolean, buckets: ClientPredictionBucket[] = [bucket()]): ClientPredictionMeeting {
  return {
    id,
    slug: `slug-${id}`,
    title: `Fed Decision ${id}`,
    endDate: '2026-12-10T04:59:00Z',
    meetingWindow: 'December 8-9, 2026',
    closed,
    buckets,
    probabilitySum: 1.004,
    degraded: [],
  }
}

/** 采样构造。 */
function sample(at: number, values: Record<string, number>): ProbabilitySample {
  return { at, values }
}

describe('会话内采样与事件对照', () => {
  it('用户看到的采样序列在超出上限时保留最新的那些', () => {
    // Given 已积满上限的采样序列
    let samples: readonly ProbabilitySample[] = []
    for (let i = 0; i < MAX_SAMPLES; i += 1) samples = appendSample(samples, sample(i, { no_change: 0.5 }))
    // When 追加第 MAX_SAMPLES+1 条
    const next = appendSample(samples, sample(MAX_SAMPLES, { no_change: 0.6 }))
    // Then 长度封顶、首条被挤出、末条是最新
    expect(next.length).toBe(MAX_SAMPLES)
    expect(next[next.length - 1]?.at).toBe(MAX_SAMPLES)
    expect(next[0]?.at).toBe(1)
  })

  it('用户看到事件两侧都有采样时读出跨事件的概率位移', () => {
    // Given CPI 公布时点前后各有一次采样（0.23 → 0.27）
    const samples = [sample(1000, { no_change: 0.23 }), sample(3000, { no_change: 0.27 })]
    // When 取跨 2000 时刻的位移
    const moved = movementAround(samples, 2000, 'no_change')
    // Then 前后值与差值都可用
    expect(moved).toEqual({ before: 0.23, beforeAt: 1000, after: 0.27, afterAt: 3000, delta: 0.27 - 0.23 })
  })

  it('用户看到事件只有单侧采样时得到「采样不足」而不是 0 变动', () => {
    // Given 事件之后才开始采样（只有 after 一侧）
    const samples = [sample(3000, { no_change: 0.27 })]
    // When 取跨 2000 时刻的位移
    const moved = movementAround(samples, 2000, 'no_change')
    // Then undefined——面板显示「采样不足，不显示变动」
    expect(moved).toBeUndefined()
  })

  it('用户看到跨事件位移最大的档位被选为对照主行', () => {
    // Given 事件前后两档位，其中 dec_25 位移更大
    const samples = [
      sample(1000, { no_change: 0.72, dec_25: 0.15 }),
      sample(3000, { no_change: 0.68, dec_25: 0.24 }),
    ]
    // When 选位移最大的档位
    const hit = largestMovementAround(samples, 2000, ['no_change', 'dec_25'])
    // Then 命中 dec_25 及其位移
    expect(hit?.key).toBe('dec_25')
    expect(hit?.movement.delta).toBeCloseTo(0.09, 10)
  })

  it('用户看到全部档位都无法对照时对照主行为空', () => {
    // Given 空采样序列
    // When 选位移最大的档位
    const hit = largestMovementAround([], 2000, ['no_change'])
    // Then undefined
    expect(hit).toBeUndefined()
  })

  it('用户看到只有美国 CPI/PPI 条目被取为事件时点且按时间升序', () => {
    // Given 一批日历条目：含美国 CPI/PPI、非美国 CPI、与美国非通胀条目
    const events = inflationEventsOf([
      { publishedAt: '2026-10-15T12:30:00Z', title: '美国10月CPI年率', region: '美国' }, // i18n-allow: 上游数据词汇
      { publishedAt: '2026-10-10T12:30:00Z', title: '美国10月PPI年率', region: '美国' }, // i18n-allow: 上游数据词汇
      { publishedAt: '2026-10-14T12:30:00Z', title: '德国10月CPI年率', region: '德国' }, // i18n-allow: 上游数据词汇
      { publishedAt: '2026-10-13T12:30:00Z', title: '美国10月非农就业人口', region: '美国' }, // i18n-allow: 上游数据词汇
    ])
    // When 读事件时点
    // Then 只剩两条美国通胀条目，且按时间升序
    expect(events.length).toBe(2)
    expect(events.map((event) => event.title)).toEqual(['美国10月PPI年率', '美国10月CPI年率'])
    expect(events[0]!.at).toBeLessThan(events[1]!.at)
  })

  it('用户看到公布时刻无法解析的日历条目不进入事件对照', () => {
    // Given 一条 publishedAt 非法的美国 CPI 条目
    const events = inflationEventsOf([{ publishedAt: 'not-a-date', title: '美国10月CPI年率', region: '美国' }]) // i18n-allow: 上游数据词汇
    // When 读事件时点
    // Then 丢弃该行（不猜时间）
    expect(events).toEqual([])
  })
})

describe('上游历史回填（事件前后 24h、5 分钟口径）', () => {
  /** 固定「现在」：2026-10-11 02:00 UTC。 */
  const now = Date.parse('2026-10-11T02:00:00Z')

  it('用户看到的回填窗口是事件前后各 24 小时，右端夹到当前时刻', () => {
    // Given 事件发生在 2 小时前（事件后 24h 已越过 now）
    const eventAt = now - 2 * 3600_000
    // When 算回填窗口
    const window = historyWindowOf(eventAt, now)
    // Then 左端取事件 - 24h，右端夹到 now（未来那段上游没有数据）
    expect(window.fromMs).toBe(eventAt - HISTORY_WINDOW_MS)
    expect(window.toMs).toBe(now)
    expect(window.fromMs).toBe(eventAt - 86_400_000)
  })

  it('用户看到的回填窗口在事件距今超过一天时两端都取事件前后 24 小时', () => {
    // Given 事件发生在 27 天前（事件 + 24h 仍早于 now）
    const eventAt = now - 27 * 86400_000
    // When 算回填窗口
    const window = historyWindowOf(eventAt, now)
    // Then 右端不夹（未越过 now），两端都是有限数
    expect(window.fromMs).toBe(eventAt - HISTORY_WINDOW_MS)
    expect(window.toMs).toBe(eventAt + HISTORY_WINDOW_MS)
    expect(Number.isFinite(window.fromMs) && Number.isFinite(window.toMs)).toBe(true)
  })

  it('用户看到的回填窗口在右端早于左端时仍返回两个有限端点而不是 NaN', () => {
    // Given 异常时钟：now 早于事件的 24 小时前
    const eventAt = 10 * HISTORY_WINDOW_MS
    // When 算回填窗口
    const window = historyWindowOf(eventAt, 0)
    // Then 照常返回（是否请求由调用方决定），且都不产生 NaN
    expect(window.fromMs).toBe(eventAt - HISTORY_WINDOW_MS)
    expect(window.toMs).toBe(0)
    expect(window.toMs).toBeLessThanOrEqual(window.fromMs)
    expect(Number.isNaN(window.fromMs) || Number.isNaN(window.toMs)).toBe(false)
  })

  it('用户看到的回填口径是 5 分钟间隔与约 30 天保留期', () => {
    // Given 两个口径常量
    // When 读常量
    // Then 5 分钟（上游最细档）与 30 天（上游历史保留期）
    expect(HISTORY_FIDELITY_MINUTES).toBe(5)
    expect(HISTORY_MAX_AGE_MS).toBe(30 * 86400_000)
  })

  it('用户看到的候选事件只含已公布且在 30 天保留期内的那些，并按时点降序', () => {
    // Given 一批事件：未来、刚刚公布、27 天前、31 天前
    const events: readonly InflationEvent[] = [
      { at: now + 3600_000, title: 'future' },
      { at: now - 1000, title: 'just-now' },
      { at: now - 27 * 86400_000, title: 'recent' },
      { at: now - 31 * 86400_000, title: 'stale' },
    ]
    // When 取候选
    const candidates = candidateEventsOf(events, now)
    // Then 未来与超期都被剔除，剩下按时间降序（最近公布在前）
    expect(candidates.map((event) => event.title)).toEqual(['just-now', 'recent'])
  })

  it('用户看到 30 天保留期边界上的事件仍进候选，越过 1 毫秒即剔除', () => {
    // Given 恰好在保留期边界与其外 1ms 的两个事件
    const edge: InflationEvent = { at: now - HISTORY_MAX_AGE_MS, title: 'edge' }
    const out: InflationEvent = { at: now - HISTORY_MAX_AGE_MS - 1, title: 'out' }
    // When 分别取候选
    // Then 边界值保留、越过即剔除、公布时刻恰为 now 的也保留
    expect(candidateEventsOf([edge], now).map((event) => event.title)).toEqual(['edge'])
    expect(candidateEventsOf([out], now)).toEqual([])
    expect(candidateEventsOf([{ at: now, title: 'now' }], now)).toHaveLength(1)
  })

  it('用户看到上游历史的秒级时间戳被映射成毫秒采样并带上会议前缀', () => {
    // Given 上游历史（t 是 unix 秒、p 是 mid）
    const history = {
      meetingId: '770450',
      series: [{ bucketKey: 'no_change', points: [{ t: 1_791_000_000, p: 0.2 }, { t: 1_791_003_600, p: 0.3 }] }],
    }
    // When 映射成采样
    const samples = samplesFromHistory(history)
    // Then at = t * 1000、键带会议前缀、值取 p
    expect(samples).toEqual([
      { at: 1_791_000_000_000, values: { '770450:no_change': 0.2 } },
      { at: 1_791_003_600_000, values: { '770450:no_change': 0.3 } },
    ])
  })

  it('用户看到同一时刻的多个档位合成一条采样', () => {
    // Given 两个档位在同一时刻各有读数
    const history = {
      meetingId: 'm',
      series: [{ bucketKey: 'a', points: [{ t: 100, p: 0.4 }] }, { bucketKey: 'b', points: [{ t: 100, p: 0.6 }] }],
    }
    // When 映射成采样
    // Then 只有一条采样，两个档位在同一条里（与会话采样同粒度）
    expect(samplesFromHistory(history)).toEqual([{ at: 100_000, values: { 'm:a': 0.4, 'm:b': 0.6 } }])
  })

  it('用户看到上游历史为空时得到空采样而不是异常', () => {
    // Given 空 series（上游历史不覆盖该窗口）
    // When 映射成采样
    // Then 空数组、不抛
    expect(samplesFromHistory({ meetingId: 'm', series: [] })).toEqual([])
    expect(samplesFromHistory({ meetingId: 'm', series: [{ bucketKey: 'a', points: [] }] })).toEqual([])
  })

  it('用户看到的合并时间轴按时刻升序，同一时刻会话段覆盖历史段', () => {
    // Given 历史段与一段与它时刻重叠的会话采样
    const history = samplesFromHistory({ meetingId: 'm', series: [{ bucketKey: 'a', points: [{ t: 100, p: 0.2 }, { t: 300, p: 0.4 }] }] })
    const session = [sample(200_000, { 'm:a': 0.3 }), sample(300_000, { 'm:a': 0.5 })]
    // When 合并
    const merged = mergeSamples(history, session)
    // Then 时刻升序且 300s 处取会话读数 0.5（后者覆盖前者）
    expect(merged.map((item) => item.at)).toEqual([100_000, 200_000, 300_000])
    expect(merged[2]?.values['m:a']).toBe(0.5)
  })

  it('用户看到的合并时间轴超过上限时裁掉最旧的、保留最新的', () => {
    // Given 两条时间轴共 5 条采样
    const a = [sample(1, { k: 1 }), sample(2, { k: 2 }), sample(3, { k: 3 })]
    const b = [sample(4, { k: 4 }), sample(5, { k: 5 })]
    // When 以 3 条为上限合并
    const merged = mergeSamples(a, b, 3)
    // Then 只剩最新三条
    expect(merged.map((item) => item.at)).toEqual([3, 4, 5])
  })

  it('用户看到事件两侧都有读数时得到可对照结论与位移最大的档位', () => {
    // Given CPI 前后各有一次采样，其中 a 档位移更大
    const samples = [sample(1000, { 'm:a': 0.2, 'm:b': 0.5 }), sample(3000, { 'm:a': 0.4, 'm:b': 0.45 })]
    // When 取跨 2000 的对照结论
    const result = eventComparisonOf(samples, 2000, ['m:a', 'm:b'])
    // Then comparable + 位移最大的档位与其前后读数
    expect(result.state).toBe('comparable')
    if (result.state !== 'comparable') throw new Error('expected comparable')
    expect(result.key).toBe('m:a')
    expect(result.movement).toEqual({ before: 0.2, beforeAt: 1000, after: 0.4, afterAt: 3000, delta: 0.4 - 0.2 })
  })

  it('用户看到事件只有单侧读数时得到采样不足而不是 0 变动', () => {
    // Given 事件之后才有读数（前一段缺失），以及一条全空的时间轴
    const samples = [sample(3000, { 'm:a': 0.4 })]
    // When 取对照结论
    // Then insufficient（面板据此显示「采样不足，不显示变动」）
    expect(eventComparisonOf(samples, 2000, ['m:a'])).toEqual({ state: 'insufficient' })
    expect(eventComparisonOf([], 2000, ['m:a'])).toEqual({ state: 'insufficient' })
  })

  it('用户看到各档时间戳不在同一网格时仍按各自最近点对照', () => {
    // Given a 档在 900s/1100s、b 档在 800s/1200s（上游按各 token 成交时刻出点，不共网格）
    const history = samplesFromHistory({
      meetingId: 'm',
      series: [
        { bucketKey: 'a', points: [{ t: 900, p: 0.3 }, { t: 1100, p: 0.32 }] },
        { bucketKey: 'b', points: [{ t: 800, p: 0.5 }, { t: 1200, p: 0.6 }] },
      ],
    })
    // When 跨 1000s 取对照结论
    const result = eventComparisonOf(history, 1000_000, ['m:a', 'm:b'])
    // Then 每个档位各取自己那一侧最近点（不跨键插值、不要求同时刻），最大位移命中 b
    expect(result.state).toBe('comparable')
    if (result.state !== 'comparable') throw new Error('expected comparable')
    expect(result.key).toBe('m:b')
    expect(result.movement).toEqual({ before: 0.5, beforeAt: 800_000, after: 0.6, afterAt: 1_200_000, delta: 0.6 - 0.5 })
    // 两条不同时刻的采样各自独立存在、序列按 at 升序（movementAround 的最近点判据依赖升序）
    expect(history.map((item) => item.at)).toEqual([800_000, 900_000, 1_100_000, 1_200_000])
    expect(history.map((item) => Object.keys(item.values))).toEqual([['m:b'], ['m:a'], ['m:a'], ['m:b']])
  })
})
