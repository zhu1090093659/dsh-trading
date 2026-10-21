/**
 * GUI 实盘动作的官方逐动作审批适配（宿主 `ctx.approval.request`）。
 *
 * 为什么需要这一层：GUI 交易台（`POST/DELETE /trade/order`，默认 `dryRun:false`）
 * 不经 base 的 `tools/pre-execute` 闸门——那条面只覆盖 agent 工具调用。用户裁决
 * 「保留 GUI 实盘，接入官方逐动作审批」后，GUI 的实盘路径必须自己把同一个官方审批
 * 缝接上：`ctx.approval.request({ agent, toolName, reason, signal })`，只认
 * `allowed-once`。本模块不自制 approve 布尔量、不自制 token、不缓存授权。
 *
 * 契约来源（0.2.1-rc.2 只读核对，本包不运行期 import 该实现，用结构化最小面）：
 *   - `@deepseek-ai/dsh-user-approval` `lib/types/types.d.ts` 的封闭词表 =
 *     `'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'`，其中
 *     `allowed-once` 是**唯一**授权；其余一律 fail-closed。
 *   - `ApprovalRequest` 必填 `agent` 与 `toolName`，可选 `callId`/`reason`/`signal`；
 *     服务自动向**该 agent 的会话日志**追加 `approval/asked` + `approval/decided`
 *     审计对，并把问题按 agent 作用域派发给应答者。
 *
 * ## 为什么不能直接对空闲会话 ask（2026-10-12 实测修复）
 *
 * `ApprovalService.request` 有硬前置：目标会话日志必须处于打开的一轮
 * （`lib/index.js` 的 `hasOpenTurn`），因为审计对必须被 turn 包住——turn 是日志的
 * commit/replay 边界，裸事件会被当成崩溃尾巴在重放时丢掉。宿主空闲（用户看盘时直接
 * 下单）时直接 ask 100% 抛错，已交付的 GUI 实盘审批在真实场景里必然失败。
 * 而全官方 runtime 里 `turn/start` 的唯一生产者是 `dsh-agent-loop` 私有的
 * `ReactLoopAgent.turn()`，公开面只有 `create/createAgent/resume`——插件开不了轮。
 *
 * ## 合规路径（官方先例：`dsh-goal-round-driver`、`dsh-hooks-codex`）
 *
 * 座位声明一个自己的 `MessageSourceMap` source（用 `@deepseek-ai/dsh-llm` 的
 * `createUserMessage` 造消息），`authorize` 时等目标 agent 空闲
 * （`status==='idle'` 且 `inbox.nextTurn` 空），登记本轮任务后用
 * `agent.send(自有消息, 'next-turn', true)` 唤醒 loop（kick 同步、`preStep` 同步
 * claim 批次）。随后在 `agent/pre-step` 里只认自己的 source：批次只含自己时就地
 * `await ctx.approval.request(...)`（此刻 turn 已开，审计对合法落在这一轮内），
 * 再返回 `{kind:'reject'}`——得到一轮有 `turn/start..turn/end`、**无** `step/start`、
 * **无** `user/message`、**无**模型请求的官方轮次。作用域上普通 `ctx.on` 收全部
 * agent 事件（scope 对 untagged listener 全局放行），本层再按自己的 source 过滤。
 *
 * ## 代价（rc.2 既有成本，如实记账）
 *
 * **每一笔 GUI 实盘动作都会在该会话日志里留下一个空的持久 turn**：没有 step、没有
 * 模型调用，只有审计对与 blocked 收尾。这是 rc.2 上唯一合规通路的既有代价，不是本层
 * 的选择（审计对必须 turn-enclosed，而开轮的权力只在 agent-loop 手里）。控制消息的
 * 正文是纯内部标记，**绝不**进模型可见输入。
 *
 * ## 三个必须处理的边界（否则挂死或吞掉用户消息）
 *
 * 1. **批次混入他人消息**：`preStep` 一次 claim 整个 `next-step` 加一条
 *    `next-turn`，被 reject 的消息既不会发出也不会重新投递。本层把批次里不属于自己的
 *    消息按 `dsh-goal-round-driver` 的 `restoreOtherClaimed` 写法用
 *    `agent.inbox.prepend` 还回 `next-step`（他人的步上下文本来就该在下一个步边界
 *    被认领，且这一轮绝不为它们发起模型请求）。
 * 2. **reject 早退跳过续轮判定**：`turn()` 在 reject 上直接 `return false`，driver
 *    只在 `wakeRequested` 时补唤醒——审批轮收尾时若队列里还有他人的 next-turn 工作，
 *    工作会停在收件箱。本层在 agent 转空闲时补发一条**自消费**唤醒消息（kick 同步
 *    claim 走队首的他人消息）并立刻 `inbox.remove` 它自己，把排队工作交回它自己的轮次，
 *    且不留半截控制消息。
 * 3. **每会话串行 + 更早监听者先拒的兜底**：并发 GUI 动作在同一会话内排队（否则两条
 *    控制消息会合并进同一批次，且审批归属不清）。若更早的 `pre-step` 监听者
 *    （hooks deny、归档会话）先返回 `{kind:'reject'}`，本层 handler 根本不会跑，
 *    因此必须用 `session/event` 的 `turn/end` 兜底 fail-closed——绝不无限 await。
 *
 * fail-closed 出口只有 `TRADING_APPROVAL_DENIED`：审批服务缺席、无会话上下文、
 * agent/session 串号、宿主没有事件面、空闲等待超时、本轮在 ask 之前被关闭、
 * 无应答者（`unavailable`）、拒绝（`rejected`）、取消（`cancelled`）、HTTP 断连——
 * 一律拒绝，绝不伪造 dry-run 回执，绝不自动放行。
 *
 * 展示与绑定用同一个规范化快照：`market/symbol/side/type/quantity/price/intentId`
 * （撤单为 `market/orderId/symbol/intentId`）逐字段出现在 `reason` 里，用户批的就是
 * 屏幕上这一笔；agent 由 sessionId 解析并与 `agent.session.id` 复核，防止多窗口
 * 串会话误批。
 *
 * @module
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { MessageId, UserMessage } from '@deepseek-ai/dsh-llm'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /**
     * 审批轮次的自有控制消息：`ask` 承载一轮审批的占位，`wake` 承载 reject 之后的
     * 自消费补唤醒。两者都**永不**进入模型可见输入——本层的 pre-step 监听者只在自己
     * 的批次上返回 `{kind:'reject'}`，这一轮不会出现 `user/message`，也就没有模型请求。
     */
    'trading-gui-approval': {
      readonly kind: 'trading-gui-approval'
      /** 'ask' = 一轮审批的占位消息；'wake' = 补唤醒的自消费消息。 */
      readonly intent: 'ask' | 'wake'
      /** ask：本轮在座位登记表里的请求 id；wake：空串。 */
      readonly requestId: string
    }
  }
}

