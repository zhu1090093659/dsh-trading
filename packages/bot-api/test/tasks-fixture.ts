/**
 * 定时任务测试 fixture：可契约核对的 typert 网关假实现（不是通用 mock）。
 *
 * 形状按已安装的 0.2.1-rc.2 宿主 SDK 核过（只读查 schema，不猜 API）：
 * - `session/create` 的显式 `sessionId` 走 `ensureSession` 采纳语义
 *   （dsh-api-session-controller `create` → `ensureSession(id, cwd, true, preset)`：
 *   同 id 复用已有/持久化会话，preset 不一致报 `session/preset-conflict`）；
 * - `session/prompt` 以 `requestId` 去重（`hasPromptRequest(agent, requestId)`
 *   命中即返回 `{accepted:true}`），使「重复启动不重复发 prompt」可核对；
 * - `session/list` 返回 `SessionSummary` 必填字段（sessionId/running/
 *   agentAvailable/blank/updatedAt）；
 * - `session/follow` 产出 `{type:'snapshot', cursor, records:[{event}], hasMore}` 帧；
 * - `session/page` 按 `beforeSeq` 向更早方向翻页，`hasMore` 表示还有更早事件。
 *
 * fixture 自身的契约由 tasks-hardening.test.ts 的「fixture 契约核对」用例断言；
 * 它不追逐宿主实现细节，只钉住本插件依赖的那几条线语义。
 */
import type { SessionCommandDispatcher, SessionGateway, WorkspaceRegistryLike, AgentRegistryLike } from '../src/tasks/runner.ts'

export interface FixtureEvent {
  type: string
  seq: number
  time: number
  data?: unknown
}

export interface FixtureSession {
  sessionId: string
  agentPreset: string | undefined
  running: boolean
  agentAvailable: boolean
  events: FixtureEvent[]
  /** 已受理（去重后）的 prompt requestId。 */
  acceptedPromptIds: string[]
  /** 已受理的 prompt 文本。 */
  promptTexts: string[]
  renameTitles: string[]
}

/** turn/end 的 reason 取值（dsh-session TurnEndReasonMap 的当前成员）。 */
export type FixtureTurnEndReason =
  | { kind: 'completed' }
  | { kind: 'aborted'; reason?: { kind: string; reason?: string } }
  | { kind: 'blocked' }
  | { kind: 'error'; error: { message: string; code: string } }
  | { kind: 'max-tokens' }
  | { kind: 'interrupted' }

export interface TasksGatewayFixture {
  gateway: SessionGateway
  sessions: Map<string, FixtureSession>
  calls: Array<{ namespace: string; method: string }>
  /** 经网关真实创建过的会话 id（按采纳语义去重）。 */
  createdSessionIds: string[]
  /** 经网关真实受理过的 prompt requestId。 */
  promptRequestIds: string[]
  emit(sessionId: string, type: string, data?: unknown): FixtureEvent
  finishTurn(sessionId: string, reason: FixtureTurnEndReason): FixtureEvent
  seedSession(sessionId: string, options?: { agentPreset?: string; running?: boolean }): FixtureSession
  setRunning(sessionId: string, running: boolean): void
  setListError(error: Error | undefined): void
  setFollowError(sessionId: string, error: Error): void
  /**
   * 让 `session/create` 在会话落定前失败（每次调用重读 provider，便于模拟
   * 「宿主启动窗口开着 → 建会话被拒 / 窗口关闭 → 恢复」这一时序）。
   */
  setCreateError(provider: () => Error | undefined): void
}

function errorWithCode(message: string, code: string): Error {
  return Object.assign(new Error(message), { code })
}

