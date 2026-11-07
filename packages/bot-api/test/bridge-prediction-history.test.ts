/**
 * 桥 /prediction/history 用例：真实 TradingBridge + 真实 /dshtrading/api 路由（零 mock 库）。
 *
 * 核心判据：坏参数在桥侧就 400（一个上游请求都不发）、服务缺席/老连接器
 * TRADING_NOT_IMPLEMENTED、窗口超 336h 明确报错并带小时数——三者都与「上游确实没有变动」
 * 可区分，绝不用空 series 冒充。
 */
import { describe, expect, it } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { apply } from '../src/index.ts'
import {
  PREDICTION_HISTORY_MAX_WINDOW_MS,
  TradingBridge,
  createBridgeHost,
  dispatchBridgeRequest,
  type PredictionFeedLike,
} from '../src/bridge.ts'
import type { PredictionFeed, PredictionPriceHistory, PredictionPriceHistoryRequest } from '@dshtrading/api'

/** 上游 event id（与 bridge-prediction.test.ts 同一场会议）。 */
const MEETING_ID = '606422'
/** 请求窗口起点（epoch ms；取值只求稳定，不含业务含义）。 */
const FROM_MS = 1_791_000_000_000
const TO_MS = FROM_MS + 3_600_000
/** 合法 query（HTTP 侧原样字符串；桥负责解析成契约请求）。 */
const VALID = { meetingId: MEETING_ID, fromMs: String(FROM_MS), toMs: String(TO_MS), fidelityMinutes: '1' }

/** 连接器的历史应答（形状即 @dshtrading/api 的 PredictionPriceHistory）。 */
const HISTORY: PredictionPriceHistory = {
  fetchedAt: '2026-10-15T02:00:00.000Z',
  meetingId: MEETING_ID,
  fromMs: FROM_MS,
  toMs: TO_MS,
  fidelityMinutes: 1,
  series: [
    { bucketKey: 'no_change', points: [{ t: 1_791_000_000, p: 0.835 }, { t: 1_791_000_600, p: 0.841 }] },
    { bucketKey: 'inc_25', points: [{ t: 1_791_000_000, p: 0.155 }] },
  ],
}

/** 记录桥实际发给上游的请求（零 mock：手写契约化替身，不用替身库）。 */
interface Recorder {
  calls: PredictionPriceHistoryRequest[]
}

function recorder(): Recorder {
  return { calls: [] }
}

/** 真实服务替身：只实现契约面，请求原样记录。 */
function liveFeed(seen: Recorder, response: PredictionPriceHistory = HISTORY): PredictionFeedLike {
  return {
    listFomcMeetings: async (): Promise<PredictionFeed> => ({ fetchedAt: HISTORY.fetchedAt, meetings: [] }),
    listPriceHistory: async (request) => {
      seen.calls.push(request)
      return response
    },
  }
}

function makeBridge(predictionFeed?: PredictionFeedLike): TradingBridge {
  return new TradingBridge(createBridgeHost({ legacy: () => undefined, predictionFeed }))
}

interface RegisteredRoute {
  kind: string
  path: string
  handler: (req: Partial<IncomingMessage>, res: Partial<ServerResponse>) => Promise<void>
}

/**
 * 最小宿主替身：webServer/connection 与 tradingPredictionFeed 三个服务面（真实 apply +
 * 真实桥，只有 cordis 服务注入是手写替身，与 smoke.test.ts 同款）。
 */
function makeCtx(predictionFeed?: PredictionFeedLike): { ctx: never; registered: RegisteredRoute[] } {
  const registered: RegisteredRoute[] = []
  const webServer = { register: (route: RegisteredRoute) => { registered.push(route) } }
  const connection = { requestRejection: () => undefined }
  const webCtx = {
    get: (name: string) => {
      if (name === 'webServer') return webServer
      if (name === 'connection') return connection
      if (name === 'tradingPredictionFeed') return predictionFeed
      return undefined
    },
    effect: () => (() => {}),
    tools: { register: () => {}, get: () => undefined },
  }
  const ctx = {
    inject: (deps: readonly string[], cb: (scoped: typeof webCtx) => void) => {
      if (deps.includes('webServer')) cb(webCtx)
      else if (deps.includes('tools')) cb(webCtx)
    },
    effect: (fn: () => () => void) => { fn() },
  }
  return { ctx: ctx as never, registered }
}

