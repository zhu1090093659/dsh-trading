/**
 * 发现规则用例（纯函数 + 真实上游响应夹具）。
 *
 * 零 mock：夹具 `fixtures/fomc-open-2026-10-11.json` 是
 * `raw/connector-live-series35.json` 的**逐字段裁剪**（去掉本包不读的长字段），
 * 数值一字未改——抽查口径时直接对着它算，与 Polymarket 网页同源。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  FOMC_SERIES_ID,
  MAX_BUCKETS,
  MIN_BUCKETS,
  canonicalBucket,
  discoverFomcMeetings,
} from '../src/discovery.ts'

const FIXTURE = join(import.meta.dirname, 'fixtures', 'fomc-open-2026-10-11.json')

function liveEvents(): Record<string, unknown>[] {
  return JSON.parse(readFileSync(FIXTURE, 'utf8')) as Record<string, unknown>[]
}

describe('档位标签归一化（canonicalBucket）', () => {
  it('运营在同一场会议里同时看到 No change 与 No Change 时归一成同一档位键', () => {
    // Given 上游历史上大小写不一致的两种 No change 写法（证据 Q1.7）
    const lower = 'No change'
    const upper = 'No Change'

    // When 归一化

    // Then 得到同一个稳定键与 0 bps
    expect(canonicalBucket(lower)).toEqual({ key: 'no_change', changeBps: 0 })
    expect(canonicalBucket(upper)).toEqual({ key: 'no_change', changeBps: 0 })
  })

  it('运营看到带与不带 + 的同一档位时归一成同一语义（按原文字面保留 plus 区分）', () => {
    // Given 证据 Q1.7 实测的 50+ bps decrease / 50 bps decrease 并存
    // When 归一化
    // Then 都以 50 bps 降息给出变动脉冲，键按原文字面区分「含 +」
    expect(canonicalBucket('50+ bps decrease')).toEqual({ key: 'dec_50plus', changeBps: -50 })
    expect(canonicalBucket('50 bps decrease')).toEqual({ key: 'dec_50', changeBps: -50 })
    expect(canonicalBucket('25 bps increase')).toEqual({ key: 'inc_25', changeBps: 25 })
    expect(canonicalBucket('75+ bps decrease')).toEqual({ key: 'dec_75plus', changeBps: -75 })
  })

  it('运营遇到未识别档位（Other）时保留原文且不猜变动脉冲', () => {
    // Given 历史形态里的 Other 档（证据 Q1.6 的 6 档形态）
    // When 归一化
    // Then 键退回原文、changeBps 缺省（不填 0 冒充 no change）
    expect(canonicalBucket('Other')).toEqual({ key: 'raw:Other', changeBps: undefined })
  })
})

describe('FOMC 决议发现规则（L0..L5 + 真实响应夹具）', () => {
  it('运营请求 FOMC 决议路径时拿到 2026-10 / 2026-12 / 2027-01 三场会议，按 endDate 升序', () => {
    // Given 2026-10-11 实测的 gamma /events?series_id=35 响应（3 条开放会议）
    // When 应用发现规则
    const { meetings, trace } = discoverFomcMeetings(liveEvents())

    // Then 三场会议全中、顺序按 endDate 升序、各层零丢弃
    expect(meetings.map((meeting) => meeting.title)).toEqual([
      'Fed Decision in October?',
      'Fed Decision in December?',
      'Fed Decision in January?',
    ])
    expect(meetings.map((meeting) => meeting.endDate)).toEqual([
      '2026-10-29T03:59:00Z',
      '2026-12-10T04:59:00Z',
      '2027-01-28T04:59:00Z',
    ])
    expect(trace.layers).toEqual({ series: 3, title: 3, shape: 3, noise: 3 })
    expect(trace.dropped).toEqual([])
  })

  it('运营看到每场会议是五档，且各档概率与上游 outcomePrices[0] 逐值一致', () => {
    // Given 实测响应的 December 会议（证据表 1.6 的 5 档数值）
    // When 解析
    const december = discoverFomcMeetings(liveEvents()).meetings.find((meeting) => meeting.title === 'Fed Decision in December?')

    // Then 档位键与概率与夹具逐值相等
    expect(december?.buckets.map((bucket) => bucket.key)).toEqual([
      'dec_50plus', 'dec_25', 'no_change', 'inc_25', 'inc_50plus',
    ])
    expect(december?.buckets.map((bucket) => bucket.probability)).toEqual([0.0035, 0.0125, 0.225, 0.745, 0.0295])
    expect(december?.probabilitySum).toBe(1.0155)
    expect(december?.degraded).toEqual([])
  })

  it('运营看到每档带深度与价差质量字段（价差由 bid/ask 现算）', () => {
    // Given 实测响应的 October 会议 No change 档（bid 0.83 / ask 0.84 / 深度 646357.7906）
    // When 解析
    const october = discoverFomcMeetings(liveEvents()).meetings.find((meeting) => meeting.title === 'Fed Decision in October?')
    const noChange = october?.buckets.find((bucket) => bucket.key === 'no_change')

    // Then 质量字段逐值可核
    expect(noChange).toMatchObject({
      label: 'No change',
      probability: 0.835,
      bestBid: 0.83,
      bestAsk: 0.84,
      spread: 0.01,
      liquidity: 646357.7906,
      tickSize: 0.01,
      acceptingOrders: true,
      closed: false,
    })
  })

  it('运营看到会议日程窗口来自上游 description 原文而不是猜的月份', () => {
    // Given 实测 description 里的 `meeting scheduled for October 27-28, 2026`
    // When 解析
    const meetings = discoverFomcMeetings(liveEvents()).meetings

    // Then 三场会议的窗口逐值等于上游原文
    expect(meetings.map((meeting) => meeting.meetingWindow)).toEqual([
      'October 27-28, 2026', 'December 8-9, 2026', 'January 26-27, 2027',
    ])
  })

  it('运营看到 tag_slug=fomc 噪声（人事/年度计数/组合盘）被丢弃而不是混进档位集合', () => {
    // Given tag_slug=fomc 的噪声（证据 Q1.1）与真实档位形状
    const markets = [
      { groupItemTitle: 'No change', outcomePrices: '["0.25","0.75"]', bestBid: 0.24, bestAsk: 0.26, closed: false, acceptingOrders: true },
      { groupItemTitle: '25 bps increase', outcomePrices: '["0.25","0.75"]', bestBid: 0.24, bestAsk: 0.26, closed: false, acceptingOrders: true },
      { groupItemTitle: '25 bps decrease', outcomePrices: '["0.25","0.75"]', bestBid: 0.24, bestAsk: 0.26, closed: false, acceptingOrders: true },
      { groupItemTitle: '50+ bps increase', outcomePrices: '["0.25","0.75"]', bestBid: 0.24, bestAsk: 0.26, closed: false, acceptingOrders: true },
    ]
    const noisy = [
      { id: '1', slug: 'how-many-fed-rate-hikes-in-2026-abc', title: 'How many Fed rate hikes in 2026?', negRisk: true, endDate: '2026-12-31T00:00:00Z', series: [{ id: '35' }], markets },
      { id: '2', slug: 'warsh-out-as-fed-chair-by-x', title: 'Fed decision in October?', negRisk: true, endDate: '2026-10-29T03:59:00Z', series: [{ id: '35' }], markets: [] },
      { id: '3', slug: 'fed-decisions-oct-jan', title: 'Fed decision in November?', negRisk: true, endDate: '2026-11-05T00:00:00Z', series: [{ id: '35' }], markets },
      { id: '4', slug: 'some-other-event', title: 'Fed decision in December?', negRisk: true, endDate: '2026-12-10T04:59:00Z', series: [{ id: '99' }], markets },
      { id: '5', slug: 'fed-decision-in-october-2026x', title: 'Fed decision in October?', negRisk: false, endDate: '2026-10-29T03:59:00Z', series: [{ id: '35' }], markets },
      { id: '6', slug: 'real-decision', title: 'Not a decision title', negRisk: true, endDate: '2026-11-01T00:00:00Z', series: [{ id: '35' }], markets },
    ]

    // When 应用发现规则
    const { meetings, trace } = discoverFomcMeetings(noisy)

    // Then 每层各拦下自己的那类噪声，无会议存活
    expect(meetings).toEqual([])
    expect(trace.layers).toEqual({ series: 5, title: 3, shape: 1, noise: 0 })
    expect(trace.dropped).toEqual([
      'L1:Fed decision in December?',
      'L2:How many Fed rate hikes in 2026?',
      'L2:Not a decision title',
      'L3:Fed decision in October?',
      'L3:Fed decision in October?',
      'L4:Fed decision in November?<-fed-decisions-',
    ])
  })

  it('运营看到同一次会议重复出现时按 event id 去重，不显示两份', () => {
    // Given 同一会议 id 在响应里出现两次（分页边界下的重复面）
    const events = liveEvents()
    const duplicated = [...events, events[0] as Record<string, unknown>]

    // When 应用发现规则
    const { meetings } = discoverFomcMeetings(duplicated)

    // Then 仍是三场，没有重复的 October
    expect(meetings).toHaveLength(3)
    expect(meetings.filter((meeting) => meeting.title === 'Fed Decision in October?')).toHaveLength(1)
  })

  it('运营看到形状判据只认 negRisk 且 4..6 档（3 档与 7 档都不是决议档位集合）', () => {
    // Given 档位数边界两侧（3 档 / 4 档 / 6 档 / 7 档），全部 negRisk 且是真档位形状
    const bucket = (label) => ({ groupItemTitle: label, outcomePrices: '["0.25","0.75"]', bestBid: 0.24, bestAsk: 0.26, closed: false, acceptingOrders: true })
    const labels = ['No change', '25 bps increase', '25 bps decrease', '50+ bps increase', '50+ bps decrease', '25 bps decrease', 'No change']
    const make = (id, count) => ({
      id, slug: `s-${id}`, title: 'Fed decision in March?', endDate: '2026-03-18T00:00:00Z',
      negRisk: true, series: [{ id: FOMC_SERIES_ID }], markets: labels.slice(0, count).map(bucket),
    })

    // When 应用发现规则
    const { meetings, trace } = discoverFomcMeetings([make('a', MIN_BUCKETS - 1), make('b', MIN_BUCKETS), make('c', MAX_BUCKETS), make('d', MAX_BUCKETS + 1)])

    // Then 只留 4 档与 6 档
    expect(trace.layers.shape).toBe(2)
    expect(meetings.map((meeting) => meeting.id)).toEqual(['b', 'c'])
    expect(meetings.map((meeting) => meeting.buckets.length)).toEqual([4, 6])
  })

  it('运营看到上游返回空集合时得到空会议列表（真的没有数据，不是失败）', () => {
    // Given 上游对合法但无内容的查询回 200 空数组
    // When 应用发现规则
    const { meetings, trace } = discoverFomcMeetings([])

    // Then 空列表且候选数为 0（调用方据此区分「无数据」与「取数失败」）
    expect(meetings).toEqual([])
    expect(trace.candidates).toBe(0)
  })

  it('运营看到响应体不是数组时取数响亮失败，绝不静默当成没有会议', () => {
    // Given 上游契约破损（回了一个对象而不是事件数组）
    // When / Then 抛错而不是返回空集合
    expect(() => discoverFomcMeetings({ error: 'nope' })).toThrow(TypeError)
    expect(() => discoverFomcMeetings(null)).toThrow('expected a JSON array of events')
  })

  it('运营看到概率和明显偏离 1 的会议被标 quality 提示但仍照原样展示概率', () => {
    // Given 一组概率和 0.90 的档位（超出实测区间 [0.98, 1.03]），标签全部可识别
    const bucket = (label) => ({ groupItemTitle: label, outcomePrices: '["0.225","0.775"]', bestBid: 0.22, bestAsk: 0.23, closed: false, acceptingOrders: true })
    const skewed = [{
      id: '9', slug: 'skew', title: 'Fed decision in May?', endDate: '2026-05-06T00:00:00Z',
      negRisk: true, series: [{ id: FOMC_SERIES_ID }], closed: false,
      markets: ['No change', '25 bps increase', '25 bps decrease', '50+ bps increase'].map(bucket),
    }]

    // When 解析
    const meeting = discoverFomcMeetings(skewed).meetings[0]

    // Then 概率原样保留（不归一化改写），只打 degraded 标记
    expect(meeting?.probabilitySum).toBe(0.9)
    expect(meeting?.buckets.map((bucket_) => bucket_.probability)).toEqual([0.225, 0.225, 0.225, 0.225])
    expect(meeting?.degraded).toEqual(['probability-sum-out-of-band'])
  })

  it('运营看到缺概率或缺标签的残档被丢弃，而不是补 0 冒充档位', () => {
    // Given 四条档位里两条残形（缺 outcomePrices / 缺 groupItemTitle），仍在 4..6 档形状内
    const partial = [{
      id: '10', slug: 'partial', title: 'Fed decision in June?', endDate: '2026-06-17T00:00:00Z',
      negRisk: true, series: [{ id: FOMC_SERIES_ID }], closed: false,
      markets: [
        { groupItemTitle: 'No change', outcomePrices: '["0.5","0.5"]', bestBid: 0.49, bestAsk: 0.51, closed: false, acceptingOrders: true },
        { groupItemTitle: '25 bps increase', outcomePrices: undefined, closed: false },
        { groupItemTitle: undefined, outcomePrices: '["0.5","0.5"]', closed: false },
        { groupItemTitle: '25 bps decrease', outcomePrices: '["0.4","0.6"]', bestBid: 0.39, bestAsk: 0.41, closed: false, acceptingOrders: true },
      ],
    }]

    // When 解析
    const meeting = discoverFomcMeetings(partial).meetings[0]

    // Then 只剩两条真档位，且和 = 0.9（残形既不补 0 也不补标签）
    expect(meeting?.buckets.map((bucket_) => bucket_.label)).toEqual(['25 bps decrease', 'No change'])
    expect(meeting?.probabilitySum).toBe(0.9)
  })

  it('运营遇到 outcomePrices 是坏 JSON 字符串时该档位被丢弃，而不是抛错中断整场会议', () => {
    // Given 一条 outcomePrices 被截断的档位（上游偶发的脏字段）
    const events = [{
      id: '12', slug: 'dirty', title: 'Fed decision in July?', endDate: '2026-07-29T00:00:00Z',
      negRisk: true, series: [{ id: FOMC_SERIES_ID }], closed: false,
      markets: [
        { groupItemTitle: 'No change', outcomePrices: '["0.5","0.5', closed: false, acceptingOrders: true },
        { groupItemTitle: '25 bps increase', outcomePrices: '["0.3","0.7"]', bestBid: 0.29, bestAsk: 0.31, closed: false, acceptingOrders: true },
        { groupItemTitle: '25 bps decrease', outcomePrices: '["0.2","0.8"]', bestBid: 0.19, bestAsk: 0.21, closed: false, acceptingOrders: true },
        { groupItemTitle: '50+ bps increase', outcomePrices: '["0.1","0.9"]', bestBid: 0.09, bestAsk: 0.11, closed: false, acceptingOrders: true },
      ],
    }]

    // When 解析
    const meeting = discoverFomcMeetings(events).meetings[0]

    // Then 坏档位被丢弃，其余三档照常
    expect(meeting?.buckets.map((bucket) => bucket.label)).toEqual(['25 bps decrease', '25 bps increase', '50+ bps increase'])
    expect(meeting?.probabilitySum).toBe(0.6)
  })

  it('运营遇到概率越界或未识别档位时看到 quality 标记但仍按原值展示', () => {
    // Given 一条概率 1.5 的越界档 + 一条未识别标签 + 一条开市但缺盘口报价的档
    const events = [{
      id: '13', slug: 'out-of-range', title: 'Fed decision in August?', endDate: '2026-08-05T00:00:00Z',
      negRisk: true, series: [{ id: FOMC_SERIES_ID }], closed: false,
      markets: [
        { groupItemTitle: 'No change', outcomePrices: '["0.5","0.5"]', bestBid: 0.49, bestAsk: 0.51, closed: false, acceptingOrders: true },
        { groupItemTitle: '25 bps increase', outcomePrices: '["1.5","-0.5"]', bestBid: 0.49, bestAsk: 0.51, closed: false, acceptingOrders: true },
        { groupItemTitle: 'Other', outcomePrices: '["0.01","0.99"]', bestBid: 0.005, bestAsk: 0.015, closed: false, acceptingOrders: true },
        { groupItemTitle: '25 bps decrease', outcomePrices: '["0.02","0.98"]', closed: false, acceptingOrders: true },
      ],
    }]

    // When 解析
    const meeting = discoverFomcMeetings(events).meetings[0]

    // Then 三个标记齐出，且越界值原样保留（不裁剪成 1）
    expect(meeting?.degraded).toEqual([
      'probability-sum-out-of-band', 'probability-out-of-range', 'bucket-quote-missing', 'bucket-unrecognized-label',
    ])
    expect(meeting?.buckets.find((bucket) => bucket.key === 'inc_25')?.probability).toBe(1.5)
    expect(meeting?.buckets.at(-1)?.key).toBe('raw:Other')
  })

  it('运营看到已结算会议的概率是 0/1 且不再标记成可交易', () => {
    // Given 已结算样例（证据 Q4.3：closed=true / acceptingOrders=false / bestBid=null）
    const resolved = [{
      id: '11', slug: 'resolved', title: 'Fed decision in September?', endDate: '2026-09-17T00:00:00Z',
      negRisk: true, series: [{ id: FOMC_SERIES_ID }], closed: true,
      markets: [
        { groupItemTitle: 'No change', outcomePrices: '["0","1"]', bestBid: null, bestAsk: 0.001, closed: true, acceptingOrders: false },
        { groupItemTitle: '25 bps increase', outcomePrices: '["1","0"]', bestBid: 0.999, bestAsk: 1, closed: true, acceptingOrders: false },
        { groupItemTitle: '25 bps decrease', outcomePrices: '["0","1"]', bestBid: null, bestAsk: 0.001, closed: true, acceptingOrders: false },
        { groupItemTitle: '50+ bps increase', outcomePrices: '["0","1"]', bestBid: null, bestAsk: 0.001, closed: true, acceptingOrders: false },
      ],
    }]

    // When 解析
    const meeting = discoverFomcMeetings(resolved).meetings[0]
    const noChange = meeting?.buckets.find((bucket) => bucket.key === 'no_change')

    // Then 概率取明确的 0/1；bestBid 缺省（null 不落成 0）；不自算 mid
    expect(meeting?.closed).toBe(true)
    expect(noChange?.probability).toBe(0)
    expect(noChange?.bestBid).toBeUndefined()
    expect(noChange?.bestAsk).toBe(0.001)
    expect(noChange?.spread).toBeUndefined()
    expect(noChange?.acceptingOrders).toBe(false)
    expect(meeting?.buckets.find((bucket) => bucket.key === 'inc_25')?.probability).toBe(1)
  })
})

describe('回填定位键（clobTokenIds）解析', () => {
  it('运营看到档位 market 带 clobTokenIds 时拿到第 0 个 token（与 outcomePrices[0] 同档）', () => {
    // Given 实测响应里 clobTokenIds 是字符串化 JSON 数组（raw/06-events-series_id35.json）
    const events = liveEvents()
    const markets = events[0]?.markets as Record<string, unknown>[]
    markets[0]!.clobTokenIds = JSON.stringify(['tok-yes-2026-10', 'tok-no-2026-10'])

    // When 解析会议
    const meeting = discoverFomcMeetings(events).meetings[0]

    // Then 第 0 个元素落位到该档，第 1 个（No 侧）不落位
    const bucket = meeting?.buckets.find((entry) => entry.label === markets[0]?.groupItemTitle)
    expect(bucket?.clobTokenId).toBe('tok-yes-2026-10')
    expect(bucket?.clobTokenId).not.toBe('tok-no-2026-10')
  })

  it('运营看到 clobTokenIds 缺省或解析失败时不填该字段（绝不猜 token）', () => {
    // Given 三种坏形态：非 JSON、空数组、非数组 + 两个完全不带的 market
    const events = liveEvents()
    const markets = events[0]?.markets as Record<string, unknown>[]
    markets[1]!.clobTokenIds = 'not-json'
    markets[2]!.clobTokenIds = '[]'
    markets[3]!.clobTokenIds = '{"a":1}'

    // When 解析会议
    const buckets = discoverFomcMeetings(events).meetings[0]?.buckets ?? []

    // Then 五个档位都没有 clobTokenId 这个键（缺省 = 不知道，不填假值）
    expect(buckets).toHaveLength(5)
    expect(buckets.every((bucket) => !('clobTokenId' in bucket))).toBe(true)
  })

  it('运营看到 clobTokenIds 首元素为空串时同样不填（空 token 不是可用定位键）', () => {
    // Given 首元素是空串、次元素有效的坏形态
    const events = liveEvents()
    const markets = events[0]?.markets as Record<string, unknown>[]
    markets[0]!.clobTokenIds = JSON.stringify(['', 'tok-no-2026-10'])

    // When 解析会议
    const bucket = discoverFomcMeetings(events).meetings[0]?.buckets
      .find((entry) => entry.label === markets[0]?.groupItemTitle)

    // Then 不填（不拿次元素顶替——那是 No 侧的 token）
    expect(bucket?.clobTokenId).toBeUndefined()
    expect(bucket !== undefined && 'clobTokenId' in bucket).toBe(false)
  })
})
