/**
 * 调度编排单测（假网关 + 假时钟）：cron 到期起跑、错过触发点不补跑、权限门
 * 跳过、手动 run、轮询结算与重启对账。vi.useFakeTimers 驱动真实 interval 节奏。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TradingTasksService } from '../src/tasks/service.ts'

interface FakeSession {
  running: boolean
  events: Array<{ type: string; seq: number; time: number; data?: unknown }>
}

/** 假 typertGateway：会话树内存实现 + 调用流水。prompt 即落地 turn/end 并静默。 */
function makeGateway() {
  const calls: Array<{ namespace: string; method: string }> = []
  const sessions = new Map<string, FakeSession>()
  let sequence = 0
  const gateway = {
    async invoke(request: { namespace: string; method: string; args: Record<string, unknown> }): Promise<unknown> {
      calls.push({ namespace: request.namespace, method: request.method })
      const request0 = (request.args.request ?? request.args._request ?? {}) as Record<string, unknown>
      if (request.method === 'create') {
        sequence += 1
        const id = 'session-' + String(sequence)
        sessions.set(id, { running: true, events: [] })
        return { sessionId: id }
      }
      if (request.method === 'rename' || request.method === 'prompt') {
        const sessionId = request0.sessionId as string
        if (request.method === 'prompt') {
          const session = sessions.get(sessionId)
          if (session !== undefined) {
            session.events.push({ type: 'turn/end', seq: session.events.length + 1, time: Date.now(), data: { reason: { kind: 'ok' } } })
            session.running = false
          }
        }
        return {}
      }
      if (request.method === 'list') {
        return { items: [...sessions.entries()].map(([sessionId, session]) => ({ sessionId, running: session.running })) }
      }
      if (request.method === 'page') {
        const sessionId = (request0.address as { sessionId: string }).sessionId
        return { records: (sessions.get(sessionId)?.events ?? []).map(event => ({ event })), hasMore: false }
      }
      return {}
    },
    async *stream(request: { namespace: string; method: string; args: Record<string, unknown> }): AsyncIterable<unknown> {
      const request0 = (request.args.request ?? {}) as { address?: { sessionId?: string } }
      const session = sessions.get(request0.address?.sessionId ?? '')
      const events = session?.events ?? []
      yield { type: 'snapshot', cursor: events.length, records: events.slice(-1).map(event => ({ event })), hasMore: false }
    },
  }
  return { calls, sessions, gateway }
}

