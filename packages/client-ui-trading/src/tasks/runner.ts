/**
 * 右侧栏定时任务——执行 runner：经宿主 typertGateway 创建真实 dsh 会话并发
 * 送任务 prompt（queue 模式），随后从会话列表 + 有界历史页侦查执行结果。
 *
 * 网关词汇与线参数表移植自 dsh-web dsh-task-board 的 host-runner（0.1.2-alpha.2
 * 描述符表实证：agentPresets/list 无参必须传空对象，session/list 用 _request 键，
 * 其他 session 方法用 request 键；多传/少传都会被网关 assertExactArguments 拒
 * 绝）。本包不依赖宿主 SDK 类型——网关/命令/工作区全部用最小结构面，运行时
 * 鸭子解析（与 node 半既有 webServer/connection 面同策略）。
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

/** typertGateway 的最小结构面。 */
export interface SessionGateway {
  invoke(request: { namespace: string; method: string; args: Record<string, unknown>; signal?: AbortSignal }): Promise<unknown>
  stream?(request: { namespace: string; method: string; args: Record<string, unknown>; signal?: AbortSignal }): Promise<AsyncIterable<unknown>>
}

/** /permission 命令派发面（宿主 commands 服务）。 */
export interface SessionCommandDispatcher {
  execute(sessionId: string, line: string, signal: AbortSignal): Promise<{ kind: string; text?: string } | undefined>
}

/** 工作区名册面（宿主 workspaceRegistry 服务）。 */
export interface WorkspaceRegistryLike {
  list(): readonly { id: string }[]
}

/** 启动后的失败：仍携带会话 id，账本据此把执行挂到该会话上观察收尾。 */
export class SessionLaunchError extends Error {
  constructor(readonly sessionId: string, cause: unknown) {
    super('execution session ' + sessionId + ' failed during launch: ' + (cause instanceof Error ? cause.message : String(cause)), { cause })
    this.name = 'SessionLaunchError'
  }
}

export type ExecutionInspection =
  | { outcome: 'pending' }
  | { outcome: 'succeeded' }
  | { outcome: 'failed'; error: string }
  | { outcome: 'cancelled'; error: string }

