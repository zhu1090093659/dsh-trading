/**
 * 心跳 + 看门狗测试（dead-man 第一层）：真文件、注入时钟、手工调度器；无 sleep、无 mock 框架。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { writeHeartbeat } from '../src/heartbeat.ts'
import { createWatchdog, type WatchdogOptions } from '../src/watchdog.ts'
import type { PumpScheduler } from '../src/pump.ts'

const T0 = 1_700_000_000_000
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fixture(overrides: Partial<WatchdogOptions> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'watchdog-'))
  dirs.push(dir)
  const heartbeatPath = join(dir, 'heartbeat.json')
  let tick = T0
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
  const stales: string[] = []
  const recoveries: number[] = []
  const watchdog = createWatchdog({
    heartbeatPath,
    timeoutMs: 10_000,
    scheduler,
    now: () => tick,
    intervalMs: 1_000,
    onStale: (reason) => stales.push(reason),
    onRecovered: (silentMs) => recoveries.push(silentMs),
    ...overrides,
  })
  return {
    heartbeatPath,
    watchdog,
    stales,
    recoveries,
    setNow: (value: number) => {
      tick = value
    },
    advance: (ms: number) => {
      tick += ms
    },
    fire: () => {
      for (const entry of pending.splice(0)) if (!entry.cancelled) entry.callback()
    },
  }
}

describe('心跳与看门狗（dead-man 第一层）', () => {
  it('管理员：心跳原子写后内容可读（看门狗不依赖 bot 存活）', () => {
    // Given 一个工作目录
    const f = fixture()
    // When 写心跳
    writeHeartbeat(f.heartbeatPath, { atMs: T0, note: 'desk tick' })
    // Then 看门狗读到的是新鲜心跳
    const result = f.watchdog.checkOnce()
    expect(result.stale).toBe(false)
    expect(result.silentMs).toBe(0)
  })

  it('管理员：心跳静默超过阈值 ⇒ 喊一次；持续静默不再重复喊', () => {
    // Given 心跳停在 60 秒前（阈值 10 秒）
    const f = fixture()
    writeHeartbeat(f.heartbeatPath, { atMs: T0 - 60_000 })
    // When 连续检查三次
    f.watchdog.checkOnce()
    f.watchdog.checkOnce()
    f.watchdog.checkOnce()
    // Then 只喊一次（反复喊会把通知与审计淹掉）
    expect(f.stales).toHaveLength(1)
    expect(f.stales[0]).toContain('超过阈值')
    expect(f.watchdog.stats().staleEpisodes).toBe(1)
  })

  it('管理员：心跳文件缺失或损坏 ⇒ 按失活处理（fail-closed，漏报代价不对称）', () => {
    // Given 文件不存在
    const f = fixture()
    // When 检查
    const missing = f.watchdog.checkOnce()
    // Then 判失活且说明原因
    expect(missing.stale).toBe(true)
    expect(missing.reason).toBe('no-heartbeat')
    expect(f.stales[0]).toContain('fail-closed')
    // Given 文件损坏
    writeFileSync(f.heartbeatPath, '{ not json')
    // When 新一轮检查（先恢复再损坏，以走出同一 episode）
    writeHeartbeat(f.heartbeatPath, { atMs: T0 })
    f.watchdog.checkOnce()
    writeFileSync(f.heartbeatPath, '{ not json')
    const broken = f.watchdog.checkOnce()
    // Then 同样判失活
    expect(broken.stale).toBe(true)
    expect(broken.reason).toBe('no-heartbeat')
  })

  it('管理员：心跳恢复后回调一次并允许下一次失活再次喊', () => {
    // Given 先失活再恢复
    const f = fixture()
    writeHeartbeat(f.heartbeatPath, { atMs: T0 - 60_000 })
    f.watchdog.checkOnce()
    f.advance(1_000)
    writeHeartbeat(f.heartbeatPath, { atMs: T0 })
    // When 检查到恢复
    f.watchdog.checkOnce()
    // Then 恢复有留痕（否则事后只看到停过、看不到回来）
    expect(f.recoveries).toHaveLength(1)
    // When 再次失活
    f.advance(60_000)
    f.watchdog.checkOnce()
    // Then 是新的 episode（又喊一次）
    expect(f.stales).toHaveLength(2)
    expect(f.watchdog.stats().staleEpisodes).toBe(2)
  })

  it('管理员：start 后由调度器驱动、stop 后不再检查，重复 start 不叠加', () => {
    // Given 启动两次
    const f = fixture()
    writeHeartbeat(f.heartbeatPath, { atMs: T0 })
    f.watchdog.start()
    f.watchdog.start()
    // When 调度器到点一次
    f.fire()
    // Then 只检查一次
    expect(f.watchdog.stats().checks).toBe(1)
    // When 停掉
    f.watchdog.stop()
    f.fire()
    // Then 不再检查
    expect(f.watchdog.stats().checks).toBe(1)
    expect(f.watchdog.stats().running).toBe(false)
  })
})
