/**
 * GUI 实盘动作的官方逐动作审批用例（user 视角 BDD，真宿主 runtime）。
 *
 * 被测缝：`POST/DELETE /trade/order` 的 GUI 实盘路径在触达交易所前，必须拿到宿主
 * `ApprovalService` 的一次性授权（`allowed-once`）。本文件的依赖全部是真实件，
 * 零 mock、零 spy、零 sleep、零 LLM 适配器：
 *   - 真 cordis `Context`，按官方依赖序起 SessionProjectionRegistry + SystemPrompt +
 *     SessionStore + AgentRegistry + LlmRuntime + ToolRuntime + ApprovalService + AgentLoop；
 *   - 真 `AgentLoop.create` 造出的 ReactLoopAgent：turn/start..turn/end 由官方 loop
 *     独占生产，审批审计对必须落在它打开的那一轮里（`ApprovalService.request` 的硬前置）；
 *   - 真 `ApprovalService`（`@deepseek-ai/dsh-user-approval` 0.2.1-rc.2）：应答者是同一缝
 *     上的 `approval/request` 监听者，不是 mock；
 *   - 会话日志（`session.snapshotEvents()`）就是审计证据本体：断言读事件 seq 与夹逼关系。
 *
 * 失败面（省略即漏）：审批服务缺席 / 无会话上下文 / 会话串号 / 无应答者（unavailable）/
 * 拒绝 / 请求中断（cancelled）/ 空闲等待超时 / 更早的 pre-step 监听者先拒 —— 一律
 * fail-closed 到 `TRADING_APPROVAL_DENIED`，交易所侧零动作，且轮次照常关闭、不挂死。
 */
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import type { ApprovalOutcome, ApprovalRequestEvent } from '@deepseek-ai/dsh-user-approval'
import { LlmRuntime } from '@deepseek-ai/dsh-llm'
import type { OrderRequest, TradeService } from '@dshtrading/api'
import { describe, expect, it, vi } from 'vitest'
import { TradingBridge, dispatchBridgeRequest, errorPayload, type BridgeHost } from '../src/bridge.ts'
import {
  GUI_APPROVAL_DENIED,
  createGuiApprovalSeat,
  type GuiApprovalEventsLike,
  type GuiApprovalHost,
  type GuiApprovalSeat,
} from '../src/gui-approval.ts'

const SESSION_ID = 'session-gui-1'
const ORDER_QUERY = new URLSearchParams({ market: 'crypto' })

const LIVE_ORDER_BODY = {
  symbol: 'BTCUSDT-SWAP',
  side: 'buy',
  type: 'limit',
  quantity: 0.02,
  price: 42000,
  dryRun: false,
  intentId: 'intent-live-1',
  sessionId: SESSION_ID,
}

/** 官方审批结果封闭词表（@deepseek-ai/dsh-user-approval/lib/types/types.d.ts）。 */
type WaitAnswer = (ask: AskRecord, index: number) => ApprovalOutcome | Promise<ApprovalOutcome>

interface AskRecord {
  readonly agent: unknown
  readonly toolName: string
  readonly reason: string | undefined
}

interface GuiRuntime {
  readonly ctx: Context
  readonly agent: Agent
  readonly session: Session
}

/** 真宿主 runtime：官方四件套（session/agent/loop/审批）+ 它们要求的官方服务。 */
async function bootRuntime(sessionId: string = SESSION_ID): Promise<GuiRuntime> {
  const ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(ApprovalService, { policy: 'ask' })
  await ctx.plugin(AgentLoop)
  const agent = await ctx.agentLoop.create(SessionId(sessionId))
  return { ctx, agent, session: agent.session }
}

