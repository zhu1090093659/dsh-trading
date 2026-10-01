/**
 * 事件泵测试（P3 步骤 3 的进程内驱动）：真 node:sqlite + 可手工推进的调度器 ⇒ 无 sleep、无 mock 框架。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openLedgers } from '../src/db.ts'
import { addSchedule, migrateTriggers, type Occurrence } from '../src/triggers.ts'
import { createTriggerPump, type PumpScheduler } from '../src/pump.ts'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** 可手工推进的调度器：把"等 N 毫秒"变成"取出回调来跑"。 */
function manualScheduler() {
  const pending: { callback: () => void; cancelled: boolean }[] = []
  const scheduler: PumpScheduler = {
    schedule(callback) {
      const entry = { callback, cancelled: false }
      pending.push(entry)
      return () => {
        entry.cancelled = true
      }
    },
  }
  return {
    scheduler,
    /** 跑一轮已排的回调（模拟时间到点）。 */
    async fire(): Promise<void> {
      for (const entry of pending.splice(0)) {
        if (!entry.cancelled) entry.callback()
      }
      // 让 finally 里的重排落地
      await new Promise((resolve) => setImmediate(resolve))
      await new Promise((resolve) => setImmediate(resolve))
    },
  }
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'pump-'))
  dirs.push(dir)
  const ledgers = openLedgers(dir)
  // 触发器表挂在 **orders** 库（本仓约定；audit 是审计流）
  migrateTriggers(ledgers.orders)
  // 时间固定：夹具要让调度"刚刚过去一点"，而不是落后几亿个间隔 ——
  // 落后太多时 dueOccurrences 每轮会吐满 guard(1000) 条 missed，每条一次 INSERT+UPDATE，
  // 在 WAL+FULL 同步下会跑成几分钟（第一版夹具就是这么写的，实测单例 363 秒）。
  let nowMs = 1_700_000_000_000
  const calls: { sessionId: string; occurrences: readonly Occurrence[] }[] = []
  let shouldThrow = false
  const clock = manualScheduler()
  const pump = createTriggerPump({
    db: ledgers.orders,
    dispatch: async (sessionId, occurrences) => {
      calls.push({ sessionId, occurrences })
      if (shouldThrow) throw new Error('followup 不可用（模拟）')
    },
    deskSessionId: 'desk-session-1',
    scheduler: clock.scheduler,
    now: () => nowMs,
    intervalMs: 1_000,
  })
  return {
    ledgers,
    calls,
    pump,
    clock,
    /** 推进注入时钟（测试不许 sleep，时间由测试掌控）。 */
    advanceNow: (ms: number) => {
      nowMs += ms
    },
    setThrow: (value: boolean) => {
      shouldThrow = value
    },
  }
}

function scheduleAt(ledgers: ReturnType<typeof fixture>['ledgers'], nextAtMs: number) {
  // 默认：到点时间比 now 早 1 秒（真实场景：机器刚醒、只错过一个间隔）
  addSchedule(ledgers.orders, { id: 'w-1', intervalMs: 5_000, atMs: null, nextAtMs: nextAtMs === 0 ? 1_699_999_999_000 : nextAtMs, enabled: true, kind: 'wake' })
}

describe('事件泵', () => {
  it('管理员：到点的调度被扇出一次并完成记账与排期', async () => {
    // Given 一个到点时间已过的调度（时间基准约 1.7e12，故用 0 表示早已到点）
    const f = fixture()
    scheduleAt(f.ledgers, 0)
    // When 手动推进一轮
    const handled = await f.pump.pumpOnce()
    // Then 扇出一条、会话 id 正确、返回条数一致
    expect(handled).toBe(1)
    expect(f.calls).toHaveLength(1)
    expect(f.calls[0]?.sessionId).toBe('desk-session-1')
    expect(f.calls[0]?.occurrences[0]?.scheduleId).toBe('w-1')
    // 且第二轮不再重复触发同一次（已排下一次）
    expect(await f.pump.pumpOnce()).toBe(0)
  })

  it('管理员：扇出失败时标记 failed 且泵不停摆（单次故障不许让触发器静默停摆）', async () => {
    // Given 一个会抛错的扇出
    const f = fixture()
    scheduleAt(f.ledgers, 0)
    f.setThrow(true)
    // When 推一轮
    await f.pump.pumpOnce()
    // Then 记失败、不抛出去
    expect(f.pump.stats().failed).toBe(1)
    expect(f.pump.stats().dispatched).toBe(0)
    // 并且恢复后仍能继续工作：失败那一次已留痕，排期推进到下一个间隔（不重试同一条，也不停摆）
    f.setThrow(false)
    f.advanceNow(5_000) // 让下一个间隔真的到点
    expect(await f.pump.pumpOnce()).toBeGreaterThan(0)
    expect(f.pump.stats().dispatched).toBeGreaterThan(0)
  })

  it('管理员：没有到点的调度时不调用扇出，ticks 仍计数', async () => {
    // Given 一个未来才到点的调度
    const f = fixture()
    scheduleAt(f.ledgers, 9_999_999_999_999)
    // When 推一轮
    const handled = await f.pump.pumpOnce()
    // Then 不扇出，但心跳有记录（ticks/lastTickAtMs）
    expect(handled).toBe(0)
    expect(f.calls).toHaveLength(0)
    expect(f.pump.stats().ticks).toBe(1)
    expect(f.pump.stats().lastTickAtMs).not.toBeNull()
  })

  it('管理员：start 后由调度器驱动、stop 之后不再自动推进', async () => {
    // Given 一个已启动的泵
    const f = fixture()
    scheduleAt(f.ledgers, 0)
    f.pump.start()
    expect(f.pump.stats().running).toBe(true)
    // When 调度器到点
    await f.clock.fire()
    // Then 自动推了一轮
    expect(f.pump.stats().ticks).toBeGreaterThan(0)
    // When 停掉之后再让调度器到点
    f.pump.stop()
    const ticksAfterStop = f.pump.stats().ticks
    await f.clock.fire()
    // Then 不再推进
    expect(f.pump.stats().running).toBe(false)
    expect(f.pump.stats().ticks).toBe(ticksAfterStop)
  })

  it('管理员：重复 start 不会叠加两条调度链（否则间隔会越跑越密）', async () => {
    // Given 连续 start 两次
    const f = fixture()
    scheduleAt(f.ledgers, 0)
    f.pump.start()
    f.pump.start()
    // When 调度器到点一次
    await f.clock.fire()
    // Then 只推一轮（ticks 增 1），不是两轮
    expect(f.pump.stats().ticks).toBe(1)
  })
})
