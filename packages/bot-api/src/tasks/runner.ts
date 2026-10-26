/**
 * 右侧栏定时任务——执行 runner：经宿主 typertGateway 创建真实 dsh 会话并发
 * 送任务 prompt（queue 模式），随后从会话列表 + 有界历史页侦查执行结果。
 *
 * 网关词汇与线参数表移植自 dsh-web dsh-task-board 的 host-runner（0.1.2-alpha.2
 * 描述符表实证：agentPresets/list 无参必须传空对象，session/list 用 _request 键，
 * 其他 session 方法用 request 键；多传/少传都会被网关 assertExactArguments 拒
 * 绝）。本包不依赖宿主 SDK 类型——网关/命令/工作区全部用最小结构面，运行时
 * 鸭子解析（与 node 半既有 webServer/connection 面同策略）。
 *
 * 宿主 gateway 的 peer 契约（2026-10-22 实测，宿主 prepareInvocation 首行
 * assertPeerLive(request.peer) 读 peer.signal.aborted）：每次 invoke/stream 都必须
 * 带一个活的 in-process owner Peer。Peer 的官方铸造入口是 connection.createPeer
 * （Peer 归读取该服务的 ctx 所有），座位 GatewayPeerSeat 负责惰性铸造、缓存复用、
 * aborted 后重建与 teardown 释放；老宿主没有这个面时请求形状退回不带 peer。
 */

/** 执行会话记录（最小结构面）。 */
export interface RunnerTask {
  readonly id: string
  readonly title: string
  readonly prompt: string
  readonly workspaceId?: string
  readonly agentPreset?: string
  readonly permission?: string
}

/** 宿主 in-process Peer 的最小结构面（dsh-client-connection 的 Peer：signal 随
 *  所有者 ctx 销毁而 abort，dispose 幂等返回 Promise）。 */
export interface PeerLike {
  readonly signal: { readonly aborted: boolean }
  dispose?(): unknown
}

/** 铸造 Peer 的宿主入口面（connection 服务；老宿主与 botFence 没有 createPeer）。 */
export interface PeerFactoryLike {
  createPeer?(options: { principal: { kind: 'owner' } }): PeerLike
}

/** 一次网关调用的线形状：带不带 peer 决定新旧两种请求体。 */
export interface GatewayRequest {
  namespace: string
  method: string
  args: Record<string, unknown>
  signal?: AbortSignal
  peer?: PeerLike
}

/** typertGateway 的最小结构面。 */
export interface SessionGateway {
  invoke(request: GatewayRequest): Promise<unknown>
  stream?(request: GatewayRequest): Promise<AsyncIterable<unknown>>
}

/** 释放一个 Peer：尽力而为——宿主已收走它时 dispose 可能抛错或拒绝，不波及调度。 */
function releasePeer(peer: PeerLike): void {
  try {
    void Promise.resolve(peer.dispose?.()).catch(() => undefined)
  } catch {
    // 同一口径：释放失败不改变调用结果。
  }
}

/**
 * 一个插件持有的 owner Peer 座位：首次调用铸造、之后复用；缓存的 Peer 已随宿主
 * 释放（signal.aborted）则重建；插件 teardown 时释放。
 * 宿主没有 createPeer（老宿主 / bot 宿主）→ 恒返回 undefined，调用方退回不带
 * peer 的请求形状。
 */
export class GatewayPeerSeat {
  private peer: PeerLike | undefined

  constructor(private readonly factory: () => PeerFactoryLike | undefined) {}

  current(): PeerLike | undefined {
    const cached = this.peer
    if (cached !== undefined && cached.signal.aborted !== true) return cached
    if (cached !== undefined) {
      this.peer = undefined
      releasePeer(cached)
    }
    const factory = this.factory()
    // 以方法形态调用：宿主 createPeer 用 this.ctx 铸 Peer，脱离接收者会丢所有者。
    if (factory?.createPeer === undefined) return undefined
    const peer = factory.createPeer({ principal: { kind: 'owner' } })
    this.peer = peer
    return peer
  }

  dispose(): void {
    const cached = this.peer
    this.peer = undefined
    if (cached !== undefined) releasePeer(cached)
  }
}