/** GUI 实盘动作被拒的唯一错误码（前端据此区分「审批没成」与「服务/凭证问题」）。 */
export const GUI_APPROVAL_DENIED = 'TRADING_APPROVAL_DENIED'

/**
 * 等待目标会话空闲、以及等待本轮被 loop 认领的缺省上限（毫秒）。
 * 宿主可用 {@link GuiApprovalHost.idleTimeoutMs} 覆盖（测试与特殊部署需要）。
 */
export const GUI_APPROVAL_IDLE_TIMEOUT_MS = 30_000

/** 审批轮次控制消息的 source kind（自己的词表成员，见模块顶部的声明）。 */
const GUI_APPROVAL_SOURCE_KIND = 'trading-gui-approval'

/**
 * 官方审批结果封闭词表（`@deepseek-ai/dsh-user-approval` 0.2.1-rc.2）。
 * `allowed-once` 是唯一授权值。
 */
export type GuiApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/** 宿主 `ctx.approval` 的最小结构面（真实实现 = `ApprovalService`）。 */
export interface ApprovalServiceLike {
  /** 一次性决策；实现细节见 @deepseek-ai/dsh-user-approval。 */
  request(req: {
    readonly agent: unknown
    readonly toolName: string
    readonly reason?: string
    readonly signal?: AbortSignal
  }): Promise<unknown>
}