/** 真审批座位：宿主事件面接在真 cordis ctx 上（与 index.ts 的接线段同构）。 */
function mountSeat(runtime: GuiRuntime, options: { readonly mountApproval?: boolean; readonly idleTimeoutMs?: number } = {}): GuiApprovalSeat {
  const { ctx } = runtime
  const events: GuiApprovalEventsLike = {
    onPreStep: listener => ctx.on('agent/pre-step', listener),
    onSessionEvent: listener => ctx.on('session/event', listener),
    onAgentStatus: listener => ctx.on('agent/status', listener),
  }
  const host: GuiApprovalHost = {
    approval: () => (options.mountApproval === false ? undefined : ctx.get('approval', false) as unknown as GuiApprovalHost['approval'] extends () => infer T ? T : never),
    agent: id => ctx.agents.get(SessionId(id)),
    events,
    ...(options.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: options.idleTimeoutMs }),
  }
  return createGuiApprovalSeat(host)
}

interface Answerer {
  readonly asked: AskRecord[]
  /** 应答策略（同一缝的真监听者）：按次序返回 outcome 或悬置的 promise。 */
  answer(policy: WaitAnswer): void
  /** 等到第 n 次（1 起）审批被问到；事件驱动，不轮询、不 sleep。 */
  askedTimes(n: number): Promise<AskRecord>
}

/** 真应答者：注册在 `approval/request` waterfall 上（不是 mock，也不是替身）。 */
function mountAnswerer(ctx: Context): Answerer {
  const asked: AskRecord[] = []
  const waiters: Array<{ readonly count: number; readonly resolve: (ask: AskRecord) => void }> = []
  let policy: WaitAnswer = () => 'unavailable'
  ctx.on('approval/request', (request: ApprovalRequestEvent) => {
    const record: AskRecord = { agent: request.agent, toolName: request.toolName, reason: request.reason }
    asked.push(record)
    for (const waiter of [...waiters]) {
      if (asked.length < waiter.count) continue
      waiters.splice(waiters.indexOf(waiter), 1)
      waiter.resolve(record)
    }
    return Promise.resolve(policy(record, asked.length - 1))
  })
  return {
    asked,
    answer: next => { policy = next },
    askedTimes: count => new Promise(resolve => {
      if (asked.length >= count) { resolve(asked[count - 1]!); return }
      waiters.push({ count, resolve })
    }),
  }
}

interface RecordingTrade {
  readonly service: TradeService
  readonly placed: Array<OrderRequest & { intentId?: string }>
  readonly canceled: string[]
}

/** 交易所边界替身：只记录真实到达交易所的动作（观测点是订单/撤单状态，不是调用次数）。 */
function recordingTrade(): RecordingTrade {
  const placed: Array<OrderRequest & { intentId?: string }> = []
  const canceled: string[] = []
  const service: TradeService = {
    async placeOrder(request) {
      placed.push(request)
      return {
        id: 'ord-' + String(placed.length),
        symbol: request.symbol,
        side: request.side,
        type: request.type,
        status: 'new',
        quantity: request.quantity,
        dryRun: request.dryRun ?? false,
        timestamp: 1,
      }
    },
    async cancelOrder(id) {
      canceled.push(id)
    },
    async getOrder(symbol, id) {
      return { id, symbol, side: 'buy', type: 'market', status: 'new', quantity: 1, dryRun: false, timestamp: 1 }
    },
    async getPositions() {
      return []
    },
  }
  return { service, placed, canceled }
}

function guiBridgeHost(seat: GuiApprovalSeat | undefined, trade: TradeService): BridgeHost {
  return {
    getMarketService: () => undefined,
    activeProvider: () => 'okx',
    getTradeService: market => (market === 'crypto' ? trade : undefined),
    ...(seat === undefined ? {} : { guiApproval: seat }),
  }
}

/**
 * 桥拒绝 → 前端实际看到的 payload 形状：路由层把非协议错误映射成
 * HTTP 200 + { ok:false, code, message }（bridge/index.ts 的 errorPayload 通路）。
 */