/** /permission 命令派发面（宿主 commands 服务）。
 *  0.1.5-rc.1 契约：execute(agent, line, submittedAttachments, signal)。
 *  旧契约是 execute(sessionId, line, signal)——错传会把 signal 顶到
 *  submittedAttachments 位置，导致服务内 `signal.aborted` 抛 TypeError
 *  （2026-09-13 定时任务启动故障的根因）。 */
export interface SessionCommandDispatcher {
  execute(agent: unknown, line: string, submittedAttachments: readonly unknown[], signal: AbortSignal): Promise<unknown>
}

/** 宿主 agents 服务面：按 sessionId 取活跃 Agent（commands.execute 的首参）。 */
export interface AgentRegistryLike {
  get(sessionId: string): unknown
}

/** 工作区名册面（宿主 workspaceRegistry 服务）。 */
export interface WorkspaceRegistryLike {
  list(): readonly { id: string }[]
}

/** 钉住工作区在名册中的三态：在册 / 权威否定 / 不可知（见 probeWorkspace）。 */
export type WorkspaceRosterState = 'present' | 'absent' | 'unknown'

/** 启动后的失败：仍携带会话 id，账本据此把执行挂到该会话上观察收尾。 */
export class SessionLaunchError extends Error {
  constructor(readonly sessionId: string, cause: unknown) {
    // 诊断留痕：启动失败的真实栈必须可见——只带 message 会把根因（如 TypeError）永远吃掉。
    const detail = cause instanceof Error ? (cause.stack ?? cause.message) : String(cause)
    console.error('[trading-tasks] session launch failed:', sessionId, detail)
    super('execution session ' + sessionId + ' failed during launch: ' + detail, { cause })
    this.name = 'SessionLaunchError'
  }
}

/**
 * 一次侦查的产出。pending 可携带诊断（为什么这条执行还开着）与
 * historyExhausted：后者只在「会话在名册中、非运行中，且完整历史扫描确认没有
 * 任何 turn/end」时为真——那是可收敛的失联执行判据；正常等待与读取异常都不置位，
 * 服务层据此决定「留原因」还是「按窗口收敛」。
 */
export type ExecutionInspection =
  | { outcome: 'pending'; diagnostic?: string; historyExhausted?: boolean }
  | { outcome: 'succeeded' }
  | { outcome: 'failed'; error: string }
  | { outcome: 'cancelled'; error: string }

/** 人类可读的错误消息（诊断留痕用）。 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 网关目标服务未激活完的错误码（启动时序竞态要重试而不是判死）。 */
export function isServiceUnavailable(error: unknown): boolean {
  const code = (error as { code?: unknown }).code
  return code === 'service-unavailable' || code === 'gateway/service-unavailable'
}

const SERVICE_UNAVAILABLE_ATTEMPTS = 5
const SERVICE_UNAVAILABLE_BACKOFF_MS = 2_000

function delay(ms: number): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, ms) })
}

function sessionAddress(sessionId: string): { kind: 'session'; sessionId: string } {
  return { kind: 'session', sessionId }
}

/**
 * 0.1.2-alpha.2 描述符表的线参数布局（见模块头注）。
 */
function invokeWireArgs(namespace: string, method: string, request: Record<string, unknown>): Record<string, unknown> {
  if (namespace === 'agentPresets' && method === 'list') return {}
  if (namespace === 'session' && method === 'list') return { _request: request }
  return { request }
}

/** 执行 prompt：prompt 优先，退回标题（无续接包裹）。 */
export function executionPrompt(task: RunnerTask): string {
  return task.prompt !== '' ? task.prompt : task.title
}

/**
 * 按当前 SDK 的 TurnEndReasonMap（dsh-session 0.2.1-rc.2，只读查 schema 得到）
 * 判定一次 turn 的结局：
 * - `completed` 才是正常结束；
 * - `aborted` 是取消（用户/父级/hook/disposed/legacy 的 cancel cause）；
 * - `error` 是失败（LlmFailure 的 message + code 原样带出）；
 * - 其余（blocked/max-tokens/interrupted/forked 与未来新增成员）与缺失 reason
 *   一律判失败——不能把任意非 error 当作成功。
 */
