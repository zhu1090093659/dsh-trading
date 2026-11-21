/**
 * 文件账本加固用例（临时目录真实文件，无通用 mock）：PID 台账锁的原子独占与
 * 自身 owner 释放、commit 先落盘再发布、全局在飞容量、跳过触发点的结构化记录
 * 与持久化。时钟注入固定值，断言只看账本可见状态。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LedgerLockedError, TaskActionError, TasksLedger } from '../src/tasks/ledger.ts'
import { nextRunAtMs } from '@dshtrading/api'

const T0 = new Date(2026, 0, 1, 9, 0, 30).getTime()

interface Env {
  dir: string
  path: string
  cleanup: () => void
}

function makeEnv(name = 'ledger-v1.json'): Env {
  const dir = mkdtempSync(join(tmpdir(), 'dshtrading-tasks-hard-'))
  return { dir, path: join(dir, name), cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

function createEnvelope(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { requestId: 'req-' + id, action: { kind: 'create', id, input: { title: '任务 ' + id, prompt: '跑一遍盘前分析', ...extra } } }
}

/** 捕获一次调用抛出的 TaskActionError（无匹配即抛回）。 */
function catchActionError(run: () => void): TaskActionError {
  try {
    run()
  } catch (error) {
    if (error instanceof TaskActionError) return error
    throw error
  }
  throw new Error('expected TaskActionError, but the call succeeded')
}

