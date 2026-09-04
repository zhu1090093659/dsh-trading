/**
 * cron 纯模块单测：解析合法性、字段语义（步进/区间/列表/日周 OR）与
 * nextRunAtMs 的关键时间语义（严格晚于、分钟粒度、闰日可达、不可能日期）。
 */
import { describe, expect, it } from 'vitest'
import { isValidCron, nextRunAtMs, parseCron } from '../src/client/tasks-schedule.ts'

const AT = (...args: Parameters<typeof Date>) => new Date(...args).getTime()

describe('parseCron', () => {
  it('解析合法表达式并归一化周日 7 → 0', () => {
    const schedule = parseCron('0 9 * * 7')
    expect(schedule).not.toBeNull()
    expect(schedule?.weekdays.has(0)).toBe(true)
    expect(schedule?.weekdays.has(7)).toBe(false)
  })

  it('拒绝非法表达式：字段数/范围/步进/垃圾字符', () => {
    expect(isValidCron('* * * *')).toBe(false)
    expect(isValidCron('61 * * * *')).toBe(false)
    expect(isValidCron('0-100 * * * *')).toBe(false)
    expect(isValidCron('*/0 * * * *')).toBe(false)
    expect(isValidCron('a * * * *')).toBe(false)
    expect(isValidCron('1,,2 * * * *')).toBe(false)
  })

  it('步进与区间列表', () => {
    const schedule = parseCron('0,15,30-45/5 8-18/2 * * 1-5')
    expect(schedule).not.toBeNull()
    expect(schedule?.minutes.has(30)).toBe(true)
    expect(schedule?.minutes.has(45)).toBe(true)
    expect(schedule?.minutes.has(50)).toBe(false)
    expect(schedule?.hours.has(8)).toBe(true)
    expect(schedule?.hours.has(9)).toBe(false)
    expect(schedule?.hours.has(10)).toBe(true)
  })

  it('显式全枚举不塌缩成通配（参与日/周 OR 语义）', () => {
    const schedule = parseCron('0 0 1-31 * 1')
    expect(schedule?.dayWildcard).toBe(false)
    expect(schedule?.weekdayWildcard).toBe(false)
  })
})

describe('nextRunAtMs', () => {
  it('严格晚于起点：起点恰在匹配分钟上 → 下一分钟起算', () => {
    const from = AT(2026, 0, 1, 9, 0, 0)
    expect(nextRunAtMs('0 9 * * *', from)).toBe(AT(2026, 0, 2, 9, 0, 0))
  })

  it('分钟粒度：起点秒数被忽略，对齐到下一个匹配分钟的起始', () => {
    const from = AT(2026, 0, 1, 9, 0, 30)
    expect(nextRunAtMs('*/10 * * * *', from)).toBe(AT(2026, 0, 1, 9, 10, 0))
  })

  it('日/周 OR 语义：13 号星期五（13 或 周五 任一命中）', () => {
    // 2026-01-02 是周五：起点 2026-01-01 周四 → 下一个命中是 01-02（周五，非 13 号）。
    const from = AT(2026, 0, 1, 12, 0, 0)
    expect(nextRunAtMs('0 0 13 * 5', from)).toBe(AT(2026, 0, 2, 0, 0, 0))
  })

  it('闰日 2 月 29 日在五年视野内可达', () => {
    const from = AT(2025, 2, 1, 0, 0, 0)
    expect(nextRunAtMs('0 0 29 2 *', from)).toBe(AT(2028, 1, 29, 0, 0, 0))
  })

  it('日历上不可能的组合返回 undefined', () => {
    const from = AT(2026, 0, 1, 0, 0, 0)
    expect(nextRunAtMs('0 0 31 2 *', from)).toBeUndefined()
  })

  it('非法表达式返回 undefined', () => {
    expect(nextRunAtMs('nonsense', AT(2026, 0, 1))).toBeUndefined()
  })
})