export function classifyTurnEnd(data: unknown): { outcome: 'succeeded' } | { outcome: 'failed'; error: string } | { outcome: 'cancelled'; error: string } {
  const reason = (data as { reason?: unknown } | undefined)?.reason as { kind?: unknown; reason?: unknown; error?: unknown } | undefined
  const kind = reason?.kind
  if (kind === 'completed') return { outcome: 'succeeded' }
  if (kind === 'aborted') {
    const cause = reason?.reason as { kind?: unknown; reason?: unknown } | undefined
    const causeKind = typeof cause?.kind === 'string' ? cause.kind : 'unknown'
    const detail = typeof cause?.reason === 'string' ? ' (' + cause.reason + ')' : ''
    return { outcome: 'cancelled', error: 'agent turn was aborted (' + causeKind + ')' + detail }
  }
  if (kind === 'error') {
    const failure = reason?.error as { message?: unknown; code?: unknown } | undefined
    const message = typeof failure?.message === 'string' && failure.message !== '' ? failure.message : 'agent turn failed'
    const code = typeof failure?.code === 'string' && failure.code !== '' ? ' [' + failure.code + ']' : ''
    return { outcome: 'failed', error: message + code }
  }
  if (typeof kind === 'string') return { outcome: 'failed', error: 'agent turn ended with reason "' + kind + '"' }
  return { outcome: 'failed', error: 'agent turn ended without a reason' }
}

/**
 * 执行身份的稳定派生：同一执行 id 永远映射到同一个会话 id 与同一个 prompt
 * requestId。于是 SDK 层的 `session/create`（显式 sessionId 走 ensureSession
 * 采纳）与 `session/prompt`（同 requestId 命中 hasPromptRequest 去重）天然幂等
 * ——重启/重试不会另开一个会话，也不会把同一条 prompt 发第二遍。
 */
function sessionIdForExecution(executionId: string): string {
  return 'session-' + executionId
}

function promptRequestIdForExecution(executionId: string): string {
  return 'dshtrading-tasks-' + executionId
}

export class TasksRunner {
  /**
   * 每会话的扫描备忘：最新已扫事件序号 + 那次扫描是否已翻到边界。备忘命中时
   * 不再重复翻历史页，但仍要如实报出「完整历史无 turn/end」——否则服务层会
   * 永远看不到 historyExhausted，失联执行无法收敛。
   */
  private readonly scanMemos = new Map<string, { cursor: number; historyExhausted: boolean }>()

  constructor(
    private readonly gateway: () => SessionGateway | undefined,
    private readonly commands: () => SessionCommandDispatcher | undefined = () => undefined,
    private readonly workspaces: () => WorkspaceRegistryLike | undefined = () => undefined,
    private readonly agents: () => AgentRegistryLike | undefined = () => undefined,
    private readonly peer: () => PeerLike | undefined = () => undefined,
  ) {}

  private session(): SessionGateway {
    const gateway = this.gateway()
    if (gateway === undefined) {
      throw new Error('session gateway (typertGateway) is unavailable on this host')
    }
    return gateway
  }

  private invoke(gateway: SessionGateway, namespace: string, method: string, request: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const peer = this.peer()
    return gateway.invoke({
      namespace,
      method,
      args: invokeWireArgs(namespace, method, request),
      ...(signal === undefined ? {} : { signal }),
      ...(peer === undefined ? {} : { peer }),
    })
  }

  /**
   * agent 预设名册：launch 的预设校验与 meta 的 UI 下拉共用这一条调用，peer 契约
   * 只有一处。网关缺席或调用失败原样抛出——meta 侧降级为空表并留一条告警。
   */
  async listAgentPresets(): Promise<readonly { id: string; broken?: string }[]> {
    const response = await this.invoke(this.session(), 'agentPresets', 'list', {}) as { presets?: readonly { id: string; broken?: string }[] }
    return response.presets ?? []
  }