/** 宿主 `agents` 服务的最小结构面：按 sessionId 取活跃 Agent（tasks/runner 同款）。 */
export interface GuiAgentRegistryLike {
  get(sessionId: string): unknown
}

/** Agent 收件箱的最小结构面（真实实现 = agent-loop 的 ReactLoopInbox）。 */
export interface GuiAgentInboxLike {
  /** 等待各自轮次的输入。 */
  readonly nextTurn: readonly UserMessage[]
  /** 等待下一个步边界的上下文输入。 */
  readonly nextStep: readonly UserMessage[]
  /**
   * 把一条待处理消息放回指定队列头部。
   * @param target - 目标队列。
   * @param message - 要放回的消息。
   */
  prepend(target: 'next-turn' | 'next-step', message: UserMessage): void
  /**
   * 移除一条仍待处理的消息（本层用它摘掉自消费唤醒消息）。
   * @param messageId - 消息身份。
   * @returns 该消息是否仍待处理（false = 已被 loop 认领）。
   */
  remove(messageId: MessageId): boolean
}

/** Agent 会话日志的最小结构面（真实实现 = dsh-session 的 Session）。 */
export interface GuiSessionLike {
  /** 会话 id（审批绑定与审计归属）。 */
  readonly id: string
}

/** Agent 的最小结构面（真实实现 = dsh-agent-loop 的 ReactLoopAgent）。 */
export interface GuiAgentLike {
  readonly session: GuiSessionLike
  /** 'idle' | 'running'（官方 AgentStatus）。 */
  readonly status: string
  readonly inbox: GuiAgentInboxLike
  /**
   * 把一条消息投进收件箱并可唤醒 driver。
   * @param message - 已识别的消息（source 声明生产者）。
   * @param target - 目标队列。
   * @param wakeup - 是否唤醒 driver。
   */
  send(message: UserMessage, target: 'next-turn' | 'next-step', wakeup: boolean): void
}

/** `agent/pre-step` waterfall 的载荷结构面（官方事件形状）。 */
export interface GuiPreStepPayload {
  readonly agent: GuiAgentLike
  readonly messages: readonly UserMessage[]
  readonly turn: number
  readonly step: number
  readonly signal: AbortSignal
}

/** `agent/pre-step` 的决策（官方 PreStepDecision 的结构面）。 */
export type GuiPreStepDecision =
  | { readonly kind: 'reject' }
  | { readonly kind: 'enter'; readonly messages: UserMessage[]; readonly startsRequestSeries?: true }

/** 会话日志事件的结构面（本层只读 `type`）。 */
export interface GuiSessionEventLike {
  readonly type: string
}

/**
 * 宿主事件面（cordis `ctx.on` 的结构面）。缺席 = 无法驱动官方轮次 → GUI 实盘
 * fail-closed（绝不退化成模拟单）。
 */
export interface GuiApprovalEventsLike {
  /**
   * 每个 proposed step 的水位线（cordis waterfall）；本层只认自己的 source。
   * @param listener - waterfall 监听者。
   * @returns 注销器。
   */
  onPreStep(listener: (payload: GuiPreStepPayload, next: () => Promise<GuiPreStepDecision>) => Promise<GuiPreStepDecision>): () => void
  /**
   * 会话日志事件；本层只认 `turn/end` 作兜底（更早的 pre-step 监听者拒绝时不会有 ask）。
   * @param listener - 事件监听者。
   * @returns 注销器。
   */
  onSessionEvent(listener: (session: GuiSessionLike, event: GuiSessionEventLike) => void): () => void
  /**
   * agent 状态迁移；本层用它等空闲与补唤醒。
   * @param listener - 事件监听者。
   * @returns 注销器。
   */
  onAgentStatus(listener: (payload: { readonly agent: unknown; readonly status: string }) => void): () => void
}

/** 桥可注入的审批宿主面（`index.ts` 从 cordis ctx 惰性解析）。 */
export interface GuiApprovalHost {
  /** 宿主审批服务；未挂载（headless/老部署）返回 undefined。 */
  approval(): ApprovalServiceLike | undefined
  /** 按会话 id 解析当前活跃 Agent；无活跃会话返回 undefined。 */
  agent(sessionId: string): unknown
  /** 宿主事件面；缺席 = 无法开审批轮 → 实盘 fail-closed。 */
  readonly events?: GuiApprovalEventsLike | undefined
  /** 空闲/开轮等待上限（毫秒）；缺省 {@link GUI_APPROVAL_IDLE_TIMEOUT_MS}。 */
  readonly idleTimeoutMs?: number | undefined
}