/** 网关目标服务未激活完的错误码（启动时序竞态要重试而不是判死）。 */
function isServiceUnavailable(error: unknown): boolean {
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

function isErrorTurnEnd(data: unknown): boolean {
  if (typeof data !== 'object' || data === null) return false
  const reason = (data as { reason?: unknown }).reason
  return typeof reason === 'object' && reason !== null && (reason as { kind?: unknown }).kind === 'error'
}

export class TasksRunner {
  /** 每会话最新已扫事件序号（无终局匹配时避免重复翻历史页）。 */
  private readonly scanMemos = new Map<string, number>()

  constructor(
    private readonly gateway: () => SessionGateway | undefined,
    private readonly commands: () => SessionCommandDispatcher | undefined = () => undefined,
    private readonly workspaces: () => WorkspaceRegistryLike | undefined = () => undefined,
  ) {}

  private session(): SessionGateway {
    const gateway = this.gateway()
    if (gateway === undefined) {
      throw new Error('session gateway (typertGateway) is unavailable on this host')
    }
    return gateway
  }

  private invoke(gateway: SessionGateway, namespace: string, method: string, request: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    return gateway.invoke({ namespace, method, args: invokeWireArgs(namespace, method, request), ...(signal === undefined ? {} : { signal }) })
  }

  /**
   * 启动一次执行：校验钉住三元组，建会话，重命名，应用权限，queue 发
   * prompt。返回会话 id。
   */
  async launch(task: RunnerTask): Promise<string> {
    const gateway = this.session()
    const workspaceId = task.workspaceId
    if (workspaceId !== undefined) {
      const registry = this.workspaces()
      // 名册服务缺席（老宿主）跳过校验（建会话时由网关兜底）；在册但找不到则 fail-closed。
      if (registry !== undefined && !registry.list().some(item => item.id === workspaceId)) {
        throw new Error('workspace not found: ' + workspaceId)
      }
    }
    if (task.agentPreset !== undefined) {
      const presets = await this.invoke(gateway, 'agentPresets', 'list', {}) as { presets?: readonly { id: string; broken?: string }[] }
      const preset = presets.presets?.find(item => item.id === task.agentPreset)
      if (preset === undefined) throw new Error('agent preset not found: ' + task.agentPreset)
      if (preset.broken !== undefined) throw new Error('agent preset is unavailable: ' + preset.broken)
    }
    const created = await this.invoke(gateway, 'session', 'create', {
      ...(workspaceId === undefined ? {} : { workspaceId }),
      ...(task.agentPreset === undefined ? {} : { agentPreset: task.agentPreset }),
    }) as { sessionId: string }
    const sessionId = created.sessionId
    try {
      await this.invoke(gateway, 'session', 'rename', { sessionId, title: task.title })
      if (task.permission !== undefined) {
        const commands = this.commands()
        if (commands === undefined) throw new Error('permission command dispatcher (commands) is unavailable')
        const command = await commands.execute(sessionId, '/permission ' + task.permission, AbortSignal.timeout(30_000))
        if (command === undefined) throw new Error('permission command was not acknowledged')
        if (command.kind !== 'success') throw new Error(command.text ?? 'permission command failed')
      }
      await this.invoke(gateway, 'session', 'prompt', {
        sessionId,
        requestId: 'dshtrading-tasks-' + crypto.randomUUID(),
        mode: 'queue' as const,
        content: [{ type: 'text' as const, text: executionPrompt(task) }],
      })
    } catch (error) {
      throw new SessionLaunchError(sessionId, error)
    }
    return sessionId
  }


  /**
   * 侦查一次执行的结局。会话消失判 cancelled；仍在运行判 pending；会话静默
   * 后从 follow 快照向前翻有界历史页（100 页封顶，到执行 startedAt 边界停），
   * 找 startedAt 之后的第一条 turn/end：error 终局判 failed，否则 succeeded。
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
          // 名册不可知（含不支持 session/list 的老宿主）判 pending，下轮再试。
          return { outcome: 'pending' }
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

    if (gateway.stream === undefined) return { outcome: 'pending' }
    let opening: { cursor: number; records: Array<{ type?: string; seq?: number; time?: number; data?: unknown }>; hasMore: boolean }
    try {
      const stream = await gateway.stream({ namespace: 'session', method: 'follow', args: { request: { address: sessionAddress(sessionId), maxMessages: 1 } } })
      const iterator = stream[Symbol.asyncIterator]()
      const next = await iterator.next()
      if (typeof iterator.return === 'function') await iterator.return()
      const follow = next.done === true ? undefined : next.value as { type?: string; cursor?: number; records?: readonly { event?: { type?: string; seq?: number; time?: number; data?: unknown } }[]; hasMore?: boolean }
      if (follow === undefined || follow.type !== 'snapshot' || typeof follow.cursor !== 'number' || !Array.isArray(follow.records) || typeof follow.hasMore !== 'boolean') {
        return { outcome: 'pending' }
      }
      opening = { cursor: follow.cursor, records: follow.records.map(record => record.event ?? {}), hasMore: follow.hasMore }
    } catch {
      return { outcome: 'pending' }
    }

    /** 在一批事件里找 startedAt 之后最早的一条 turn/end。 */
    const findEnd = (events: typeof opening.records): { seq: number; isError: boolean } | undefined => {
      let found: { seq: number; isError: boolean } | undefined
      for (const event of events) {
        if (event.type !== 'turn/end') continue
        if (startedAt > 0 && (event.time ?? 0) < startedAt) continue
        const seq = event.seq ?? 0
        if (found === undefined || seq < found.seq) found = { seq, isError: isErrorTurnEnd(event.data) }
      }
      return found
    }

    // 快照内（最新事件）先扫：会话静默后终局事件通常就是最新一条。
    const openingEnd = findEnd(opening.records)
    if (openingEnd !== undefined) {
      this.scanMemos.delete(sessionId)
      return openingEnd.isError ? { outcome: 'failed', error: 'agent turn ended with an error' } : { outcome: 'succeeded' }
    }
    if (this.scanMemos.get(sessionId) === opening.cursor) return { outcome: 'pending' }

    // 翻历史页找执行开始之后的第一条 turn/end（follow 快照的 cursor 是最新
    // 事件序号；page 向更早方向走，到 startedAt 边界或翻完为止）。
    let beforeSeq: number | undefined
    let reachedBoundary = !opening.hasMore
    let foundEnd: { seq: number; isError: boolean } | undefined
    for (let page = 0; page < 100 && !reachedBoundary; page += 1) {
      let history: { records?: readonly { event?: { type?: string; seq?: number; time?: number; data?: unknown } }[]; hasMore?: boolean }
      try {
        history = await this.invoke(gateway, 'session', 'page', {
          address: sessionAddress(sessionId),
          throughSeq: opening.cursor,
          maxMessages: 100,
          ...(beforeSeq === undefined ? {} : { beforeSeq }),
        }) as typeof history
      } catch {
        return { outcome: 'pending' }
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
      this.scanMemos.set(sessionId, opening.cursor)
      return { outcome: 'pending' }
    }
    this.scanMemos.delete(sessionId)
    return foundEnd.isError
      ? { outcome: 'failed', error: 'agent turn ended with an error' }
      : { outcome: 'succeeded' }
  }

}