  /**
   * 钉住工作区的名册三态探针（`present` 在册 / `absent` 权威否定 / `unknown` 不可知）。
   *
   * 宿主 workspace 域的启动窗口内 `list()` 会抛错（`rebuildEntities()` 在域异步
   * init 末尾才跑：窗口内 entities 为空而 durable order 已加载，按 order 逐条取
   * 实体即抛 `workspace registry order references missing workspace '<id>'`）。
   * 那是**名册不可知**，不是名册权威否定——把前者当否定会让宿主停机后的补跑
   * 必然失败（2026-10-14 实测窗口上界 33s）。
   *
   * 不可知判据取「抛错」本身而不是错误码：窗口内那条错误不带 `service-unavailable`
   * 码（`isServiceUnavailable` 保留给网关侧目标服务未激活的口径），拿它当判据会
   * 漏掉全部启动窗口。重试节奏复用 runner 既有的 5 × 2s；内联重试只是次要手段
   * ——窗口可能比它长，主保障是服务层在会话落定前不消费触发点、由后续 tick 重试。
   * 老宿主面（resolver 缺席）同样走完重试：服务可能随插件加载晚出现，重试是唯一
   * 能观察到它的方式；用尽后由调用方放行起跑，交给网关/宿主兜底。
   */
  async probeWorkspace(workspaceId: string): Promise<WorkspaceRosterState> {
    for (let attempt = 1; ; attempt += 1) {
      const registry = this.workspaces()
      if (registry !== undefined) {
        try {
          return registry.list().some(item => item.id === workspaceId) ? 'present' : 'absent'
        } catch {
          // 名册此刻不可知：继续退避重试。
        }
      }
      if (attempt >= SERVICE_UNAVAILABLE_ATTEMPTS) return 'unknown'
      await delay(SERVICE_UNAVAILABLE_BACKOFF_MS)
    }
  }

  /**
   * 名册此刻是否不可知（单次观察，不重试）：起跑失败后的可补偿分类用。
   * 失败之后立刻看一眼，仍不可知即判这次失败落在宿主启动窗口里——服务层据此
   * 让触发点留给后续 tick 重试，而不是把它当一次失败消费掉。
   */
  workspaceRosterUnavailable(): boolean {
    const registry = this.workspaces()
    if (registry === undefined) return true
    try {
      registry.list()
      return false
    } catch {
      return true
    }
  }

  /**
   * 启动一次执行：校验钉住三元组，按执行 id 派生会话/请求身份建会话，重命名，
   * 应用权限，queue 发 prompt。返回会话 id。身份派生使重复调用幂等。
   */
  async launch(task: RunnerTask, executionId: string): Promise<string> {
    const gateway = this.session()
    const workspaceId = task.workspaceId
    if (workspaceId !== undefined) {
      const roster = await this.probeWorkspace(workspaceId)
      // 权威否定 → fail-closed（文案与语义不变）；不可知 → 放行交给网关/宿主兜底。
      if (roster === 'absent') throw new Error('workspace not found: ' + workspaceId)
      if (roster === 'unknown') {
        console.warn('[trading-tasks] workspace roster is unavailable; launching without roster validation:', workspaceId)
      }
    }
    if (task.agentPreset !== undefined) {
      const presets = await this.listAgentPresets()
      const preset = presets.find(item => item.id === task.agentPreset)
      if (preset === undefined) throw new Error('agent preset not found: ' + task.agentPreset)
      if (preset.broken !== undefined) throw new Error('agent preset is unavailable: ' + preset.broken)
    }
    const requestedSessionId = sessionIdForExecution(executionId)
    const created = await this.invoke(gateway, 'session', 'create', {
      sessionId: requestedSessionId,
      ...(workspaceId === undefined ? {} : { workspaceId }),
      ...(task.agentPreset === undefined ? {} : { agentPreset: task.agentPreset }),
    }) as { sessionId: string }
    const sessionId = typeof created.sessionId === 'string' && created.sessionId !== '' ? created.sessionId : requestedSessionId
    try {
      await this.invoke(gateway, 'session', 'rename', { sessionId, title: task.title })
      if (task.permission !== undefined) {
        const commands = this.commands()
        if (commands === undefined) throw new Error('permission command dispatcher (commands) is unavailable')
        // 首参必须是 Agent（0.1.5-rc.1）：session.create 已 ensureSession 挂载 preset，
        // 因此此处 agents.get(sessionId) 应命中；缺席即 fail-closed，不退回旧调用形状。
        const agent = this.agents()?.get(sessionId)
        if (agent === undefined) throw new Error('session agent is unavailable for the permission command')
        const execution = await commands.execute(agent, '/permission ' + task.permission, [], AbortSignal.timeout(30_000))
        if (execution === undefined) throw new Error('permission command was not acknowledged')
        // 兼容新形状 { commandId, result: { kind, text } } 与旧形状 { kind, text }。
        const outcome = (execution as { result?: { kind?: string; text?: string } }).result
          ?? (execution as { kind?: string; text?: string })
        if (outcome.kind !== 'success') throw new Error(outcome.text ?? 'permission command failed')
      }
      await this.invoke(gateway, 'session', 'prompt', {
        sessionId,
        requestId: promptRequestIdForExecution(executionId),
        mode: 'queue' as const,
        content: [{ type: 'text' as const, text: executionPrompt(task) }],
      })
    } catch (error) {
      throw new SessionLaunchError(sessionId, error)
    }
    return sessionId
  }