/** 建一个契约可核对的网关 fixture。 */
export function createTasksGateway(options: { now?: () => number } = {}): TasksGatewayFixture {
  const now = options.now ?? ((): number => Date.now())
  const sessions = new Map<string, FixtureSession>()
  const calls: Array<{ namespace: string; method: string }> = []
  const createdSessionIds: string[] = []
  const promptRequestIds: string[] = []
  const followErrors = new Map<string, Error>()
  let listError: Error | undefined
  let createError: (() => Error | undefined) | undefined
  let autoSequence = 0

  const sessionOf = (sessionId: string): FixtureSession | undefined => sessions.get(sessionId)

  const seedSession = (sessionId: string, seed: { agentPreset?: string; running?: boolean } = {}): FixtureSession => {
    const session: FixtureSession = {
      sessionId,
      agentPreset: seed.agentPreset,
      running: seed.running ?? false,
      agentAvailable: true,
      events: [],
      acceptedPromptIds: [],
      promptTexts: [],
      renameTitles: [],
    }
    sessions.set(sessionId, session)
    return session
  }

  const emit = (sessionId: string, type: string, data?: unknown): FixtureEvent => {
    const session = sessionOf(sessionId) ?? seedSession(sessionId)
    const event: FixtureEvent = { type, seq: session.events.length + 1, time: now(), ...(data === undefined ? {} : { data }) }
    session.events.push(event)
    return event
  }

  const finishTurn = (sessionId: string, reason: FixtureTurnEndReason): FixtureEvent => {
    const session = sessionOf(sessionId) ?? seedSession(sessionId)
    session.running = false
    return emit(sessionId, 'turn/end', { turn: 1, reason })
  }

  const requestOf = (args: Record<string, unknown>): Record<string, unknown> =>
    (args.request ?? args._request ?? {}) as Record<string, unknown>

  const sessionIdOf = (value: unknown): string => {
    const address = (value as { address?: { sessionId?: string } } | undefined)?.address
    return address?.sessionId ?? ''
  }

  const gateway: SessionGateway = {
    async invoke(request) {
      calls.push({ namespace: request.namespace, method: request.method })
      const payload = requestOf(request.args)
      if (request.namespace === 'agentPresets') return { presets: [{ id: 'master' }, { id: 'preset-a' }] }
      if (request.namespace !== 'session') return {}
      if (request.method === 'create') {
        // 宿主 workspace 域启动窗口内 session/create 会因名册取不到实体而失败
        // （没有会话被建出来）；provider 每次重读，便于模拟窗口开/关的时序。
        const failure = createError?.()
        if (failure !== undefined) throw failure
        const requestedId = typeof payload.sessionId === 'string' && payload.sessionId !== ''
          ? payload.sessionId
          : 'session-fixture-' + String((autoSequence += 1))
        const requestedPreset = typeof payload.agentPreset === 'string' ? payload.agentPreset : undefined
        const existing = sessionOf(requestedId)
        if (existing !== undefined) {
          if (requestedPreset !== undefined && existing.agentPreset !== undefined && existing.agentPreset !== requestedPreset) {
            throw errorWithCode(`session "${requestedId}" runs agent preset "${existing.agentPreset}", not "${requestedPreset}"`, 'session/preset-conflict')
          }
          return { sessionId: requestedId, ...(existing.agentPreset === undefined ? {} : { agentPreset: existing.agentPreset }) }
        }
        seedSession(requestedId, { agentPreset: requestedPreset })
        createdSessionIds.push(requestedId)
        return { sessionId: requestedId, ...(requestedPreset === undefined ? {} : { agentPreset: requestedPreset }) }
      }
      if (request.method === 'rename') {
        const session = sessionOf(String(payload.sessionId))
        if (session !== undefined) session.renameTitles.push(String(payload.title))
        return { title: String(payload.title), seq: session?.events.at(-1)?.seq ?? 0 }
      }
      if (request.method === 'prompt') {
        const session = sessionOf(String(payload.sessionId))
        if (session === undefined) throw errorWithCode('session not found', 'session/not-found')
        const requestId = String(payload.requestId)
        if (!session.acceptedPromptIds.includes(requestId)) {
          session.acceptedPromptIds.push(requestId)
          promptRequestIds.push(requestId)
          const content = Array.isArray(payload.content) ? payload.content : []
          const text = content.map(part => String((part as { text?: unknown }).text ?? '')).join('')
          session.promptTexts.push(text)
          session.running = true
        }
        return { accepted: true }
      }
      if (request.method === 'list') {
        if (listError !== undefined) throw listError
        return {
          items: [...sessions.values()].map(session => ({
            sessionId: session.sessionId,
            running: session.running,
            agentAvailable: session.agentAvailable,
            blank: session.events.length === 0,
            updatedAt: session.events.at(-1)?.time ?? 0,
          })),
        }
      }
      if (request.method === 'page') {
        const session = sessionOf(sessionIdOf(payload))
        const throughSeq = typeof payload.throughSeq === 'number' ? payload.throughSeq : Number.MAX_SAFE_INTEGER
        const beforeSeq = typeof payload.beforeSeq === 'number' ? payload.beforeSeq : undefined
        const maxMessages = typeof payload.maxMessages === 'number' ? payload.maxMessages : 100
        const all = (session?.events ?? []).filter(event => event.seq <= throughSeq && (beforeSeq === undefined || event.seq < beforeSeq))
        const window = all.slice(-maxMessages)
        return { records: window.map(event => ({ event })), hasMore: all.length > window.length }
      }
      return {}
    },
    async *stream(request): AsyncIterable<unknown> {
      const payload = requestOf(request.args)
      const sessionId = sessionIdOf(payload)
      const failure = followErrors.get(sessionId)
      if (failure !== undefined) throw failure
      const session = sessionOf(sessionId)
      const events = session?.events ?? []
      const maxMessages = typeof payload.maxMessages === 'number' ? payload.maxMessages : 100
      const records = events.slice(-maxMessages)
      yield {
        type: 'snapshot',
        cursor: events.at(-1)?.seq ?? 0,
        records: records.map(event => ({ event })),
        hasMore: events.length > records.length,
      }
    },
  }

  return {
    gateway,
    sessions,
    calls,
    createdSessionIds,
    promptRequestIds,
    emit,
    finishTurn,
    seedSession,
    setRunning: (sessionId, running) => {
      const session = sessionOf(sessionId) ?? seedSession(sessionId)
      session.running = running
    },
    setListError: error => { listError = error },
    setFollowError: (sessionId, error) => { followErrors.set(sessionId, error) },
    setCreateError: provider => { createError = provider },
  }
}

/** /permission 命令派发 fixture：记录下发行，返回新契约结果形状。 */
export function createTasksCommandsFixture(): { commands: SessionCommandDispatcher; lines: string[] } {
  const lines: string[] = []
  return {
    lines,
    commands: {
      async execute(_agent: unknown, line: string, _submittedAttachments: readonly unknown[], signal: AbortSignal): Promise<unknown> {
        if (signal === undefined || signal.aborted) throw new Error('permission command requires a live signal')
        lines.push(line)
        return { commandId: 'cmd-fixture', result: { kind: 'success', text: 'ok' } }
      },
    },
  }
}

/** 宿主 agents 服务 fixture：任何会话都返回一个带 session.id 的活跃 Agent。 */
export function createTasksAgentsFixture(): AgentRegistryLike {
  return { get: (sessionId: string) => ({ session: { id: sessionId } }) }
}

/** 工作区名册 fixture。 */
export function createTasksWorkspacesFixture(): WorkspaceRegistryLike {
  return { list: () => [{ id: 'ws-main' }] }
}