/** 规范化后的实盘下单动作（审批展示与绑定同源）。 */
export interface GuiPlaceOrderAction {
  readonly action: 'place-order'
  readonly market: string
  readonly symbol: string
  readonly side: 'buy' | 'sell'
  readonly type: 'market' | 'limit'
  readonly quantity: number
  readonly price?: number | undefined
  /** 本次逻辑提交的稳定意图 id（重试保持，成功或新意图轮换）。 */
  readonly intentId: string
  /** 发起动作的官方会话 id（审批绑定该会话的 agent）。 */
  readonly sessionId: string
}

/** 规范化后的实盘撤单动作。 */
export interface GuiCancelOrderAction {
  readonly action: 'cancel-order'
  readonly market: string
  readonly orderId: string
  readonly symbol?: string | undefined
  readonly intentId: string
  readonly sessionId: string
}

/** GUI 实盘动作（下单 / 撤单）：只有这两种进审批闸门。 */
export type GuiLiveAction = GuiPlaceOrderAction | GuiCancelOrderAction

/**
 * 审批工具名：与 base 闸门同一市场词汇（`<market>_place_order` /
 * `<market>_cancel_order`），审计里 GUI 动作与 agent 工具动作可同口径检索。
 */
export function guiLiveActionToolName(action: GuiLiveAction): string {
  return `${action.market}_${action.action === 'place-order' ? 'place_order' : 'cancel_order'}`
}

/**
 * 规范化参数快照（用户批的就是这一行）：字段顺序固定、缺省值显式化
 * （市价单显示 `price=none`，撤单显示 `orderId`），便于审计逐字比对。
 */
export function formatGuiLiveAction(action: GuiLiveAction): string {
  const head = `market=${action.market} action=${action.action}`
  const tail = `intentId=${action.intentId} sessionId=${action.sessionId}`
  if (action.action === 'cancel-order') {
    return `${head} orderId=${action.orderId} symbol=${action.symbol ?? 'none'} ${tail}`
  }
  return [
    head,
    `symbol=${action.symbol}`,
    `side=${action.side}`,
    `type=${action.type}`,
    `quantity=${String(action.quantity)}`,
    `price=${action.price === undefined ? 'none' : String(action.price)}`,
    tail,
  ].join(' ')
}

/** 审批被拒（缺席/无上下文/串会话/无应答者/拒绝/取消/断连/超时）：实盘路径唯一出口。 */
export class GuiApprovalDeniedError extends Error {
  /** 前端可判别的稳定错误码。 */
  readonly code = GUI_APPROVAL_DENIED
  constructor(reason: string) {
    super(`${GUI_APPROVAL_DENIED}: ${reason}`)
    this.name = 'GuiApprovalDeniedError'
  }
}

/** 逐动作审批座位：`authorize` 正常返回 = 拿到本次动作的一次性授权。 */
export interface GuiApprovalSeat {
  /**
   * 为一次具体动作取审批：等会话空闲 → 用自有控制消息开一轮官方轮次 → 在该轮内 ask。
   * @param action - 规范化动作（展示 + 绑定同源）。
   * @param options.signal - HTTP 连接信号；断连/超时即取消审批且不得继续报单。
   * @returns 仅当官方结果为 `allowed-once` 且信号仍活着时 resolve。
   * @throws GuiApprovalDeniedError 其它一切情形（含服务缺席、无应答者、忙碌超时、早退拒）。
   */
  authorize(action: GuiLiveAction, options?: { readonly signal?: AbortSignal | undefined }): Promise<void>
  /** 注销宿主事件监听（幂等）；插件卸载时调用。 */
  dispose(): void
}