/** 打一次真实 HTTP 路由，取状态码与 JSON 文本。 */
async function callRoute(route: RegisteredRoute, url: string): Promise<{ status: number; body: string }> {
  let status = 0
  let body = ''
  const res = {
    writeHead: (code: number) => { status = code },
    end: (text?: string) => { body = text ?? '' },
  }
  await route.handler({ url, method: 'GET' } as IncomingMessage, res as unknown as ServerResponse)
  return { status, body }
}

describe('桥 /prediction/history（事件窗口回填）', () => {
  it('运营按事件窗口回填时拿到逐档历史、窗口与粒度回述', async () => {
    // Given 连接器提供历史面
    const seen = recorder()

    // When 请求 [FROM_MS, TO_MS] 的 1 分钟粒度历史
    const wire = await makeBridge(liveFeed(seen)).predictionHistory(VALID)

    // Then 信封 ok + 契约字段原样，且上游收到的正是解析后的请求
    expect(wire).toEqual({ ok: true, ...HISTORY })
    expect(seen.calls).toEqual([{ meetingId: MEETING_ID, fromMs: FROM_MS, toMs: TO_MS, fidelityMinutes: 1 }])
  })

  it('运营在未安装预测市场连接器时看到 TRADING_NOT_IMPLEMENTED，而不是一段空历史', async () => {
    // Given 服务缺席（连接器未装/未启用）
    // When / Then 明确报未实现，绝不回空 series 冒充「上游没有变动」
    await expect(makeBridge(undefined).predictionHistory(VALID)).rejects.toMatchObject({
      code: 'TRADING_NOT_IMPLEMENTED',
      message: 'prediction feed is not mounted (install/enable the polymarket connector)',
    })
  })

  it('运营在老版本连接器（没有历史面）时也看到 TRADING_NOT_IMPLEMENTED', async () => {
    // Given 连接器只实现 FOMC 快照，缺少 listPriceHistory
    const oldConnector: PredictionFeedLike = {
      listFomcMeetings: async () => ({ fetchedAt: HISTORY.fetchedAt, meetings: [] }),
    }

    // When / Then 显式报未实现，而不是 TypeError 被兜底吞成 TRADING_UNKNOWN
    await expect(makeBridge(oldConnector).predictionHistory(VALID)).rejects.toMatchObject({
      code: 'TRADING_NOT_IMPLEMENTED',
      message: 'prediction feed does not implement listPriceHistory (connector predates the backfill contract)',
    })
  })

  it('运营漏给或给错参数时桥 400 且一个上游请求都不发', async () => {
    // Given 已挂载服务 + 参数缺失（meetingId 全空白）与非数值（fromMs）
    const seen = recorder()
    const bridge = makeBridge(liveFeed(seen))

    // When / Then 参数闸门在桥侧拦下，错误消息指出具体参数
    await expect(bridge.predictionHistory({ ...VALID, meetingId: '  ' })).rejects.toMatchObject({
      status: 400,
      message: 'prediction history: meetingId is required (upstream event id)',
    })
    await expect(bridge.predictionHistory({ ...VALID, fromMs: 'yesterday' })).rejects.toMatchObject({
      status: 400,
      message: 'prediction history: fromMs must be a finite number (got "yesterday")',
    })
    await expect(bridge.predictionHistory({ ...VALID, toMs: null })).rejects.toMatchObject({
      status: 400,
      message: 'prediction history: toMs is required (epoch ms number)',
    })
    expect(seen.calls).toEqual([])
  })

  it('运营把 fromMs 放到 toMs 之后或与之相等时桥 400', async () => {
    // Given 已挂载服务 + 倒序窗口与零宽窗口
    const seen = recorder()
    const bridge = makeBridge(liveFeed(seen))

    // When / Then 两种都拒绝（零宽窗口不是「没有变动」，是请求写错）
    await expect(bridge.predictionHistory({ ...VALID, fromMs: String(TO_MS), toMs: String(FROM_MS) })).rejects.toMatchObject({
      status: 400,
      message: 'prediction history: fromMs must be before toMs (fromMs=' + TO_MS + ', toMs=' + FROM_MS + ')',
    })
    await expect(bridge.predictionHistory({ ...VALID, fromMs: String(FROM_MS), toMs: String(FROM_MS) })).rejects.toMatchObject({ status: 400 })
    expect(seen.calls).toEqual([])
  })

  it('运营给的 fidelityMinutes 为 0 或负数时桥 400（不把坏粒度透传上游）', async () => {
    // Given 已挂载服务 + 非正粒度
    const seen = recorder()
    const bridge = makeBridge(liveFeed(seen))

    // When / Then 两种都拒绝，消息点名 fidelityMinutes
    await expect(bridge.predictionHistory({ ...VALID, fidelityMinutes: '0' })).rejects.toMatchObject({
      status: 400,
      message: 'prediction history: fidelityMinutes must be a positive number of minutes (got "0")',
    })
    await expect(bridge.predictionHistory({ ...VALID, fidelityMinutes: '-5' })).rejects.toMatchObject({
      status: 400,
      message: 'prediction history: fidelityMinutes must be a positive number of minutes (got "-5")',
    })
    expect(seen.calls).toEqual([])
  })

  it('运营请求超过 336 小时的窗口时桥 400，且消息里带窗口小时数', async () => {
    // Given 已挂载服务 + 720 小时窗口（上游 startTs/endTs 实测边界 336h，证据 Q3.2）
    const seen = recorder()
    const bridge = makeBridge(liveFeed(seen))
    const tooWide = { ...VALID, fromMs: String(FROM_MS), toMs: String(FROM_MS + 720 * 3600_000) }

    // When / Then 桥侧就拒绝（不透传给必然失败的上游），消息带 720h 与 336h 两个数
    await expect(bridge.predictionHistory(tooWide)).rejects.toMatchObject({
      status: 400,
      message: 'prediction history: window 720h exceeds the 336h upstream limit (CLOB prices-history rejects longer startTs/endTs intervals)',
    })
    expect(seen.calls).toEqual([])
  })

  it('运营请求恰好 336 小时窗口时仍能拿到历史（上限含端点）', async () => {
    // Given 已挂载服务 + 恰好等于上限的窗口
    const seen = recorder()
    const endMs = FROM_MS + PREDICTION_HISTORY_MAX_WINDOW_MS
    const atLimit = { ...VALID, fromMs: String(FROM_MS), toMs: String(endMs) }

    // When 请求边界窗口
    const wire = await makeBridge(liveFeed(seen, { ...HISTORY, toMs: endMs })).predictionHistory(atLimit)

    // Then 放行 + 窗口原样到达上游（336h 是可用上限，不是「小于才可用」）
    expect(wire.ok).toBe(true)
    expect(seen.calls).toEqual([{ meetingId: MEETING_ID, fromMs: FROM_MS, toMs: endMs, fidelityMinutes: 1 }])
  })

  it('运营不给 fidelityMinutes 时桥不发明默认值（缺省交给连接器，响应原样回述）', async () => {
    // Given 已挂载服务 + 只给窗口不给粒度
    const seen = recorder()

    // When 请求不含 fidelityMinutes
    const wire = await makeBridge(liveFeed(seen)).predictionHistory({ meetingId: MEETING_ID, fromMs: String(FROM_MS), toMs: String(TO_MS) })

    // Then 桥把缺省原样传下去（undefined），粒度以连接器回述值为准
    expect(seen.calls).toEqual([{ meetingId: MEETING_ID, fromMs: FROM_MS, toMs: TO_MS, fidelityMinutes: undefined }])
    expect(wire.fidelityMinutes).toBe(1)
  })

  it('运营经 HTTP 分发函数 GET /prediction/history 拿到同一份信封', async () => {
    // Given 已挂载服务 + 合法 query 串
    const seen = recorder()

    // When 走真实分发函数
    const result = await dispatchBridgeRequest(makeBridge(liveFeed(seen)), 'GET', '/prediction/history', new URLSearchParams(VALID))

    // Then 200 + 同一份信封，且上游收到解析后的请求
    expect(result.status).toBe(200)
    expect(result.payload).toEqual({ ok: true, ...HISTORY })
    expect(seen.calls).toEqual([{ meetingId: MEETING_ID, fromMs: FROM_MS, toMs: TO_MS, fidelityMinutes: 1 }])
  })

  it('运营经 HTTP 路由传超限窗口时收到 400、TRADING_PROTOCOL 与带小时数的消息', async () => {
    // Given 真实 apply 挂载的路由 + 720 小时窗口
    const seen = recorder()
    const { ctx, registered } = makeCtx(liveFeed(seen))
    apply(ctx)
    const route = registered[0] as RegisteredRoute
    const url = '/dshtrading/api/prediction/history?meetingId=' + MEETING_ID + '&fromMs=' + String(FROM_MS) + '&toMs=' + String(FROM_MS + 720 * 3600_000)

    // When 打一次真实 HTTP 路由
    const { status, body } = await callRoute(route, url)

    // Then 400 + 既有兜底协议码（本文件既有做法：坏参数不发明新词汇）+ 可读窗口消息
    const payload = JSON.parse(body) as { ok: boolean; code: string; message: string }
    expect(status).toBe(400)
    expect(payload.ok).toBe(false)
    expect(payload.code).toBe('TRADING_PROTOCOL')
    expect(payload.message).toContain('window 720h exceeds the 336h')
    expect(seen.calls).toEqual([])
  })

  it('运营看到上游取数失败时错误原样向上传播（桥不吞成空 series）', async () => {
    // Given 连接器在取历史时抛上游错误
    const failing: PredictionFeedLike = {
      listFomcMeetings: async () => ({ fetchedAt: HISTORY.fetchedAt, meetings: [] }),
      listPriceHistory: async () => {
        throw Object.assign(new Error('polymarket clob /prices-history: HTTP 429'), { code: 'TRADING_RATE_LIMITED' })
      },
    }

    // When / Then 桥不改写成败，错误词汇原样交给 HTTP 层
    await expect(makeBridge(failing).predictionHistory(VALID)).rejects.toMatchObject({ code: 'TRADING_RATE_LIMITED' })
  })

  it('运营看到上游确实没有变动时桥如实回空 series（与未安装可区分）', async () => {
    // Given 连接器成功应答但窗口内确实没有读数
    const quiet: PredictionFeedLike = {
      listFomcMeetings: async () => ({ fetchedAt: HISTORY.fetchedAt, meetings: [] }),
      listPriceHistory: async (request) => ({
        fetchedAt: HISTORY.fetchedAt,
        meetingId: request.meetingId,
        fromMs: request.fromMs,
        toMs: request.toMs,
        fidelityMinutes: request.fidelityMinutes ?? 1,
        series: [],
      }),
    }

    // When 请求历史
    const wire = await makeBridge(quiet).predictionHistory(VALID)

    // Then ok + 空 series（与缺席用例的 TRADING_NOT_IMPLEMENTED 明确不同）
    expect(wire).toEqual({
      ok: true,
      fetchedAt: HISTORY.fetchedAt,
      meetingId: MEETING_ID,
      fromMs: FROM_MS,
      toMs: TO_MS,
      fidelityMinutes: 1,
      series: [],
    })
  })
})