async function denialPayload(pending: Promise<{ status: number; payload: unknown }>): Promise<{ status?: number; ok?: boolean; code?: string; message?: string }> {
  try {
    const settled = await pending
    return { status: settled.status, ...(settled.payload as { ok?: boolean; code?: string; message?: string }) }
  } catch (error) {
    return { ok: false, ...errorPayload(error) }
  }
}

/** 会话日志的扁平投影（seq + type + data）：审计断言只读真事件。 */
interface LoggedEvent {
  readonly seq: number
  readonly type: string
  readonly data: Record<string, unknown>
}

function logOf(session: Session): LoggedEvent[] {
  return session.snapshotEvents().map(event => ({ seq: event.seq, type: event.type, data: event.data as unknown as Record<string, unknown> }))
}

function seqsOf(session: Session, type: string): number[] {
  return logOf(session).filter(event => event.type === type).map(event => event.seq)
}

/** 一次审批轮次的形状断言：turn 内只有审计对，没有 step、没有模型可见消息、没有错误。 */
function expectApprovalRoundShape(runtime: GuiRuntime): void {
  const log = logOf(runtime.session)
  const starts = log.filter(event => event.type === 'turn/start').map(event => event.seq)
  const ends = log.filter(event => event.type === 'turn/end').map(event => event.seq)
  const asked = log.filter(event => event.type === 'approval/asked').map(event => event.seq)
  const decided = log.filter(event => event.type === 'approval/decided').map(event => event.seq)
  expect(starts).toHaveLength(1)
  expect(ends).toHaveLength(1)
  expect(asked).toHaveLength(1)
  expect(decided).toHaveLength(1)
  expect(starts[0]! < asked[0]!).toBe(true)
  expect(asked[0]! < decided[0]!).toBe(true)
  expect(decided[0]! < ends[0]!).toBe(true)
  expect(seqsOf(runtime.session, 'step/start')).toEqual([])
  expect(seqsOf(runtime.session, 'user/message')).toEqual([])
  expect(seqsOf(runtime.session, 'agent/error')).toEqual([])
}

/** 一轮跑完后的收尾：等官方 loop 回到空闲（事件驱动，不 sleep）。 */
async function settle(runtime: GuiRuntime): Promise<void> {
  await runtime.agent.whenIdle()
}