/** 一轮在飞的审批：控制消息已被 loop 认领前后都以它为准。 */
interface PendingRound {
  readonly id: string
  readonly sessionId: string
  readonly session: GuiSessionLike
  readonly toolName: string
  readonly reason: string
  readonly signal: AbortSignal | undefined
  /** handler 是否已经在本轮里开始 ask（false = 更早的监听者把这一步拒了）。 */
  askStarted: boolean
  /** 结果是否已经落定（避免 turn/end 兜底与 handler 双报）。 */
  settled: boolean
  /** 本轮的 turn 是否已经关闭（控制消息是否已被消费）。 */
  turnClosed: boolean
  readonly outcome: Promise<unknown>
  readonly resolve: (outcome: unknown) => void
  readonly reject: (error: unknown) => void
  readonly markAsked: () => void
}

/** 本轮请求 id 的自增序列（只在进程内做登记键，无安全语义）。 */
let nextRoundId = 0

/** 读 agent 的会话日志；拿不到身份时返回 undefined（审批无处绑定）。 */
function sessionOfAgent(agent: unknown): GuiSessionLike | undefined {
  const session = (agent as { session?: GuiSessionLike } | null | undefined)?.session
  return session === undefined || session === null ? undefined : session
}

function sessionIdOfAgent(agent: unknown): string | undefined {
  const id = sessionOfAgent(agent)?.id
  return typeof id === 'string' && id !== '' ? id : undefined
}

/** 本层控制消息的 source 形状（与模块顶部 declare module 的成员一致）。 */
interface GuiControlMessageSource {
  readonly kind: 'trading-gui-approval'
  readonly intent: 'ask' | 'wake'
  readonly requestId: string
}

/** 这条消息是不是本层自己投的控制消息（只认自己的 source）。 */
function isOwnControlMessage(message: UserMessage): message is UserMessage & { readonly source: GuiControlMessageSource } {
  return message.source.kind === GUI_APPROVAL_SOURCE_KIND
}

/** 摘掉上一轮可能留在收件箱里的自有控制消息（超时/断连早退的半截轮次）。 */
function dropStaleControlMessages(agent: GuiAgentLike): void {
  for (const stale of agent.inbox.nextTurn.filter(isOwnControlMessage)) agent.inbox.remove(stale.id)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 带 signal 的一次性定时器；`kind` 区分超时与中断。 */
function deadline(ms: number, signal: AbortSignal | undefined): { readonly kind: Promise<'timeout' | 'aborted'>; cancel(): void } {
  let cleanup = (): void => {}
  const kind = new Promise<'timeout' | 'aborted'>(resolve => {
    let settled = false
    const finish = (value: 'timeout' | 'aborted'): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve(value)
    }
    const timer = setTimeout(() => finish('timeout'), ms)
    const onAbort = (): void => finish('aborted')
    cleanup = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted === true) finish('aborted')
  })
  return { kind, cancel: () => cleanup() }
}

/**
 * 建审批座位：把桥的实盘动作接到宿主官方审批服务上。
 *
 * fail-closed 顺序（任一不满足即拒，且**不**触碰交易所）：
 *   1. 有会话上下文（sessionId 非空）——否则无处绑定审批；
 *   2. 连接未断（signal 未 abort）；
 *   3. 该会话有活跃 Agent，且 `agent.session.id` 与请求的会话一致（多窗口串会话防线）；
 *   4. 宿主挂了 `ctx.approval`；
 *   5. 宿主有 agent/session 事件面（否则开不出合法轮次）；
 *   6. 目标会话在上限内空闲（否则排队等待超时即拒）；
 *   7. 本轮被 loop 认领并在 turn 内完成 ask（更早监听者先拒 → turn/end 兜底拒）；
 *   8. 官方结果为 `allowed-once`（rejected/cancelled/unavailable/异常一律拒）；
 *   9. 裁决返回时连接仍在。
 *
 * @param host - 宿主面（审批服务 + agents 注册表 + 事件面，皆惰性解析）。
 * @returns 审批座位。
 */