describe('TradingTasksService', () => {
  let dir: string

  beforeEach(() => {
    vi.useFakeTimers()
    dir = mkdtempSync(join(tmpdir(), 'dshtrading-tasks-svc-'))
    vi.setSystemTime(new Date(2026, 0, 1, 9, 0, 30).getTime())
  })

  afterEach(() => {
    vi.useRealTimers()
    rmSync(dir, { recursive: true, force: true })
  })

  function makeService(gateway: ReturnType<typeof makeGateway>['gateway'], options: { tickMs?: number } = {}): TradingTasksService {
    const service = new TradingTasksService({
      ledgerPath: join(dir, 'ledger-v1.json'),
      gateway: () => gateway,
      tickMs: options.tickMs ?? 1_000,
      pollMs: 500,
    })
    return service
  }

  function createTask(service: TradingTasksService, cron: string, extra: Record<string, unknown> = {}): string {
    const key = cron.replace(/\s+/g, '-') + '-' + String(Object.keys(extra).sort().join('='))
    const snapshot = service.apply({
      requestId: 'create-' + key,
      action: { kind: 'create', id: 'task-' + key, input: { title: '盘前分析', prompt: '生成日报', schedule: { enabled: true, cron }, ...extra } },
    } as never)
    return snapshot.tasks[0].id
  }

  it('cron 到期起跑：建会话 + queue 发 prompt，轮询结算 succeeded，下次运行推进', async () => {
    const fake = makeGateway()
    const service = makeService(fake.gateway)
    service.start()
    try {
      const taskId = createTask(service, '* * * * *')
      // 下一分钟 09:01:00 到期（tick 1s 节奏内命中）。
      await vi.advanceTimersByTimeAsync(65_000)
      const task = service.snapshot().tasks.find(item => item.id === taskId)
      expect(task?.executions.length).toBe(1)
      expect(task?.executions[0]?.sessionId).toBeDefined()
      expect(task?.schedule?.lastTriggeredAt).toBe(new Date(2026, 0, 1, 9, 1, 0).getTime())
      expect(fake.calls.some(call => call.method === 'prompt')).toBe(true)
      // 轮询结算（假会话 prompt 即静默 + turn/end）。
      await vi.advanceTimersByTimeAsync(2_000)
      const settled = service.snapshot().tasks.find(item => item.id === taskId)
      expect(settled?.executions[0]?.result).toBe('succeeded')
      expect(settled?.schedule?.nextRunAt).toBe(new Date(2026, 0, 1, 9, 2, 0).getTime())
    } finally {
      service.dispose()
    }
  })

  it('宿主宕机跨过多个触发点只跑一次：错过不补跑', async () => {
    const fake = makeGateway()
    // tick 设为一小时（测试窗口内永不触发）：模拟宿主停表（create 后跨过 09:01/09:02/09:03）。
    const service = makeService(fake.gateway, { tickMs: 3_600_000 })
    service.start()
    try {
      const taskId = createTask(service, '* * * * *', { manual: 1 })
      vi.setSystemTime(new Date(2026, 0, 1, 9, 3, 50).getTime())
      // 宿主醒来后的第一次 tick：单次起跑 + 从当前时刻取下一个匹配。
      await (service as unknown as { tick(): Promise<void> }).tick()
      await vi.advanceTimersByTimeAsync(2_000)
      const task = service.snapshot().tasks.find(item => item.id === taskId)
      expect(task?.executions.length).toBe(1)
      expect(task?.executions[0]?.sessionId).toBeDefined()
      expect(task?.schedule?.nextRunAt).toBe(new Date(2026, 0, 1, 9, 4, 0).getTime())
    } finally {
      service.dispose()
    }
  })

  it('权限待确认的任务被 cron 跳过（触发点推进但不起跑）', async () => {
    const fake = makeGateway()
    const service = makeService(fake.gateway)
    service.start()
    try {
      const taskId = createTask(service, '* * * * *', { permission: 'danger-full-access', manual: 2 })
      await vi.advanceTimersByTimeAsync(65_000)
      const task = service.snapshot().tasks.find(item => item.id === taskId)
      expect(task?.executions.length).toBe(0)
      expect(task?.schedule?.nextRunAt).toBe(new Date(2026, 0, 1, 9, 2, 0).getTime())
      expect(fake.sessions.size).toBe(0)
    } finally {
      service.dispose()
    }
  })

  it('手动 run 立即起跑；结算后可再次 run', async () => {
    const fake = makeGateway()
    const service = makeService(fake.gateway)
    service.start()
    try {
      const taskId = createTask(service, '0 9 * * *', { manual: 3 })
      service.apply({ requestId: 'run-1', action: { kind: 'run', taskId } } as never)
      await vi.advanceTimersByTimeAsync(1_500)
      let task = service.snapshot().tasks.find(item => item.id === taskId)
      expect(task?.executions[0]?.result).toBe('succeeded')
      expect(task?.executions[0]?.trigger).toBe('manual')
      service.apply({ requestId: 'run-2', action: { kind: 'run', taskId } } as never)
      await vi.advanceTimersByTimeAsync(1_500)
      task = service.snapshot().tasks.find(item => item.id === taskId)
      expect(task?.executions.length).toBe(2)
    } finally {
      service.dispose()
    }
  })

  it('meta 工作区名：宿主 Workspace 显示名在 title，name 兜底优先', async () => {
    const fake = makeGateway()
    const service = new TradingTasksService({
      ledgerPath: join(dir, 'ledger-v1.json'),
      gateway: () => fake.gateway,
      // 宿主 WorkspaceRegistry.list() 投影：实体字段是 title（必填），无 name
      workspaces: () => ({ list: () => [
        { id: 'ws-1', title: 'dsh-trading' },
        { id: 'ws-2', title: '备用', name: '别名面优先' },
        { id: 'ws-3' },
      ] }),
      tickMs: 1_000,
      pollMs: 500,
    })
    try {
      const meta = await service.meta()
      expect(meta.workspaces).toEqual([
        { id: 'ws-1', name: 'dsh-trading' },
        { id: 'ws-2', name: '别名面优先' },
        { id: 'ws-3' },
      ])
    } finally {
      service.dispose()
    }
  })
})