describe('GUI 实盘动作的逐动作审批（真宿主 loop 轮次）', () => {
  it('user approving a live GUI order gets one official approval round in its own turn and the order reaches the exchange', async () => {
    // Given: 真宿主 runtime + 真应答者（授权一次）+ 记录用交易所边界 + GUI 桥
    const runtime = await bootRuntime()
    const seat = mountSeat(runtime)
    const answerer = mountAnswerer(runtime.ctx)
    answerer.answer(() => 'allowed-once')
    const trade = recordingTrade()
    const bridge = new TradingBridge(guiBridgeHost(seat, trade.service))

    // When: 用户在看盘时提交一笔实盘限价单（宿主此刻空闲）
    const { status, payload } = await dispatchBridgeRequest(bridge, 'POST', '/trade/order', ORDER_QUERY, LIVE_ORDER_BODY)
    await settle(runtime)

    // Then: 订单带完整参数与稳定意图到达交易所；审批审计对落在官方 loop 自己开的那一轮里
    expect(status).toBe(200)
    expect(payload).toMatchObject({ ok: true, order: { symbol: 'BTCUSDT-SWAP', dryRun: false } })
    expect(trade.placed).toEqual([
      { symbol: 'BTCUSDT-SWAP', side: 'buy', type: 'limit', quantity: 0.02, price: 42000, dryRun: false, intentId: 'intent-live-1' },
    ])
    expectApprovalRoundShape(runtime)
    expect(logOf(runtime.session).find(event => event.type === 'approval/decided')?.data).toMatchObject({ outcome: 'allowed-once' })
    // 审批展示快照与绑定：工具名同 base 词汇，reason 覆盖用户批的那一行，绑定实际 agent
    expect(answerer.asked).toHaveLength(1)
    expect(answerer.asked[0]!.agent).toBe(runtime.agent)
    expect(answerer.asked[0]!.toolName).toBe('crypto_place_order')
    for (const field of [
      'market=crypto',
      'symbol=BTCUSDT-SWAP',
      'side=buy',
      'type=limit',
      'quantity=0.02',
      'price=42000',
      'intentId=intent-live-1',
      'sessionId=session-gui-1',
    ]) {
      expect(answerer.asked[0]!.reason).toContain(field)
    }
    // 收件箱不留半截控制消息
    expect([...runtime.agent.inbox.nextTurn, ...runtime.agent.inbox.nextStep]).toEqual([])
  })

  it('user rejecting the approval keeps the exchange untouched and sees TRADING_APPROVAL_DENIED', async () => {
    // Given: 应答者明确拒绝
    const runtime = await bootRuntime()
    const seat = mountSeat(runtime)
    const answerer = mountAnswerer(runtime.ctx)
    answerer.answer(() => 'rejected')
    const trade = recordingTrade()
    const bridge = new TradingBridge(guiBridgeHost(seat, trade.service))

    // When: 用户提交实盘单
    const payload = await denialPayload(dispatchBridgeRequest(bridge, 'POST', '/trade/order', ORDER_QUERY, LIVE_ORDER_BODY))
    await settle(runtime)

    // Then: 没有订单（也不伪造 dry-run 回执），拒绝被记进该会话审计，轮次照常关闭
    expect(payload).toMatchObject({ ok: false, code: GUI_APPROVAL_DENIED })
    expect(trade.placed).toEqual([])
    expectApprovalRoundShape(runtime)
    expect(logOf(runtime.session).find(event => event.type === 'approval/decided')?.data).toMatchObject({ outcome: 'rejected' })
  })

  it('user on a host with no answerer receives the fail-closed denial instead of a silent trade', async () => {
    // Given: 审批服务在场但应答链为空（无人在场）
    const runtime = await bootRuntime()
    const seat = mountSeat(runtime)
    const trade = recordingTrade()
    const bridge = new TradingBridge(guiBridgeHost(seat, trade.service))

    // When: 提交实盘单
    const payload = await denialPayload(dispatchBridgeRequest(bridge, 'POST', '/trade/order', ORDER_QUERY, LIVE_ORDER_BODY))
    await settle(runtime)

    // Then: 归属 unavailable 的 fail-closed 拒绝，且这一轮仍然带完整审计对关闭
    expect(payload).toMatchObject({ ok: false, code: GUI_APPROVAL_DENIED })
    expect(trade.placed).toEqual([])
    expectApprovalRoundShape(runtime)
    expect(logOf(runtime.session).find(event => event.type === 'approval/decided')?.data).toMatchObject({ outcome: 'unavailable' })
  })

  it('user whose HTTP request goes away while the approval is pending gets no order and the round still closes', async () => {
    // Given: 审批悬置未决（应答者不表态），客户端连接随后断开
    const runtime = await bootRuntime()
    const seat = mountSeat(runtime)
    const answerer = mountAnswerer(runtime.ctx)
    answerer.answer(() => new Promise<ApprovalOutcome>(() => {}))
    const trade = recordingTrade()
    const bridge = new TradingBridge(guiBridgeHost(seat, trade.service))
    const disconnect = new AbortController()

    // When: 请求带着连接信号发出，并在审批未决时被取消
    const pending = dispatchBridgeRequest(bridge, 'POST', '/trade/order', ORDER_QUERY, LIVE_ORDER_BODY, disconnect.signal)
    await answerer.askedTimes(1)
    disconnect.abort()
    const payload = await denialPayload(pending)
    await settle(runtime)

    // Then: 明确拒绝、交易所零动作，取消被记进审计，turn 仍然关闭
    expect(payload).toMatchObject({ ok: false, code: GUI_APPROVAL_DENIED })
    expect(trade.placed).toEqual([])
    expectApprovalRoundShape(runtime)
    expect(logOf(runtime.session).find(event => event.type === 'approval/decided')?.data).toMatchObject({ outcome: 'cancelled' })
  })

  it('user placing two live actions at once gets two serialized approval rounds and both orders', async () => {
    // Given: 第一笔的审批被用户悬置未决（应答者持着不表态）
    const runtime = await bootRuntime()
    const seat = mountSeat(runtime)
    const answerer = mountAnswerer(runtime.ctx)
    let grantFirst: (() => void) | undefined
    answerer.answer((_ask, index) => (index === 0
      ? new Promise<ApprovalOutcome>(resolve => { grantFirst = () => { resolve('allowed-once') } })
      : 'allowed-once'))
    const trade = recordingTrade()
    const bridge = new TradingBridge(guiBridgeHost(seat, trade.service))

    // When: 用户连点两笔实盘单（两个意图），第一笔的审批还挂着
    const first = dispatchBridgeRequest(bridge, 'POST', '/trade/order', ORDER_QUERY, LIVE_ORDER_BODY)
    await answerer.askedTimes(1)
    const second = dispatchBridgeRequest(bridge, 'POST', '/trade/order', ORDER_QUERY, { ...LIVE_ORDER_BODY, intentId: 'intent-live-2' })
    await Promise.resolve()

    // Then: 第二笔排队等第一笔收尾——此刻只有一轮开着，只有一次审批被问
    expect(seqsOf(runtime.session, 'turn/start')).toHaveLength(1)
    expect(answerer.asked).toHaveLength(1)
    grantFirst!()
    const [firstResult, secondResult] = await Promise.all([first, second])
    await settle(runtime)

    // Then: 两笔都到达交易所，两轮各自带一组完整审批对（授权只覆盖它批准的那一次动作）
    expect(firstResult.status).toBe(200)
    expect(secondResult.status).toBe(200)
    expect(trade.placed.map(order => order.intentId)).toEqual(['intent-live-1', 'intent-live-2'])
    expect(answerer.asked.map(ask => ask.toolName)).toEqual(['crypto_place_order', 'crypto_place_order'])
    const log = logOf(runtime.session)
    expect(log.filter(event => event.type === 'approval/asked')).toHaveLength(2)
    expect(log.filter(event => event.type === 'approval/decided')).toHaveLength(2)
    expect(log.filter(event => event.type === 'turn/start')).toHaveLength(2)
    expect(log.filter(event => event.type === 'turn/end')).toHaveLength(2)
    expect(seqsOf(runtime.session, 'step/start')).toEqual([])
    expect(seqsOf(runtime.session, 'user/message')).toEqual([])
    expect(seqsOf(runtime.session, 'agent/error')).toEqual([])
    const firstTurnEnd = log.find(event => event.type === 'turn/end')!.seq
    const secondTurnStart = log.filter(event => event.type === 'turn/start')[1]!.seq
    expect(firstTurnEnd < secondTurnStart).toBe(true)
  })

  it('user typing in the chat while an approval is pending keeps that message for its own turn', async () => {
    // Given: 一个实盘动作的审批挂着，用户同时在对话里发了一句话
    const runtime = await bootRuntime()
    const seat = mountSeat(runtime)
    const answerer = mountAnswerer(runtime.ctx)
    let grant: (() => void) | undefined
    answerer.answer(() => new Promise<ApprovalOutcome>(resolve => { grant = () => { resolve('allowed-once') } }))
    // 会话自己的轮次处理（这里以拒绝收尾：没有 LLM 适配器，本用例只证明消息回到了它自己的轮次）
    const claimed: Array<{ readonly turn: number; readonly text: string }> = []
    runtime.ctx.on('agent/pre-step', payload => {
      for (const message of payload.messages) {
        claimed.push({ turn: payload.turn, text: message.content.map(block => (block.type === 'text' ? block.text : '')).join('') })
      }
      return { kind: 'reject' as const }
    })
    const trade = recordingTrade()
    const bridge = new TradingBridge(guiBridgeHost(seat, trade.service))

    // When: 实盘单的审批还没裁决，用户先发了一句话
    const order = dispatchBridgeRequest(bridge, 'POST', '/trade/order', ORDER_QUERY, LIVE_ORDER_BODY)
    await answerer.askedTimes(1)
    runtime.agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'USER-CHAT-MESSAGE' }],
      source: { kind: 'user' },
    }))
    expect(runtime.agent.inbox.nextTurn).toHaveLength(1)
    grant!()
    await order
    await settle(runtime)

    // Then: 那句话在审批轮之后的自己那一轮被认领，没有被审批轮吞掉，收件箱也不留残骸
    const approvalTurn = logOf(runtime.session).find(event => event.type === 'turn/start')!.data.turn
    const chatTurn = claimed.find(entry => entry.text.includes('USER-CHAT-MESSAGE'))
    expect(chatTurn).toBeDefined()
    expect(chatTurn!.turn).toBeGreaterThan(Number(approvalTurn))
    expect([...runtime.agent.inbox.nextTurn, ...runtime.agent.inbox.nextStep]).toEqual([])
    expect(seqsOf(runtime.session, 'user/message')).toEqual([])
    expect(seqsOf(runtime.session, 'agent/error')).toEqual([])
  })

  it('user placing a live order while injected step context is pending keeps that context for its own step boundary', async () => {
    // Given: 另一个插件往 next-step 注入了上下文（官方语义：inject 不唤醒 driver），会话仍空闲
    const runtime = await bootRuntime()
    const seat = mountSeat(runtime)
    const answerer = mountAnswerer(runtime.ctx)
    answerer.answer(() => 'allowed-once')
    const trade = recordingTrade()
    const bridge = new TradingBridge(guiBridgeHost(seat, trade.service))
    const context = createUserMessage({ content: [{ type: 'text', text: 'INJECTED-STEP-CONTEXT' }], source: { kind: 'user' } })
    runtime.agent.inject(context)
    expect(runtime.agent.status).toBe('idle')
    expect(runtime.agent.inbox.nextTurn).toEqual([])

    // When: 用户提交实盘单——控制消息与这份上下文会落进同一个被 claim 的批次
    const { payload } = await dispatchBridgeRequest(bridge, 'POST', '/trade/order', ORDER_QUERY, LIVE_ORDER_BODY)
    await settle(runtime)

    // Then: 审批照常在这一轮内完成，他人的步上下文被还回 next-step（不吞掉，也不进这一轮）
    expect(payload).toMatchObject({ ok: true })
    expect(trade.placed).toHaveLength(1)
    expectApprovalRoundShape(runtime)
    expect(runtime.agent.inbox.nextStep.map(message => message.id)).toEqual([context.id])
    expect(runtime.agent.inbox.nextTurn).toEqual([])
  })

  it('user whose approval round is rejected by an earlier pre-step listener gets the fail-closed denial instead of a hang', async () => {
    // Given: 一个更早注册的 pre-step 监听者直接拒绝（hooks deny / 归档会话一类）
    const runtime = await bootRuntime()
    runtime.ctx.on('agent/pre-step', () => ({ kind: 'reject' as const }))
    const seat = mountSeat(runtime)
    const answerer = mountAnswerer(runtime.ctx)
    answerer.answer(() => 'allowed-once')
    const trade = recordingTrade()
    const bridge = new TradingBridge(guiBridgeHost(seat, trade.service))

    // When: 用户提交实盘单（我们的 handler 根本没机会跑）
    const payload = await denialPayload(dispatchBridgeRequest(bridge, 'POST', '/trade/order', ORDER_QUERY, LIVE_ORDER_BODY))
    await settle(runtime)

    // Then: 明确拒绝、交易所零动作、没有任何审批被问，且轮次照常关闭（不无限 await）
    expect(payload).toMatchObject({ ok: false, code: GUI_APPROVAL_DENIED })
    expect(trade.placed).toEqual([])
    expect(answerer.asked).toEqual([])
    expect(seqsOf(runtime.session, 'turn/start')).toHaveLength(1)
    expect(seqsOf(runtime.session, 'turn/end')).toHaveLength(1)
    expect(seqsOf(runtime.session, 'user/message')).toEqual([])
  })

  it('user on a session busy with another turn is denied when the idle wait runs out', async () => {
    // Given: 会话正忙（另一轮挂在 pre-step 上），宿主空闲窗口超时上限
    const runtime = await bootRuntime()
    const seat = mountSeat(runtime, { idleTimeoutMs: 30_000 })
    const answerer = mountAnswerer(runtime.ctx)
    answerer.answer(() => 'allowed-once')
    const trade = recordingTrade()
    const bridge = new TradingBridge(guiBridgeHost(seat, trade.service))
    let releaseBusy: ((decision: { kind: 'reject' }) => void) | undefined
    runtime.ctx.on('agent/pre-step', () => new Promise<{ kind: 'reject' }>(resolve => { releaseBusy = resolve }))
    runtime.agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'BUSY-TURN' }],
      source: { kind: 'user' },
    }))
    expect(runtime.agent.status).toBe('running')

    // When: 用户在忙碌会话里提交实盘单，等待窗口用尽
    vi.useFakeTimers()
    try {
      const pending = denialPayload(dispatchBridgeRequest(bridge, 'POST', '/trade/order', ORDER_QUERY, LIVE_ORDER_BODY))
      const denial = expect(pending).resolves.toMatchObject({ ok: false, code: GUI_APPROVAL_DENIED })
      await vi.advanceTimersByTimeAsync(30_000)
      await denial
    } finally {
      vi.useRealTimers()
    }
    releaseBusy!({ kind: 'reject' })
    await settle(runtime)

    // Then: 拒绝、交易所零动作、审批从未被问，忙碌会话自己的轮次仍正常收尾
    expect(trade.placed).toEqual([])
    expect(answerer.asked).toEqual([])
    expect(seqsOf(runtime.session, 'approval/asked')).toEqual([])
    expect(seqsOf(runtime.session, 'turn/start')).toHaveLength(1)
    expect(seqsOf(runtime.session, 'turn/end')).toHaveLength(1)
  })

  it('user with no live session for the requested id is denied before any approval is asked', async () => {
    // Given: 面板拿不到当前会话 id，或会话已不在宿主
    const runtime = await bootRuntime()
    const seat = mountSeat(runtime)
    const answerer = mountAnswerer(runtime.ctx)
    answerer.answer(() => 'allowed-once')
    const trade = recordingTrade()
    const bridge = new TradingBridge(guiBridgeHost(seat, trade.service))

    // When: 提交实盘单（无 sessionId / 未知 sessionId）
    const withoutSession = await denialPayload(dispatchBridgeRequest(bridge, 'POST', '/trade/order', ORDER_QUERY, {
      ...LIVE_ORDER_BODY, sessionId: undefined,
    }))
    const unknownSession = await denialPayload(dispatchBridgeRequest(bridge, 'POST', '/trade/order', ORDER_QUERY, {
      ...LIVE_ORDER_BODY, sessionId: 'session-from-another-window',
    }))

    // Then: 两次都明确拒绝，交易所零动作，宿主会话日志里连一轮都没开过
    expect(withoutSession).toMatchObject({ ok: false, code: GUI_APPROVAL_DENIED })
    expect(unknownSession).toMatchObject({ ok: false, code: GUI_APPROVAL_DENIED })
    expect(trade.placed).toEqual([])
    expect(answerer.asked).toEqual([])
    expect(seqsOf(runtime.session, 'turn/start')).toEqual([])
    expect(seqsOf(runtime.session, 'approval/asked')).toEqual([])
  })

  it('user on a host without the approval service is denied rather than silently trading', async () => {
    // Given: 宿主未挂 ctx.approval（headless / 老部署）
    const runtime = await bootRuntime()
    const seat = mountSeat(runtime, { mountApproval: false })
    const trade = recordingTrade()
    const bridge = new TradingBridge(guiBridgeHost(seat, trade.service))

    // When: 提交实盘单
    const payload = await denialPayload(dispatchBridgeRequest(bridge, 'POST', '/trade/order', ORDER_QUERY, LIVE_ORDER_BODY))

    // Then: 拒绝、交易所零动作，会话日志零审计
    expect(payload).toMatchObject({ ok: false, code: GUI_APPROVAL_DENIED })
    expect(trade.placed).toEqual([])
    expect(seqsOf(runtime.session, 'turn/start')).toEqual([])
    expect(seqsOf(runtime.session, 'approval/asked')).toEqual([])
  })

  it('user approving a GUI cancel cancels exactly that order under the same gate', async () => {
    // Given: 真宿主 runtime + 授权一次的应答者 + 一个已挂单
    const runtime = await bootRuntime()
    const seat = mountSeat(runtime)
    const answerer = mountAnswerer(runtime.ctx)
    answerer.answer(() => 'allowed-once')
    const trade = recordingTrade()
    const bridge = new TradingBridge(guiBridgeHost(seat, trade.service))

    // When: 用户撤单
    const { payload } = await dispatchBridgeRequest(
      bridge, 'DELETE', '/trade/order',
      new URLSearchParams({ market: 'crypto', id: 'ord-1', symbol: 'BTCUSDT-SWAP', sessionId: SESSION_ID, intentId: 'intent-cancel-1' }),
    )
    await settle(runtime)

    // Then: 撤单到达交易所，审批同样落在一轮真轮次里，工具名同 base 词汇
    expect(payload).toEqual({ ok: true, canceled: true })
    expect(trade.canceled).toEqual(['ord-1'])
    expectApprovalRoundShape(runtime)
    expect(answerer.asked[0]?.toolName).toBe('crypto_cancel_order')
    expect(answerer.asked[0]?.reason).toContain('orderId=ord-1')
  })

  it('user approving once is asked again for the next action (a grant never carries over)', async () => {
    // Given: 授权一次的审批面
    const runtime = await bootRuntime()
    const seat = mountSeat(runtime)
    const answerer = mountAnswerer(runtime.ctx)
    answerer.answer(() => 'allowed-once')
    const trade = recordingTrade()
    const bridge = new TradingBridge(guiBridgeHost(seat, trade.service))

    // When: 用户连做两笔实盘动作（同一会话、两个意图）
    await dispatchBridgeRequest(bridge, 'POST', '/trade/order', ORDER_QUERY, LIVE_ORDER_BODY)
    await settle(runtime)
    await dispatchBridgeRequest(bridge, 'POST', '/trade/order', ORDER_QUERY, { ...LIVE_ORDER_BODY, intentId: 'intent-live-2' })
    await settle(runtime)

    // Then: 两笔各自到达交易所，审计对是两组（授权只覆盖它批准的那一次动作）
    expect(trade.placed.map(order => order.intentId)).toEqual(['intent-live-1', 'intent-live-2'])
    expect(logOf(runtime.session).filter(event => event.type === 'approval/asked' || event.type === 'approval/decided').map(event => event.type)).toEqual([
      'approval/asked', 'approval/decided', 'approval/asked', 'approval/decided',
    ])
    expect(seqsOf(runtime.session, 'turn/start')).toHaveLength(2)
    expect(seqsOf(runtime.session, 'step/start')).toEqual([])
  })
})