  /**
   * 侦查一次执行的结局。会话消失判 cancelled；仍在运行判 pending；会话静默后
   * 从 follow 快照向前翻有界历史页（100 页封顶，到执行 startedAt 边界停），找
   * startedAt 之后最早的一条 turn/end 并按 SDK reason 分类。
   *
   * pending 分两种：正常等待（无诊断）；读取异常或「会话空闲且完整历史没有
   * turn/end」（带 diagnostic，后者另置 historyExhausted 供服务层按窗口收敛）。
   */
  async inspect(sessionId: string, startedAt: number): Promise<ExecutionInspection> {
    const gateway = this.session()
    let items: readonly { sessionId?: string; running?: boolean }[]
    for (let attempt = 1; ; attempt++) {
      try {
        const response = await this.invoke(gateway, 'session', 'list', {}) as { items?: readonly { sessionId?: string; running?: boolean }[] }
        items = response.items ?? []
        break
      } catch (error) {
        if (!isServiceUnavailable(error) || attempt >= SERVICE_UNAVAILABLE_ATTEMPTS) {
          // 名册不可知（含不支持 session/list 的老宿主）判 pending，下轮再试；
          // 但必须把原因带出去，长期 pending 不允许静默。
          return { outcome: 'pending', diagnostic: 'session list unavailable: ' + errorMessage(error) }
        }
        await delay(SERVICE_UNAVAILABLE_BACKOFF_MS)
      }
    }
    const summary = items.find(item => item.sessionId === sessionId)
    if (summary === undefined) {
      this.scanMemos.delete(sessionId)
      return { outcome: 'cancelled', error: 'execution session no longer exists' }
    }
    if (summary.running === true) return { outcome: 'pending' }

    if (gateway.stream === undefined) {
      return { outcome: 'pending', diagnostic: 'session follow stream is unavailable on this host' }
    }
    let opening: { cursor: number; records: Array<{ type?: string; seq?: number; time?: number; data?: unknown }>; hasMore: boolean }
    const streamPeer = this.peer()
    try {
      const stream = await gateway.stream({
        namespace: 'session',
        method: 'follow',
        args: { request: { address: sessionAddress(sessionId), maxMessages: 1 } },
        ...(streamPeer === undefined ? {} : { peer: streamPeer }),
      })
      const iterator = stream[Symbol.asyncIterator]()
      const next = await iterator.next()
      if (typeof iterator.return === 'function') await iterator.return()
      const follow = next.done === true ? undefined : next.value as { type?: string; cursor?: number; records?: readonly { event?: { type?: string; seq?: number; time?: number; data?: unknown } }[]; hasMore?: boolean }
      if (follow === undefined || follow.type !== 'snapshot' || typeof follow.cursor !== 'number' || !Array.isArray(follow.records) || typeof follow.hasMore !== 'boolean') {
        return { outcome: 'pending', diagnostic: 'session follow returned an unexpected frame' }
      }
      opening = { cursor: follow.cursor, records: follow.records.map(record => record.event ?? {}), hasMore: follow.hasMore }
    } catch (error) {
      return { outcome: 'pending', diagnostic: 'session follow failed: ' + errorMessage(error) }
    }

    /** 在一批事件里找 startedAt 之后最早的一条 turn/end。 */
    const findEnd = (events: typeof opening.records): { seq: number; data: unknown } | undefined => {
      let found: { seq: number; data: unknown } | undefined
      for (const event of events) {
        if (event.type !== 'turn/end') continue
        if (startedAt > 0 && (event.time ?? 0) < startedAt) continue
        const seq = event.seq ?? 0
        if (found === undefined || seq < found.seq) found = { seq, data: event.data }
      }
      return found
    }

    // 快照内（最新事件）先扫：会话静默后终局事件通常就是最新一条。
    const openingEnd = findEnd(opening.records)
    if (openingEnd !== undefined) {
      this.scanMemos.delete(sessionId)
      return classifyTurnEnd(openingEnd.data)
    }
    const memo = this.scanMemos.get(sessionId)
    if (memo !== undefined && memo.cursor === opening.cursor) {
      return memo.historyExhausted
        ? { outcome: 'pending', historyExhausted: true, diagnostic: 'session is idle and its complete history records no turn/end' }
        : { outcome: 'pending' }
    }

    // 翻历史页找执行开始之后的第一条 turn/end（follow 快照的 cursor 是最新
    // 事件序号；page 向更早方向走，到 startedAt 边界或翻完为止）。
    let beforeSeq: number | undefined
    let reachedBoundary = !opening.hasMore
    let foundEnd: { seq: number; data: unknown } | undefined
    for (let page = 0; page < 100 && !reachedBoundary; page += 1) {
      let history: { records?: readonly { event?: { type?: string; seq?: number; time?: number; data?: unknown } }[]; hasMore?: boolean }
      try {
        history = await this.invoke(gateway, 'session', 'page', {
          address: sessionAddress(sessionId),
          throughSeq: opening.cursor,
          maxMessages: 100,
          ...(beforeSeq === undefined ? {} : { beforeSeq }),
        }) as typeof history
      } catch (error) {
        return { outcome: 'pending', diagnostic: 'session history page failed: ' + errorMessage(error) }
      }
      const entries = history.records ?? []
      foundEnd = findEnd(entries.map(record => record.event ?? {}))
      if (foundEnd !== undefined) break
      const times = entries.map(entry => entry.event?.time ?? 0)
      const oldestTime = times.length === 0 ? undefined : Math.min(...times)
      if (history.hasMore !== true || (oldestTime !== undefined && oldestTime <= startedAt)) {
        reachedBoundary = true
        break
      }
      const oldestSeq = entries.reduce<number | undefined>((oldest, entry) => {
        const seq = entry.event?.seq
        if (seq === undefined) return oldest
        return oldest === undefined ? seq : Math.min(oldest, seq)
      }, undefined)
      if (oldestSeq === undefined || oldestSeq === beforeSeq) return { outcome: 'pending' }
      beforeSeq = oldestSeq
    }
    if (foundEnd === undefined) {
      this.scanMemos.set(sessionId, { cursor: opening.cursor, historyExhausted: reachedBoundary })
      // 只有翻到边界（读完执行开始以来的全部历史）仍没有终局事件，才算
      // 「完整历史扫描确认无 turn/end」——服务层只对这种情况按窗口收敛。
      return reachedBoundary
        ? { outcome: 'pending', historyExhausted: true, diagnostic: 'session is idle and its complete history records no turn/end' }
        : { outcome: 'pending' }
    }
    this.scanMemos.delete(sessionId)
    return classifyTurnEnd(foundEnd.data)
  }

  /**
   * 清掉不在未结算名册里的扫描备忘：任务在执行途中被删除（或经非侦查路径
   * 结算）后，inspect 不会再被调用，备忘键会永久残留——每轮 poll 对账一次。
   */
  pruneScanMemos(activeSessionIds: ReadonlySet<string>): void {
    for (const sessionId of [...this.scanMemos.keys()]) {
      if (!activeSessionIds.has(sessionId)) this.scanMemos.delete(sessionId)
    }
  }

}