export function createGuiApprovalSeat(host: GuiApprovalHost): GuiApprovalSeat {
  // 显式标注的 never 返回函数：调用点之后 TS 才按「已排除」收窄（agent/approval 非空）。
  const deny: (reason: string) => never = (reason) => {
    throw new GuiApprovalDeniedError(reason)
  }
  /** sessionId → 每会话串行链（并标记该会话进过审批路径）。 */
  const sessions = new Map<string, { chain: Promise<void> }>()
  /** requestId → 在飞审批轮。 */
  const rounds = new Map<string, PendingRound>()
  const listeners: Array<() => void> = []
  let disposed = false

  const stateOf = (sessionId: string): { chain: Promise<void> } => {
    let state = sessions.get(sessionId)
    if (state === undefined) {
      state = { chain: Promise.resolve() }
      sessions.set(sessionId, state)
    }
    return state
  }

  /**
   * 每会话串行：并发 GUI 动作排队，避免两条控制消息合并进同一批次、审批归属不清。
   * @param sessionId - 会话 id。
   * @param run - 临界区。
   * @returns 临界区结果（异常照常上抛）。
   */
  const withSessionLock = <T>(sessionId: string, run: () => Promise<T>): Promise<T> => {
    const state = stateOf(sessionId)
    const result = state.chain.then(() => run(), () => run())
    // 链只关心「上一段跑完了」；成败由本段调用者自己收。
    state.chain = result.then(() => undefined, () => undefined)
    return result
  }

  const controlMessage = (source: { readonly intent: 'ask' | 'wake'; readonly requestId: string }, text: string): UserMessage =>
    createUserMessage({ content: [{ type: 'text', text }], source: { kind: GUI_APPROVAL_SOURCE_KIND, ...source } })

  const askMessage = (round: PendingRound): UserMessage =>
    controlMessage({ intent: 'ask', requestId: round.id }, `GUI live-action approval round — ${round.toolName} (internal control message; the user-facing snapshot lives on the approval/asked audit event)`)

  const wakeMessage = (): UserMessage =>
    controlMessage({ intent: 'wake', requestId: '' }, 'GUI approval round re-wake (internal control message; not model input)')

  /**
   * 把不属于本层的被 claim 消息还回收件箱（goal driver `restoreOtherClaimed` 同款）：
   * 倒序 prepend 才能保序；已被重新排队的消息不重复插入。
   */
  const restoreOtherClaimed = (agent: GuiAgentLike, messages: readonly UserMessage[]): void => {
    for (const message of [...messages].reverse()) {
      if (agent.inbox.nextStep.some(candidate => candidate.id === message.id)) continue
      if (agent.inbox.nextTurn.some(candidate => candidate.id === message.id)) continue
      agent.inbox.prepend('next-step', message)
    }
  }

  const settle = (round: PendingRound, outcome: unknown, error: unknown): void => {
    if (round.settled) return
    round.settled = true
    if (error !== undefined) round.reject(error)
    else round.resolve(outcome)
  }

  /**
   * 本轮的水位线：只认自己的 source。批次里只有自己的控制消息时，就地在本轮内 ask
   * 再 `reject`（这一轮不开 step、不发 user/message、不请求模型）。
   */
  const onPreStep = async (payload: GuiPreStepPayload, next: () => Promise<GuiPreStepDecision>): Promise<GuiPreStepDecision> => {
    const ours = payload.messages.filter(isOwnControlMessage)
    // 不是本层的批次：原样交给下游（绝不短路别人的 pre-step 判定）。
    if (ours.length === 0) return next()
    const others = payload.messages.filter(message => !isOwnControlMessage(message))
    if (others.length > 0) restoreOtherClaimed(payload.agent, others)
    const sessionId = sessionIdOfAgent(payload.agent)
    for (const message of ours) {
      if (message.source.intent !== 'ask') continue
      const round = rounds.get(message.source.requestId)
      // 登记表里没有（本轮已放弃）或轮次不属于这个会话：只消费控制消息，绝不借此 ask。
      if (round === undefined || round.sessionId !== sessionId) continue
      round.askStarted = true
      round.markAsked()
      if (round.settled) continue
      const approval = host.approval()
      if (approval === undefined) {
        settle(round, undefined, new GuiApprovalDeniedError('the host approval service (ctx.approval) is not mounted'))
        continue
      }
      // 本轮 turn 的取消信号与 HTTP 连接信号合流：任何一侧断开都让官方服务判 cancelled。
      const signal = round.signal === undefined
        ? payload.signal
        : AbortSignal.any([payload.signal, round.signal])
      try {
        settle(round, await approval.request({
          agent: payload.agent,
          toolName: round.toolName,
          reason: round.reason,
          signal,
        }), undefined)
      } catch (error) {
        settle(round, undefined, new GuiApprovalDeniedError(`the host approval ask produced no decision (${messageOf(error)})`))
      }
    }
    return { kind: 'reject' }
  }

  /**
   * turn/end 兜底：更早的 pre-step 监听者若先 reject，本层 handler 不会跑，
   * 这一轮就再也没有 ask 的机会——必须在这里 fail-closed，绝不无限 await。
   */
  const onSessionEvent = (session: GuiSessionLike, event: GuiSessionEventLike): void => {
    if (event.type !== 'turn/end') return
    for (const round of [...rounds.values()]) {
      if (round.session !== session) continue
      round.turnClosed = true
      rounds.delete(round.id)
      if (!round.askStarted) {
        settle(round, undefined, new GuiApprovalDeniedError('the approval round closed before the ask (an earlier pre-step listener rejected the batch)'))
      }
    }
  }

  /**
   * 空闲补唤醒：审批轮的 reject 会让 loop 跳过续轮判定，排队中的他人 next-turn 工作
   * 会停在收件箱。补发一条自消费唤醒消息（kick 同步 claim 走队首的他人消息），
   * 随即把它自己从收件箱摘除，避免留下半截控制消息或死循环。
   */
  const onAgentStatus = (payload: { readonly agent: unknown; readonly status: string }): void => {
    if (payload.status !== 'idle') return
    const candidate = payload.agent as Partial<GuiAgentLike> | null | undefined
    const sessionId = sessionIdOfAgent(candidate)
    const inbox = candidate?.inbox
    // 只碰本座位登记过的会话；其余会话的收件箱一概不动。
    if (sessionId === undefined || inbox === undefined || !sessions.has(sessionId)) return
    if (!inbox.nextTurn.some(message => !isOwnControlMessage(message))) return
    try {
      const agent = candidate as GuiAgentLike
      const wake = wakeMessage()
      agent.send(wake, 'next-turn', true)
      agent.inbox.remove(wake.id)
    } catch {
      // 补唤醒失败只意味着排队工作留在收件箱（下一次唤醒照常认领）；绝不在审批路径上伪造成功。
    }
  }

  const events = host.events
  if (events !== undefined) {
    listeners.push(events.onPreStep(onPreStep))
    listeners.push(events.onSessionEvent(onSessionEvent))
    listeners.push(events.onAgentStatus(onAgentStatus))
  }

  /**
   * 等目标会话空闲（有上限、认 signal）：忙碌会话上的 GUI 实盘动作排队等窗口，
   * 窗口用尽即 fail-closed——绝不把控制消息塞进别人正在跑的那一轮。
   */
  const waitIdle = (agent: GuiAgentLike, signal: AbortSignal | undefined, timeoutMs: number): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      let settled = false
      let stopStatus: (() => void) | undefined
      const finish = (error?: GuiApprovalDeniedError): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        stopStatus?.()
        if (error === undefined) resolve()
        else reject(error)
      }
      const evaluate = (): void => {
        if (signal?.aborted === true) {
          finish(new GuiApprovalDeniedError('the HTTP request went away while waiting for the session to become idle'))
          return
        }
        if (agent.status === 'idle' && agent.inbox.nextTurn.length === 0) finish()
      }
      const onAbort = (): void => finish(new GuiApprovalDeniedError('the HTTP request went away while waiting for the session to become idle'))
      const timer = setTimeout(() => finish(new GuiApprovalDeniedError(`the session stayed busy for ${String(timeoutMs)}ms; a GUI live action needs an idle session for its approval round`)), timeoutMs)
      stopStatus = events?.onAgentStatus((payload) => {
        if (payload.agent === agent && payload.status === 'idle') evaluate()
      })
      signal?.addEventListener('abort', onAbort, { once: true })
      evaluate()
    })

  return {
    async authorize(action, options) {
      const signal = options?.signal
      /** 连接是否已断。每次调用实时读：断连是异步事件，第二次读必须重新取值。 */
      const disconnected = (): boolean => signal?.aborted === true
      if (action.sessionId === '') {
        deny('the trading panel sent no session id, so this action has no agent/session to bind the approval to')
      }
      if (disconnected()) {
        deny('the HTTP request was already gone before the approval ask')
      }
      if (disposed) {
        deny('the GUI approval seat was disposed with its host plugin')
      }
      if (events === undefined) {
        deny('the host exposes no agent/session event seam, so no official approval round can be opened')
      }
      const agent = host.agent(action.sessionId)
      if (agent === undefined) {
        deny(`no live agent for session ${action.sessionId}`)
      }
      const agentSessionId = sessionIdOfAgent(agent)
      if (agentSessionId === undefined) {
        deny(`the live agent for session ${action.sessionId} exposes no session log to audit against`)
      }
      if (agentSessionId !== action.sessionId) {
        deny(`agent/session mismatch: asked for ${action.sessionId} but the registry resolved ${agentSessionId}`)
      }
      const liveAgent = agent as GuiAgentLike
      const session = sessionOfAgent(agent)
      if (session === undefined) {
        deny(`no session log for session ${action.sessionId}`)
      }
      if (host.approval() === undefined) {
        deny('the host approval service (ctx.approval) is not mounted')
      }
      const timeoutMs = host.idleTimeoutMs ?? GUI_APPROVAL_IDLE_TIMEOUT_MS
      // 登记该会话：此后它的空闲补唤醒由本座位负责（其他会话一概不碰）。
      stateOf(action.sessionId)
      await withSessionLock(action.sessionId, async () => {
        if (disconnected()) {
          deny('the HTTP request went away before the approval round')
        }
        // 上一轮可能在收件箱里留下自己的控制消息（超时/断连早退）：先摘掉，免得它既挡
        // 住空闲判定、又顶掉本轮的控制消息（留它在那儿只会让本轮永远等不到 ask）。
        dropStaleControlMessages(liveAgent)
        await waitIdle(liveAgent, signal, timeoutMs)
        dropStaleControlMessages(liveAgent)
        if (disconnected()) {
          deny('the HTTP request went away before the approval round opened')
        }
        const asked = Promise.withResolvers<void>()
        const outcome = Promise.withResolvers<unknown>()
        const round: PendingRound = {
          id: `gui-${String(nextRoundId += 1)}`,
          sessionId: action.sessionId,
          session,
          toolName: guiLiveActionToolName(action),
          reason: `GUI ${action.action} needs a one-shot user approval — ${formatGuiLiveAction(action)}`,
          signal,
          askStarted: false,
          settled: false,
          turnClosed: false,
          outcome: outcome.promise,
          resolve: outcome.resolve,
          reject: outcome.reject,
          markAsked: asked.resolve,
        }
        rounds.set(round.id, round)
        const gate = deadline(timeoutMs, signal)
        try {
          liveAgent.send(askMessage(round), 'next-turn', true)
          // 开轮是同步的：send 返回时 turn/start 已落、批次已被 claim。
          const opened = await Promise.race([
            asked.promise.then(() => 'asked' as const),
            round.outcome.then(() => 'closed' as const, () => 'closed' as const),
            gate.kind,
          ])
          gate.cancel()
          if (opened === 'aborted') {
            deny('the HTTP request went away while the approval round was opening')
          }
          if (opened === 'timeout') {
            settle(round, undefined, new GuiApprovalDeniedError(`the approval round did not open within ${String(timeoutMs)}ms`))
            deny(`the approval round did not open within ${String(timeoutMs)}ms`)
          }
          let decision: unknown
          try {
            decision = await round.outcome
          } catch (error) {
            deny(messageOf(error).replace(`${GUI_APPROVAL_DENIED}: `, ''))
          }
          if (decision !== 'allowed-once') {
            deny(`approval outcome ${JSON.stringify(decision)} is not a one-shot grant`)
          }
          if (disconnected()) {
            deny('the HTTP request went away while the approval was pending')
          }
        } finally {
          gate.cancel()
          // 轮次已关（turn/end 兜底读过）就交给兜底清理；否则这里收尾，免得表里留孤儿。
          if (!round.turnClosed) rounds.delete(round.id)
        }
      })
    },
    dispose() {
      disposed = true
      for (const off of listeners.splice(0)) off()
    },
  }
}
