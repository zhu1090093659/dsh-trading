/**
 * 检测器测试：写探针用真临时目录（含只读目录），错误计数为纯逻辑；无 sleep、无 mock 框架。
 */
import { chmodSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createVenueErrorStreak, probeWritable } from '../src/detectors.ts'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      chmodSync(dir, 0o700)
    } catch {
      /* 可能已删 */
    }
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('写探针', () => {
  it('管理员：可写目录报可写，且探针文件被清掉（不留垃圾）', () => {
    // Given 一个临时目录
    const dir = mkdtempSync(join(tmpdir(), 'probe-'))
    dirs.push(dir)
    // When 探测
    const result = probeWritable(dir)
    // Then 可写、无错误码，且目录里没有残留探针
    expect(result.writable).toBe(true)
    expect(result.code).toBeUndefined()
    expect(() => rmSync(join(dir, '.dsh-write-probe'), { force: false })).toThrow()
  })

  it('管理员：目录不存在时会尝试创建（首次启动的常见形态）', () => {
    // Given 一个还不存在的深层路径
    const dir = mkdtempSync(join(tmpdir(), 'probe-deep-'))
    dirs.push(dir)
    const deep = join(dir, 'a', 'b', 'c')
    // When 探测
    const result = probeWritable(deep)
    // Then 创建成功即可写
    expect(result.writable).toBe(true)
  })

  it('管理员：只读目录报不可写并给出权限类原因（不是笼统的"失败"）', () => {
    // Given 一个去掉写权限的目录
    const dir = mkdtempSync(join(tmpdir(), 'probe-ro-'))
    dirs.push(dir)
    chmodSync(dir, 0o500)
    // When 探测
    const result = probeWritable(dir)
    // Then 不可写、带 errno 码、原因可读
    expect(result.writable).toBe(false)
    expect(['EACCES', 'EPERM']).toContain(result.code)
    expect(result.reason).toContain('拒绝新增风险')
  })
})

describe('交易所错误连续计数', () => {
  it('管理员：连续错误累加，任何一次成功即清零（偶发错误不该拉低档位）', () => {
    // Given 阈值 3
    const streak = createVenueErrorStreak({ threshold: 3 })
    // When 两次错误后一次成功、再两次错误
    streak.recordError('timeout')
    streak.recordError('timeout')
    streak.recordOk()
    streak.recordError('rate-limit')
    const after = streak.recordError('rate-limit')
    // Then 连续数归零后重新从 1 计
    expect(after).toBe(2)
    expect(streak.streak()).toBe(2)
    expect(streak.thresholdReached()).toBe(false)
    expect(streak.lastKind()).toBe('rate-limit')
  })

  it('管理员：达到阈值即视为交易所不正常；成功后立即恢复', () => {
    // Given 阈值 3
    const streak = createVenueErrorStreak({ threshold: 3 })
    // When 连错三次
    streak.recordError('5xx')
    streak.recordError('5xx')
    streak.recordError('5xx')
    // Then 达标
    expect(streak.thresholdReached()).toBe(true)
    // When 一次成功
    streak.recordOk()
    // Then 立刻恢复（不等时间窗）
    expect(streak.thresholdReached()).toBe(false)
    expect(streak.lastKind()).toBeUndefined()
  })

  it('管理员：阈值 <= 0 视为禁用（不因错误数触发）', () => {
    // Given 阈值 0
    const streak = createVenueErrorStreak({ threshold: 0 })
    // When 连错 100 次
    for (let index = 0; index < 100; index += 1) streak.recordError('x')
    // Then 永不达标
    expect(streak.thresholdReached()).toBe(false)
  })
})
