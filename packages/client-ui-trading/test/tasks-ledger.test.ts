/**
 * 文件账本单测（临时目录）：动作语义、权限确认门、幂等、有界历史、持久化、
 * 目录锁与重启对账。时钟注入固定值，断言不依赖墙钟。
 */
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LedgerLockedError, TasksLedger } from '../src/tasks/ledger.ts'
import { nextRunAtMs } from '../src/tasks/schedule.ts'

const T0 = new Date(2026, 0, 1, 9, 0, 30).getTime()

function makeLedger(name: string): { ledger: TasksLedger; path: string; dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'dshtrading-tasks-'))
  const path = join(dir, name)
  const now = (): number => T0
  return { ledger: new TasksLedger(path, { now }), path, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

function createAction(id: string, extra: Record<string, unknown> = {}): { requestId: string; action: Record<string, unknown> } {
  return {
    requestId: 'req-' + id,
    action: {
      kind: 'create',
      id,
      input: { title: '任务 ' + id, prompt: '跑一遍盘前分析', schedule: { enabled: true, cron: '0 9 * * *' }, ...extra },
    },
  }
}

describe('TasksLedger', () => {
  let env: ReturnType<typeof makeLedger>
  beforeEach(() => { env = makeLedger('ledger-v1.json') })
  afterEach(() => { env.ledger.dispose(); env.cleanup() })

  it('create 武装定时规则并计算下次运行', () => {
    const applied = env.ledger.apply(createAction('t1') as never)
    const task = applied.snapshot.tasks.find(item => item.id === 't1')
    expect(task?.schedule?.enabled).toBe(true)
    expect(task?.schedule?.nextRunAt).toBe(nextRunAtMs('0 9 * * *', T0))
  })

  it('create 拒绝非法 cron（启用状态）', () => {
    expect(() => env.ledger.apply(createAction('t2', { schedule: { enabled: true, cron: 'nope' } }) as never)).toThrowError(/invalid cron/)
  })

  it('高于会话默认权限的任务进入确认门：run 拒绝 → confirm 后放行', () => {
    env.ledger.apply(createAction('t3', { permission: 'workspace-write' }) as never)
    expect(() => env.ledger.apply({ requestId: 'r1', action: { kind: 'run', taskId: 't3' } } as never)).toThrowError(/awaits permission confirmation/)
    env.ledger.apply({ requestId: 'r2', action: { kind: 'confirm-permission', taskId: 't3' } } as never)
    const applied = env.ledger.apply({ requestId: 'r3', action: { kind: 'run', taskId: 't3' } } as never)
    expect(applied.openedRun?.taskId).toBe('t3')
    // 未结算执行在跑：再次 run 拒绝。
    expect(() => env.ledger.apply({ requestId: 'r4', action: { kind: 'run', taskId: 't3' } } as never)).toThrowError(/already has a running execution/)
  })

  it('变更钉住权限重新武装确认门', () => {
    env.ledger.apply(createAction('t4', { permission: 'workspace-write' }) as never)
    env.ledger.apply({ requestId: 'a', action: { kind: 'confirm-permission', taskId: 't4' } } as never)
    env.ledger.apply({ requestId: 'b', action: { kind: 'update', taskId: 't4', patch: { permission: 'danger-full-access' } } } as never)
    const task = env.ledger.snapshot().tasks.find(item => item.id === 't4')
    expect(task?.permissionConfirmedAt).toBeUndefined()
  })

  it('同 requestId 同指纹幂等重放；异指纹拒绝', () => {
    const envelope = createAction('t5') as never
    const first = env.ledger.apply(envelope)
    const replay = env.ledger.apply(envelope)
    expect(replay.snapshot.revision).toBe(first.snapshot.revision)
    expect(() => env.ledger.apply({ requestId: 'req-t5', action: { kind: 'delete', taskId: 't5' } } as never)).toThrowError(/different action/)
  })

  it('set-schedule 停用保留表达式、清空到期；再启用重算', () => {
    env.ledger.apply(createAction('t6') as never)
    env.ledger.apply({ requestId: 's1', action: { kind: 'set-schedule', taskId: 't6', patch: { enabled: false } } } as never)
    const disabled = env.ledger.snapshot().tasks.find(item => item.id === 't6')?.schedule
    expect(disabled?.enabled).toBe(false)
    expect(disabled?.nextRunAt).toBeUndefined()
    expect(disabled?.cron).toBe('0 9 * * *')
    env.ledger.apply({ requestId: 's2', action: { kind: 'set-schedule', taskId: 't6', patch: { enabled: true } } } as never)
    expect(env.ledger.snapshot().tasks.find(item => item.id === 't6')?.schedule?.nextRunAt).toBe(nextRunAtMs('0 9 * * *', T0))
  })

  it('执行历史有界（20 条），未结算执行永不裁剪', async () => {
    env.ledger.apply(createAction('t7', { schedule: undefined }) as never)
    for (let index = 0; index < 25; index++) {
      const opened = env.ledger.openRun('t7', 'manual')
      env.ledger.settleRun('t7', opened.executionId, 'succeeded', undefined)
    }
    const task = env.ledger.snapshot().tasks.find(item => item.id === 't7')
    expect(task?.executions.length).toBe(20)
  })

  it('磁盘持久化：重开账本状态无损；损坏文件隔离而非带病续写', () => {
    env.ledger.apply(createAction('t8') as never)
    const revision = env.ledger.snapshot().revision
    env.ledger.dispose()
    const reopened = new TasksLedger(env.path, { now: () => T0 })
    expect(reopened.snapshot().tasks.some(item => item.id === 't8')).toBe(true)
    expect(reopened.snapshot().revision).toBe(revision)
    reopened.dispose()
    writeFileSync(env.path, '{corrupt', 'utf8')
    const quarantined = new TasksLedger(env.path, { now: () => T0 })
    expect(quarantined.snapshot().tasks.length).toBe(0)
    // 损坏原件被隔离留证（corrupt-* 文件存在），而不是原地覆盖。
    expect(readdirSync(env.dir).some(name => name.startsWith('ledger-v1.json.corrupt-'))).toBe(true)
    quarantined.dispose()
  })

  it('目录锁：活锁拒绝（报持有者 pid），死锁接管', () => {
    const pathA = join(env.dir, 'lock-a.json')
    const first = new TasksLedger(pathA, { now: () => T0 })
    expect(() => new TasksLedger(pathA, { now: () => T0 })).toThrowError(LedgerLockedError)
    first.dispose()
    // 释放后可重开。
    const reopened = new TasksLedger(pathA, { now: () => T0 })
    reopened.dispose()
    // 死进程残留锁 → 接管。
    writeFileSync(join(env.dir, 'lock-b.json.lock'), '999999', 'utf8')
    const second = new TasksLedger(join(env.dir, 'lock-b.json'), { now: () => T0 })
    expect(second.snapshot().tasks.length).toBe(0)
    second.dispose()
  })

  it('重启对账：无会话 id 的执行取消，有会话 id 的保留观察', () => {
    env.ledger.apply(createAction('t9', { schedule: undefined }) as never)
    env.ledger.apply(createAction('t10', { schedule: undefined }) as never)
    const manual = env.ledger.openRun('t9', 'manual')
    const cronRun = env.ledger.openRun('t10', 'cron')
    env.ledger.attachSession('t10', cronRun.executionId, 'session-abc')
    env.ledger.reconcileStartup()
    const open = env.ledger.openExecutions()
    expect(open.length).toBe(1)
    expect(open[0]?.sessionId).toBe('session-abc')
    const t9 = env.ledger.snapshot().tasks.find(item => item.id === 't9')
    expect(t9?.executions[0]?.result).toBe('cancelled')
    void manual
  })
})