describe('TasksLedger 加固', () => {
  const envs: Env[] = []
  const ledgers: TasksLedger[] = []

  function open(env: Env, options: { maxInflightExecutions?: number } = {}): TasksLedger {
    const ledger = new TasksLedger(env.path, { now: () => T0, ...options })
    ledgers.push(ledger)
    return ledger
  }

  afterEach(() => {
    for (const ledger of ledgers.splice(0)) ledger.dispose()
    for (const env of envs.splice(0)) env.cleanup()
  })

  it('用户 打开被活进程持有的旧格式 PID 锁时被拒绝且不覆盖锁文件', () => {
    // Given 一个内容是裸 pid 文本的旧格式锁文件，持有者是当前活进程
    const env = makeEnv('lock-old.json')
    envs.push(env)
    writeFileSync(env.path + '.lock', String(process.pid), 'utf8')
    // When 用它构造账本
    let thrown: unknown
    try {
      new TasksLedger(env.path, { now: () => T0 })
    } catch (error) {
      thrown = error
    }
    // Then 拒绝并报出持有者 pid，锁文件内容原样保留（没有先检查后覆盖）
    expect(thrown).toBeInstanceOf(LedgerLockedError)
    expect((thrown as LedgerLockedError).holderPid).toBe(process.pid)
    expect(readFileSync(env.path + '.lock', 'utf8')).toBe(String(process.pid))
  })

  it('用户 释放账本只清理自己持有的锁，被他人接管的锁文件原样保留', () => {
    // Given 一个已取得锁的账本，随后锁文件被外部接管者改写为别的 pid
    const env = makeEnv('lock-owner.json')
    envs.push(env)
    const ledger = open(env)
    writeFileSync(env.path + '.lock', '424242', 'utf8')
    // When 释放账本
    ledger.dispose()
    // Then 不删除不属于自己的锁文件
    expect(existsSync(env.path + '.lock')).toBe(true)
    expect(readFileSync(env.path + '.lock', 'utf8')).toBe('424242')
  })

  it('用户 陈旧死锁被原子接管后第二个宿主被拒绝', () => {
    // Given 一个崩溃残留的锁文件（pid 不存在）
    const env = makeEnv('lock-stale.json')
    envs.push(env)
    writeFileSync(env.path + '.lock', '999999', 'utf8')
    // When 第一个账本接管，第二个账本再打开
    const first = open(env)
    let thrown: unknown
    try {
      new TasksLedger(env.path, { now: () => T0 })
    } catch (error) {
      thrown = error
    }
    // Then 接管后锁首行仍报告当前进程，第二个打开者被拒绝
    expect(readFileSync(env.path + '.lock', 'utf8').split('\n')[0]).toBe(String(process.pid))
    expect(thrown).toBeInstanceOf(LedgerLockedError)
    expect(first.snapshot().tasks).toHaveLength(0)
  })

  it('user releasing a replaced lock preserves the new owner even when its PID is unchanged', () => {
    // Given: another owner replaced the identity marker without changing the process PID.
    const env = makeEnv('same-pid-owner.json')
    envs.push(env)
    const ledger = open(env)
    const replacement = String(process.pid) + '\nreplacement-owner-token'
    writeFileSync(env.path + '.lock', replacement, 'utf8')
    // When: the old owner is disposed.
    ledger.dispose()
    // Then: the new owner's marker remains and cannot be silently cleared by the old owner.
    expect(existsSync(env.path + '.lock')).toBe(true)
    expect(readFileSync(env.path + '.lock', 'utf8')).toBe(replacement)
  })

  it('user opening an identity-unknown lock is rejected without deleting the marker', () => {
    // Given: the marker exists but cannot identify a proven-dead owner.
    const env = makeEnv('unknown-owner.json')
    envs.push(env)
    writeFileSync(env.path + '.lock', '', 'utf8')
    // When: a new ledger attempts to acquire it.
    let thrown: unknown
    try { open(env) } catch (error) { thrown = error }
    // Then: an unknown owner is not treated as dead and the original marker remains.
    expect(thrown).toBeInstanceOf(LedgerLockedError)
    expect(readFileSync(env.path + '.lock', 'utf8')).toBe('')
  })

  it('user submitting after lock ownership is lost cannot publish or persist a task', () => {
    // Given: a ready ledger lost its owner identity to another instance.
    const env = makeEnv('lost-owner-submit.json')
    envs.push(env)
    const ledger = open(env)
    writeFileSync(env.path + '.lock', String(process.pid) + '\nnew-owner-token', 'utf8')
    // When: the former owner tries to create a task.
    let thrown: unknown
    try { ledger.apply(createEnvelope('lost-task') as never) } catch (error) { thrown = error }
    // Then: no task, revision, or durable file is produced by an unowned writer.
    expect(thrown).toBeInstanceOf(TaskActionError)
    expect((thrown as TaskActionError).code).toBe('TASKS_LEDGER_LOCK_LOST')
    expect(ledger.snapshot().tasks).toEqual([])
    expect(ledger.snapshot().revision).toBe(0)
    expect(existsSync(env.path)).toBe(false)
  })

  it('用户 磁盘写入失败时账本内存与幂等去重缓存不被污染', () => {
    // Given 一个就绪的账本，且其临时落盘路径被目录占位（真实 EISDIR 写失败）
    const env = makeEnv('ledger-disk.json')
    envs.push(env)
    const ledger = open(env)
    mkdirSync(env.path + '.tmp')
    const before = ledger.snapshot()
    let notified = 0
    const unsubscribe = ledger.subscribe(() => { notified += 1 })
    const envelope = createEnvelope('t-disk')
    // When 应用一次 create 落盘失败，随后移除占位并用同一 requestId 重试
    let thrown: unknown
    try {
      ledger.apply(envelope as never)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeDefined()
    expect(ledger.snapshot().revision).toBe(before.revision)
    expect(ledger.snapshot().tasks).toHaveLength(0)
    expect(notified).toBe(0)
    rmSync(env.path + '.tmp', { recursive: true, force: true })
    const applied = ledger.apply(envelope as never)
    // Then 重试真正落盘，revision 只前进一次，订阅者收到一次通知
    expect(applied.snapshot.tasks.map(task => task.id)).toEqual(['t-disk'])
    expect(applied.snapshot.revision).toBe(before.revision + 1)
    expect(JSON.parse(readFileSync(env.path, 'utf8')).tasks).toHaveLength(1)
    expect(notified).toBe(1)
    unsubscribe()
  })

  it('用户 手动运行超过全局在飞容量上限时被明确拒绝', () => {
    // Given 容量上限为 1，任务 A 已有一条在跑执行，任务 B 空闲
    const env = makeEnv('ledger-capacity.json')
    envs.push(env)
    const ledger = open(env, { maxInflightExecutions: 1 })
    ledger.apply(createEnvelope('a') as never)
    ledger.apply(createEnvelope('b') as never)
    ledger.openRun('a', 'manual')
    // When 对 B 发起手动 run
    const rejected = catchActionError(() => { ledger.apply({ requestId: 'run-b', action: { kind: 'run', taskId: 'b' } } as never) })
    // Then 明确拒绝且不新增执行；A 结算后 B 可以运行
    expect(rejected.code).toBe('TASKS_CAPACITY_EXCEEDED')
    expect(rejected.status).toBe(429)
    expect(ledger.snapshot().tasks.find(task => task.id === 'b')?.executions).toHaveLength(0)
    const openA = ledger.openExecutions()[0]
    ledger.settleRun('a', openA.executionId, 'succeeded', undefined)
    expect(ledger.openRun('b', 'manual').taskId).toBe('b')
  })

  it('用户 日历上永不触发的 cron 在 create 与 update 都被拒且排期不变', () => {
    // Given 一个按合法 cron 排期的任务，以及一个日历上永不匹配的表达式（2 月没有 31 日）
    const env = makeEnv('ledger-never.json')
    envs.push(env)
    const ledger = open(env)
    ledger.apply(createEnvelope('t-never', { schedule: { enabled: true, cron: '0 9 * * *' } }) as never)
    const arming = () => ledger.snapshot().tasks.find(task => task.id === 't-never')?.schedule
    const revisionBefore = ledger.snapshot().revision
    // When create 与 update 分别提交这个表达式
    const created = catchActionError(() => {
      ledger.apply(createEnvelope('t-never-new', { schedule: { enabled: true, cron: '0 0 31 2 *' } }) as never)
    })
    const updated = catchActionError(() => {
      ledger.apply({
        requestId: 'update-never',
        action: { kind: 'update', taskId: 't-never', patch: { schedule: { enabled: true, cron: '0 0 31 2 *' } } },
      } as never)
    })
    // Then 两条路径都落到 TASKS_CRON_INVALID，账本没有落下「已启用却没有下次运行」的规则
    expect(created.code).toBe('TASKS_CRON_INVALID')
    expect(created.status).toBe(400)
    expect(updated.code).toBe('TASKS_CRON_INVALID')
    expect(ledger.snapshot().tasks.some(task => task.id === 't-never-new')).toBe(false)
    expect(arming()?.enabled).toBe(true)
    expect(arming()?.cron).toBe('0 9 * * *')
    expect(arming()?.nextRunAt).toBe(nextRunAtMs('0 9 * * *', T0))
    expect(ledger.snapshot().revision).toBe(revisionBefore)
  })

  it('用户 跳过的触发点写入结构化原因并在重开后仍可读', () => {
    // Given 一个带定时规则的任务
    const env = makeEnv('ledger-skip.json')
    envs.push(env)
    const ledger = open(env)
    ledger.apply(createEnvelope('t-skip', { schedule: { enabled: true, cron: '0 9 * * *' } }) as never)
    const triggerPoint = T0 + 60_000
    // When 记录一次因容量被跳过的触发点
    ledger.recordScheduleSkip('t-skip', triggerPoint, 'capacity', T0)
    // Then 快照里是可读的结构化记录，重开账本后仍在
    const skip = ledger.snapshot().tasks.find(task => task.id === 't-skip')?.schedule?.lastSkip
    expect(skip).toEqual({ at: T0, triggerPoint, reason: 'capacity' })
    ledger.dispose()
    const reopened = open(env)
    expect(reopened.snapshot().tasks.find(task => task.id === 't-skip')?.schedule?.lastSkip).toEqual({ at: T0, triggerPoint, reason: 'capacity' })
  })

  it('用户 磁盘上非法的跳过原因被丢弃而不是带病读入', () => {
    // Given 账本文件里任务的 schedule.lastSkip.reason 是未知取值
    const env = makeEnv('ledger-skip-bad.json')
    envs.push(env)
    const ledger = open(env)
    ledger.apply(createEnvelope('t-bad', { schedule: { enabled: true, cron: '0 9 * * *' } }) as never)
    ledger.dispose()
    const document = JSON.parse(readFileSync(env.path, 'utf8')) as { tasks: Array<{ schedule: Record<string, unknown> }> }
    document.tasks[0].schedule.lastSkip = { at: 1, triggerPoint: 2, reason: 'bogus' }
    writeFileSync(env.path, JSON.stringify(document), 'utf8')
    // When 重开账本
    const reopened = open(env)
    // Then 非法原因缺省，任务其余字段完好
    const task = reopened.snapshot().tasks.find(item => item.id === 't-bad')
    expect(task?.schedule?.lastSkip).toBeUndefined()
    expect(task?.schedule?.cron).toBe('0 9 * * *')
  })
})
